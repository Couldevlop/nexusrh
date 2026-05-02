import type { FastifyPluginAsync } from 'fastify'
import { eq, asc } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { jobOffers, candidates } from '../../db/schema/recruitment'
import { legalEntities } from '../../db/schema/employees'
import { config } from '../../config'

// ── Modèles ──────────────────────────────────────────────────────────────────
const CLAUDE_MODEL  = process.env['AI_MODEL']      ?? 'claude-sonnet-4-20250514'
const MISTRAL_MODEL = process.env['MISTRAL_MODEL'] ?? 'mistral-large-latest'

// ── Adaptateurs AI (interface commune) ───────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'] ?? config.anthropic?.apiKey ?? '',
})

interface AIResponse {
  provider: 'claude' | 'mistral'
  model: string
  text: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  estimatedCostEur: number
}

/**
 * Appel Claude via @anthropic-ai/sdk
 */
async function callClaude(prompt: string, maxTokens = 2000): Promise<AIResponse> {
  const t0 = Date.now()
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  const latencyMs = Date.now() - t0
  const inputTokens  = msg.usage.input_tokens
  const outputTokens = msg.usage.output_tokens
  // Tarifs Claude Sonnet 4 : $3 / 1M input, $15 / 1M output → converti en EUR ≈ ×0.92
  const estimatedCostEur = ((inputTokens * 3 + outputTokens * 15) / 1_000_000) * 0.92
  const text = (msg.content[0] as { type: string; text: string }).text

  return { provider: 'claude', model: CLAUDE_MODEL, text, inputTokens, outputTokens, latencyMs, estimatedCostEur }
}

/**
 * Appel Mistral via REST (pas de SDK nécessaire)
 * Compatible mistral-large-latest, mistral-small-latest, open-mixtral-8x7b, etc.
 */
async function callMistral(prompt: string, maxTokens = 2000): Promise<AIResponse> {
  const apiKey = process.env['MISTRAL_API_KEY'] ?? ''
  if (!apiKey) {
    return {
      provider: 'mistral', model: MISTRAL_MODEL,
      text: '', inputTokens: 0, outputTokens: 0, latencyMs: 0,
      estimatedCostEur: 0,
    }
  }

  const t0 = Date.now()
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const latencyMs = Date.now() - t0

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Mistral API error ${res.status}: ${err}`)
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
    usage: { prompt_tokens: number; completion_tokens: number }
  }

  const text = data.choices[0]?.message.content ?? ''
  const inputTokens  = data.usage.prompt_tokens
  const outputTokens = data.usage.completion_tokens
  // Tarifs Mistral Large : $2 / 1M input, $6 / 1M output → converti EUR
  const estimatedCostEur = ((inputTokens * 2 + outputTokens * 6) / 1_000_000) * 0.92

  return { provider: 'mistral', model: MISTRAL_MODEL, text, inputTokens, outputTokens, latencyMs, estimatedCostEur }
}

/**
 * Parse le JSON depuis une réponse IA (extrait le premier bloc {...})
 */
function parseAIJson(text: string): Record<string, unknown> {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0]) as Record<string, unknown>
  } catch { /* fall through */ }
  return {}
}

/**
 * Score de richesse d'une réponse sourcing (pour la comparaison)
 */
function computeRichnessScore(result: Record<string, unknown>): number {
  let score = 0
  const profiles = Array.isArray(result['profiles']) ? result['profiles'] : []
  const strategy = result['strategy'] as Record<string, unknown> | undefined

  if (profiles.length > 0) score += 20
  if (profiles.length >= 5) score += 10
  score += Math.min(profiles.length, 10) * 2  // +2 par profil jusqu'à 10

  if (strategy) {
    if (strategy['booleanSearch']) score += 10
    if (Array.isArray(strategy['searchKeywords']) && (strategy['searchKeywords'] as unknown[]).length >= 3) score += 10
    if (strategy['salaryBenchmark']) score += 10
    if (Array.isArray(strategy['bestPlatforms']) && (strategy['bestPlatforms'] as unknown[]).length >= 2) score += 10
    if (Array.isArray(strategy['tips']) && (strategy['tips'] as unknown[]).length >= 2) score += 5
  }

  const firstProfile = profiles[0] as Record<string, unknown> | undefined
  if (firstProfile) {
    if (firstProfile['linkedinSearch']) score += 5
    if (firstProfile['approachStrategy']) score += 5
    if (Array.isArray(firstProfile['keySkills'])) score += 5
  }

  return Math.min(score, 100)
}

/**
 * Construit le prompt de sourcing (partagé Claude + Mistral pour comparaison équitable)
 */
function buildSourcingPrompt(
  offer: { title: string; description?: string | null; requirements?: string | null; contractType?: string | null; location?: string | null },
  platforms: string[],
  maxProfiles: number,
): string {
  return `Tu es un expert en recrutement et sourcing RH en France.

Génère une stratégie de sourcing complète et ${maxProfiles} profils candidats synthétiques réalistes pour ce poste.
Les profils doivent être crédibles, avec de vrais noms français/européens, des parcours cohérents.

Poste : ${offer.title}
Description : ${offer.description ?? 'Non fournie'}
Exigences : ${offer.requirements ?? 'Non fournies'}
Type de contrat : ${offer.contractType ?? 'CDI'}
Localisation : ${offer.location ?? 'France'}
Plateformes cibles : ${platforms.join(', ')}

Réponds UNIQUEMENT en JSON valide avec cette structure :
{
  "strategy": {
    "summary": "<stratégie en 2-3 phrases>",
    "bestPlatforms": [{"name": "<plateforme>", "rationale": "<pourquoi>", "estimatedPool": <nombre>, "url": "<url>"}],
    "searchKeywords": ["<mot-clé 1>", "<mot-clé 2>", "<mot-clé 3>"],
    "booleanSearch": "<requête booléenne LinkedIn>",
    "estimatedTimeToFill": "<délai estimé>",
    "salaryBenchmark": {"min": <number>, "max": <number>, "median": <number>},
    "tips": ["<conseil 1>", "<conseil 2>"]
  },
  "profiles": [
    {
      "firstName": "<prénom>",
      "lastName": "<nom>",
      "currentPosition": "<poste actuel>",
      "currentCompany": "<entreprise>",
      "location": "<ville>",
      "experienceYears": <number>,
      "keySkills": ["<compétence 1>", "<compétence 2>"],
      "matchScore": <0-100>,
      "availabilityEstimate": "immediate|1month|3months|passive",
      "suggestedPlatform": "<plateforme>",
      "linkedinSearch": "<requête LinkedIn>",
      "approachStrategy": "<comment approcher>",
      "estimatedSalary": <number>
    }
  ]
}`
}

/**
 * Génère une recommandation textuelle basée sur les métriques comparatives
 */
function buildRecommendation(
  claudeRichness: number,
  mistralRichness: number,
  claudeResult: AIResponse | null,
  mistralResult: AIResponse | null,
): string {
  if (!claudeResult && !mistralResult) return 'Aucun résultat disponible.'
  if (!mistralResult) return 'Mistral non configuré — utilisez Claude.'
  if (!claudeResult) return 'Claude non configuré — utilisez Mistral.'

  const costRatio = claudeResult.estimatedCostEur / (mistralResult.estimatedCostEur || 0.0001)
  const richnessGap = Math.abs(claudeRichness - mistralRichness)

  if (claudeRichness > mistralRichness + 15) {
    return `Claude recommandé — richesse significativement supérieure (+${richnessGap} pts). Le surcoût (×${costRatio.toFixed(1)}) est justifié pour du sourcing de qualité.`
  }
  if (mistralRichness > claudeRichness + 15) {
    return `Mistral recommandé — qualité supérieure à moindre coût. Excellent rapport qualité/prix pour ce cas d'usage.`
  }
  if (costRatio > 2 && richnessGap < 10) {
    return `Mistral recommandé — qualité comparable à ${costRatio.toFixed(1)}× moins cher. Idéal pour un usage intensif (volume de sourcing élevé).`
  }
  if (mistralResult.latencyMs < claudeResult.latencyMs * 0.7) {
    return `Mistral recommandé pour la réactivité — ${Math.round((claudeResult.latencyMs - mistralResult.latencyMs) / 1000)}s plus rapide avec une qualité équivalente.`
  }
  return `Qualité équivalente. Choisissez Claude pour la précision contextuelle française (droit du travail, CCN) ou Mistral pour le volume et le coût.`
}

const recruitmentRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /recruitment/offers
  fastify.get('/offers', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['recruitment'], summary: 'Liste des offres d\'emploi' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const offers = await db.select().from(jobOffers).orderBy(asc(jobOffers.createdAt))
      const mapped = offers.map((o) => ({
        id: o.id,
        title: o.title,
        department: o.departmentId ?? '',
        location: o.location ?? '',
        contractType: o.contractType ?? '',
        status: o.status,
        applicantCount: 0,
        publishedAt: o.publishedAt,
      }))
      return reply.send({ data: mapped })
    },
  })

  // GET /recruitment/candidates
  fastify.get('/candidates', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['recruitment'], summary: 'Tous les candidats' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const list = await db.select().from(candidates).orderBy(asc(candidates.createdAt))
      return reply.send({ data: list })
    },
  })

  // POST /recruitment/offers
  fastify.post('/offers', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'admin', 'super_admin')],
    schema: { tags: ['recruitment'], summary: 'Créer une offre d\'emploi' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        title: string
        department?: string
        location?: string
        contractType?: string
        description?: string
        status?: string
      }

      // Resolve entityId (NOT NULL in schema)
      const [entity] = await db.select({ id: legalEntities.id }).from(legalEntities).limit(1)
      if (!entity) {
        return reply.status(422).send({ error: 'Aucune entité juridique configurée pour ce tenant' })
      }

      const [offer] = await db
        .insert(jobOffers)
        .values({
          entityId: entity.id,
          title: body.title,
          description: body.description || body.title, // description is NOT NULL
          location: body.location ?? '',
          contractType: body.contractType ?? 'CDI',
          status: (body.status as 'draft' | 'published' | 'closed') ?? 'draft',
          createdBy: request.user.sub,
        } as never)
        .returning()
      return reply.status(201).send({ data: offer })
    },
  })

  // GET /recruitment/job-offers/:id/candidates — kept for compatibility
  fastify.get('/job-offers/:id/candidates', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['recruitment'], summary: 'Candidats pour une offre' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const list = await db.select().from(candidates)
        .where(eq(candidates.jobOfferId, id))
        .orderBy(asc(candidates.createdAt))
      return reply.send({ data: list })
    },
  })

  // GET /recruitment/offers/:id/candidates
  fastify.get('/offers/:id/candidates', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['recruitment'], summary: 'Candidats pour une offre' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const list = await db.select().from(candidates)
        .where(eq(candidates.jobOfferId, id))
        .orderBy(asc(candidates.createdAt))
      return reply.send({ data: list })
    },
  })

  // PATCH /recruitment/offers/:id — edit or publish an offer
  fastify.patch('/offers/:id', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'admin', 'super_admin')],
    schema: { tags: ['recruitment'], summary: 'Modifier une offre d\'emploi' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as {
        title?: string
        description?: string
        location?: string
        contractType?: string
        status?: string
      }
      const set: Record<string, unknown> = { updatedAt: new Date() }
      if (body.title !== undefined) set['title'] = body.title
      if (body.description !== undefined) set['description'] = body.description
      if (body.location !== undefined) set['location'] = body.location
      if (body.contractType !== undefined) set['contractType'] = body.contractType
      if (body.status !== undefined) {
        set['status'] = body.status
        if (body.status === 'published') set['publishedAt'] = new Date()
      }
      const [updated] = await db
        .update(jobOffers)
        .set(set as never)
        .where(eq(jobOffers.id, id))
        .returning()
      return reply.send({ data: updated })
    },
  })

  // POST /recruitment/candidates
  fastify.post('/candidates', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['recruitment'], summary: 'Ajouter un candidat' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const [candidate] = await db
        .insert(candidates)
        .values(request.body as never)
        .returning()
      return reply.status(201).send({ data: candidate })
    },
  })

  // PATCH /recruitment/candidates/:id/stage
  fastify.patch('/candidates/:id/stage', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['recruitment'], summary: 'Mettre à jour le stade d\'un candidat' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { stage } = request.body as { stage: string }
      const [updated] = await db
        .update(candidates)
        .set({ stage, updatedAt: new Date() })
        .where(eq(candidates.id, id))
        .returning()
      return reply.send({ data: updated })
    },
  })

  // ── POST /recruitment/candidates/:id/analyze-cv ──────────────────────────────
  // provider: 'claude' (défaut) | 'mistral'
  fastify.post('/candidates/:id/analyze-cv', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['recruitment'], summary: 'Analyser un CV par IA — Claude ou Mistral' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as { cvText?: string; jobOfferId?: string; provider?: 'claude' | 'mistral' }
      const provider = body.provider ?? 'claude'
      const db = getTenantDbForRequest(request)

      const [candidate] = await db.select().from(candidates).where(eq(candidates.id, id)).limit(1)
      if (!candidate) return reply.status(404).send({ error: 'Candidat introuvable' })

      let offerContext = ''
      if (body.jobOfferId ?? candidate.jobOfferId) {
        const [offer] = await db.select().from(jobOffers)
          .where(eq(jobOffers.id, (body.jobOfferId ?? candidate.jobOfferId)!)).limit(1)
        if (offer) {
          offerContext = `\n\nPoste recherché : ${offer.title}\nDescription : ${offer.description ?? ''}\nExigences : ${offer.requirements ?? ''}`
        }
      }

      const cvText = body.cvText ?? `Candidat : ${candidate.firstName} ${candidate.lastName}
Email : ${candidate.email}
Poste actuel : ${candidate.currentPosition ?? 'non renseigné'}
Entreprise actuelle : ${candidate.currentCompany ?? 'non renseigné'}
Source : ${candidate.source ?? 'non renseignée'}`

      const prompt = `Tu es un expert recruteur RH France. Analyse ce CV et fournis une évaluation structurée en JSON.${offerContext}

CV à analyser :
${cvText}

Réponds uniquement en JSON avec cette structure exacte :
{
  "score": <number 0-100>,
  "recommendation": "strong_yes" | "yes" | "maybe" | "no",
  "summary": "<résumé en 2 phrases>",
  "strengths": ["<point fort 1>", "<point fort 2>", "<point fort 3>"],
  "gaps": ["<manque 1>", "<manque 2>"],
  "suggestedSalaryRange": { "min": <number>, "max": <number>, "currency": "EUR" },
  "interviewQuestions": ["<question 1>", "<question 2>", "<question 3>"],
  "redFlags": ["<red flag si applicable>"],
  "matchPercentage": <number 0-100>
}`

      const aiResp = provider === 'mistral'
        ? await callMistral(prompt, 1500)
        : await callClaude(prompt, 1500)

      const analysis = parseAIJson(aiResp.text)

      await db.update(candidates)
        .set({
          aiSummary: JSON.stringify(analysis),
          score: typeof analysis['score'] === 'number' ? analysis['score'] : null,
          updatedAt: new Date(),
        })
        .where(eq(candidates.id, id))

      return reply.send({
        data: analysis,
        meta: {
          provider: aiResp.provider,
          model: aiResp.model,
          latencyMs: aiResp.latencyMs,
          inputTokens: aiResp.inputTokens,
          outputTokens: aiResp.outputTokens,
          estimatedCostEur: aiResp.estimatedCostEur,
        },
      })
    },
  })

  // ── POST /recruitment/offers/:id/source ───────────────────────────────────────
  // provider: 'claude' (défaut) | 'mistral'
  fastify.post('/offers/:id/source', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: { tags: ['recruitment'], summary: 'Sourcing IA — Claude ou Mistral' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as {
        platforms?: string[]
        maxProfiles?: number
        provider?: 'claude' | 'mistral'
      }
      const provider = body.provider ?? 'claude'
      const db = getTenantDbForRequest(request)

      const [offer] = await db.select().from(jobOffers).where(eq(jobOffers.id, id)).limit(1)
      if (!offer) return reply.status(404).send({ error: 'Offre introuvable' })

      const platforms = body.platforms ?? ['LinkedIn', 'Welcome to the Jungle', 'Indeed', 'Apec', 'Cadremploi']
      const maxProfiles = Math.min(body.maxProfiles ?? 10, 20)

      const prompt = buildSourcingPrompt(offer, platforms, maxProfiles)

      const aiResp = provider === 'mistral'
        ? await callMistral(prompt, 4000)
        : await callClaude(prompt, 4000)

      const result = parseAIJson(aiResp.text)

      return reply.send({
        data: result,
        meta: {
          provider: aiResp.provider,
          model: aiResp.model,
          latencyMs: aiResp.latencyMs,
          inputTokens: aiResp.inputTokens,
          outputTokens: aiResp.outputTokens,
          estimatedCostEur: aiResp.estimatedCostEur,
        },
        offerId: id,
      })
    },
  })

  // ── POST /recruitment/offers/:id/source/compare — Comparaison Claude vs Mistral
  // Lance les deux IA EN PARALLÈLE et retourne un rapport côte à côte avec métriques
  fastify.post('/offers/:id/source/compare', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    schema: {
      tags: ['recruitment'],
      summary: 'Comparaison Claude vs Mistral pour le sourcing — appels parallèles + métriques',
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as { platforms?: string[]; maxProfiles?: number }
      const db = getTenantDbForRequest(request)

      const [offer] = await db.select().from(jobOffers).where(eq(jobOffers.id, id)).limit(1)
      if (!offer) return reply.status(404).send({ error: 'Offre introuvable' })

      if (!process.env['MISTRAL_API_KEY']) {
        return reply.status(422).send({
          error: 'MISTRAL_API_KEY non configurée',
          hint: 'Ajoutez MISTRAL_API_KEY=... dans votre .env pour activer la comparaison',
        })
      }

      const platforms = body.platforms ?? ['LinkedIn', 'Welcome to the Jungle', 'Indeed', 'Apec', 'Cadremploi']
      const maxProfiles = Math.min(body.maxProfiles ?? 5, 10) // limité à 5 pour le compare (2× les tokens)

      const prompt = buildSourcingPrompt(offer, platforms, maxProfiles)

      // ── Appels parallèles ──────────────────────────────────────────────────
      const [claudeResp, mistralResp] = await Promise.allSettled([
        callClaude(prompt, 4000),
        callMistral(prompt, 4000),
      ])

      const claudeResult = claudeResp.status === 'fulfilled' ? claudeResp.value : null
      const mistralResult = mistralResp.status === 'fulfilled' ? mistralResp.value : null

      const claudeData = claudeResult ? parseAIJson(claudeResult.text) : null
      const mistralData = mistralResult ? parseAIJson(mistralResult.text) : null

      // ── Métriques comparatives ─────────────────────────────────────────────
      const claudeRichness = claudeData ? computeRichnessScore(claudeData) : 0
      const mistralRichness = mistralData ? computeRichnessScore(mistralData) : 0

      const claudeProfiles = Array.isArray(claudeData?.['profiles']) ? (claudeData!['profiles'] as unknown[]).length : 0
      const mistralProfiles = Array.isArray(mistralData?.['profiles']) ? (mistralData!['profiles'] as unknown[]).length : 0

      const claudeJsonValid = claudeData !== null && Object.keys(claudeData).length > 0
      const mistralJsonValid = mistralData !== null && Object.keys(mistralData).length > 0

      // Coût total pour X profils (normalisé à 10 profils pour comparaison équitable)
      const normalizeToTen = (cost: number, profiles: number) =>
        profiles > 0 ? (cost / profiles) * 10 : cost

      const comparison = {
        winner: claudeRichness >= mistralRichness ? 'claude' : 'mistral',
        summary: {
          claude: {
            latencyMs: claudeResult?.latencyMs ?? null,
            inputTokens: claudeResult?.inputTokens ?? null,
            outputTokens: claudeResult?.outputTokens ?? null,
            estimatedCostEur: claudeResult?.estimatedCostEur ?? null,
            costPer10ProfilesEur: claudeResult ? normalizeToTen(claudeResult.estimatedCostEur, claudeProfiles) : null,
            profilesGenerated: claudeProfiles,
            jsonValid: claudeJsonValid,
            richnessScore: claudeRichness,
            error: claudeResp.status === 'rejected' ? String(claudeResp.reason) : null,
          },
          mistral: {
            latencyMs: mistralResult?.latencyMs ?? null,
            inputTokens: mistralResult?.inputTokens ?? null,
            outputTokens: mistralResult?.outputTokens ?? null,
            estimatedCostEur: mistralResult?.estimatedCostEur ?? null,
            costPer10ProfilesEur: mistralResult ? normalizeToTen(mistralResult.estimatedCostEur, mistralProfiles) : null,
            profilesGenerated: mistralProfiles,
            jsonValid: mistralJsonValid,
            richnessScore: mistralRichness,
            error: mistralResp.status === 'rejected' ? String(mistralResp.reason) : null,
          },
        },
        // Ratios normalisés (Claude comme baseline = 1.0)
        ratios: claudeResult && mistralResult ? {
          latency: `Mistral ${mistralResult.latencyMs < claudeResult.latencyMs ? 'plus rapide' : 'plus lent'} de ${Math.abs(mistralResult.latencyMs - claudeResult.latencyMs)}ms`,
          cost: `Mistral ${mistralResult.estimatedCostEur < claudeResult.estimatedCostEur ? 'moins cher' : 'plus cher'} (×${(mistralResult.estimatedCostEur / (claudeResult.estimatedCostEur || 0.0001)).toFixed(2)})`,
          richness: `${claudeRichness >= mistralRichness ? 'Claude' : 'Mistral'} plus riche (+${Math.abs(claudeRichness - mistralRichness)} pts)`,
        } : null,
        recommendation: buildRecommendation(claudeRichness, mistralRichness, claudeResult, mistralResult),
      }

      return reply.send({
        comparison,
        results: {
          claude: claudeData,
          mistral: mistralData,
        },
        rawMeta: {
          claude: claudeResult ? { model: claudeResult.model, latencyMs: claudeResult.latencyMs } : null,
          mistral: mistralResult ? { model: mistralResult.model, latencyMs: mistralResult.latencyMs } : null,
        },
        offerId: id,
        requestedProfiles: maxProfiles,
      })
    },
  })

  // ── POST /recruitment/candidates/:id/send-email — Email personnalisé 1 clic ─
  fastify.post('/candidates/:id/send-email', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['recruitment'], summary: 'Envoyer un email personnalisé à un candidat (généré par IA ou manuel)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as {
        subject?: string
        body?: string
        template?: 'interview_invite' | 'rejection' | 'offer' | 'sourcing_contact' | 'custom'
        generateWithAI?: boolean
      }
      const db = getTenantDbForRequest(request)

      const [candidate] = await db.select().from(candidates).where(eq(candidates.id, id)).limit(1)
      if (!candidate) return reply.status(404).send({ error: 'Candidat introuvable' })
      if (!candidate.email) return reply.status(422).send({ error: 'Le candidat n\'a pas d\'adresse email' })

      const [entity] = await db.select({ name: legalEntities.name }).from(legalEntities).limit(1)
      const companyName = entity?.name ?? 'notre entreprise'

      let subject = body.subject ?? ''
      let emailBody = body.body ?? ''

      if (body.generateWithAI || !emailBody) {
        // Génération IA selon le template
        const templates: Record<string, string> = {
          interview_invite: `Écris un email professionnel et chaleureux pour inviter ${candidate.firstName} ${candidate.lastName} à un entretien. Mentionne notre intérêt pour son profil.`,
          rejection: `Écris un email de refus positif et respectueux pour ${candidate.firstName} ${candidate.lastName}. Valorise leur candidature tout en expliquant qu'on ne donnera pas suite.`,
          offer: `Écris un email de proposition d'embauche enthousiaste pour ${candidate.firstName} ${candidate.lastName}. Exprime notre satisfaction de leur proposer le poste.`,
          sourcing_contact: `Écris un message d'approche LinkedIn/email pour contacter ${candidate.firstName} ${candidate.lastName}, qui est actuellement ${candidate.currentPosition ?? 'professionnel'} chez ${candidate.currentCompany ?? 'son entreprise actuelle'}. Sois direct mais non intrusif, mentionne l'opportunité sans trop dévoiler.`,
          custom: body.body ? '' : `Écris un email professionnel pour ${candidate.firstName} ${candidate.lastName} concernant sa candidature.`,
        }

        const prompt = templates[body.template ?? 'custom'] ?? templates.custom

        if (prompt) {
          const aiMsg = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: `Tu es un responsable RH de ${companyName}. ${prompt}

L'email doit être en français, professionnel, personnalisé, et ne pas dépasser 150 mots.
Réponds avec exactement ce format JSON :
{"subject": "<objet de l'email>", "body": "<corps de l'email en HTML simple>"}`,
            }],
          })

          try {
            const rawText = (aiMsg.content[0] as { type: string; text: string }).text
            const jsonMatch = rawText.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string }
              subject = parsed.subject ?? subject
              emailBody = parsed.body ?? emailBody
            }
          } catch { /* keep manual */ }
        }
      }

      if (!subject || !emailBody) {
        return reply.status(422).send({ error: 'Sujet et corps de l\'email sont requis' })
      }

      // Send via SMTP
      const transporter = nodemailer.createTransport({
        host: process.env['SMTP_HOST'] ?? 'localhost',
        port: Number(process.env['SMTP_PORT'] ?? 587),
        secure: process.env['SMTP_SECURE'] === 'true',
        auth: process.env['SMTP_USER'] ? {
          user: process.env['SMTP_USER'],
          pass: process.env['SMTP_PASS'],
        } : undefined,
      })

      await transporter.sendMail({
        from: `"${companyName} — Recrutement" <${process.env['SMTP_FROM'] ?? 'recrutement@nexusrh.com'}>`,
        to: `${candidate.firstName} ${candidate.lastName} <${candidate.email}>`,
        subject,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          ${emailBody}
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0">
          <p style="color:#9CA3AF;font-size:12px">Équipe Recrutement — ${companyName}</p>
        </div>`,
      })

      return reply.send({
        success: true,
        sentTo: candidate.email,
        subject,
        template: body.template,
        generatedByAI: body.generateWithAI ?? !body.body,
      })
    },
  })

  // ── GET /careers — Page carrières publique (sans auth) ────────────────────
  fastify.get('/careers/:tenantSlug', {
    schema: { tags: ['recruitment'], summary: 'Page carrières publique d\'un tenant' },
    handler: async (request, reply) => {
      const { tenantSlug } = request.params as { tenantSlug: string }

      // Resolve tenant schema from slug
      const pool = (fastify as unknown as { pg?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } }).pg
      let schemaName = `tenant_${tenantSlug}`

      // Fetch offers from the tenant schema
      const { Pool: PgPool } = await import('pg')
      const pgPool = new PgPool({ connectionString: process.env['DATABASE_URL'] })
      try {
        const tenantRes = await pgPool.query<{ schema_name: string; name: string; primary_color: string; logo_url: string }>(
          `SELECT schema_name, name, primary_color, logo_url FROM platform.tenants WHERE slug = $1 AND status = 'active' LIMIT 1`,
          [tenantSlug],
        )
        if (!tenantRes.rows.length) {
          await pgPool.end()
          return reply.status(404).send({ error: 'Page carrières introuvable' })
        }
        const tenant = tenantRes.rows[0]!
        schemaName = tenant.schema_name

        const offersRes = await pgPool.query<{ id: string; title: string; description: string; contract_type: string; location: string; department_id: string; published_at: string; salary_min: number; salary_max: number; remote: boolean }>(
          `SELECT id, title, description, contract_type, location, department_id, published_at, salary_min, salary_max, remote
           FROM "${schemaName}".job_offers
           WHERE status = 'published'
           ORDER BY published_at DESC`,
        )

        const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offres d'emploi — ${tenant.name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F9FAFB;color:#111827}
    header{background:${tenant.primary_color ?? '#4F46E5'};color:white;padding:40px 24px;text-align:center}
    header h1{font-size:2rem;font-weight:800;margin-bottom:8px}
    header p{font-size:1rem;opacity:0.85}
    .container{max-width:900px;margin:0 auto;padding:40px 24px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:20px}
    .card{background:white;border-radius:16px;border:1px solid #E5E7EB;padding:24px;transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.05)}
    .card:hover{border-color:${tenant.primary_color ?? '#4F46E5'};box-shadow:0 4px 12px rgba(79,70,229,.12);transform:translateY(-2px)}
    .card h2{font-size:1.125rem;font-weight:700;color:#111827;margin-bottom:8px}
    .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:.75rem;font-weight:600;margin-right:6px;margin-bottom:4px}
    .badge-contract{background:#EEF2FF;color:#4F46E5}
    .badge-location{background:#F0FDF4;color:#16A34A}
    .badge-remote{background:#FFF7ED;color:#EA580C}
    .meta{font-size:.8rem;color:#6B7280;margin-top:8px}
    .btn{display:inline-block;margin-top:16px;padding:10px 20px;background:${tenant.primary_color ?? '#4F46E5'};color:white;text-decoration:none;border-radius:10px;font-weight:600;font-size:.9rem;transition:opacity .2s}
    .btn:hover{opacity:.9}
    .empty{text-align:center;padding:80px 24px;color:#6B7280}
    footer{text-align:center;padding:40px 24px;color:#9CA3AF;font-size:.8rem;border-top:1px solid #E5E7EB}
    .apply-form{margin-top:40px;background:white;border-radius:16px;border:1px solid #E5E7EB;padding:32px}
    .apply-form h2{font-size:1.25rem;font-weight:700;margin-bottom:20px;color:#111827}
    .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
    .form-group{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
    label{font-size:.85rem;font-weight:600;color:#374151}
    input,select,textarea{border:1px solid #D1D5DB;border-radius:8px;padding:10px 14px;font-size:.9rem;width:100%;outline:none;transition:border-color .2s}
    input:focus,select:focus,textarea:focus{border-color:${tenant.primary_color ?? '#4F46E5'};box-shadow:0 0 0 3px rgba(79,70,229,.1)}
    .submit-btn{width:100%;padding:14px;background:${tenant.primary_color ?? '#4F46E5'};color:white;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;transition:opacity .2s}
    .submit-btn:hover{opacity:.9}
  </style>
</head>
<body>
  <header>
    ${tenant.logo_url ? `<img src="${tenant.logo_url}" alt="${tenant.name}" style="height:64px;margin-bottom:16px;border-radius:12px">` : `<div style="width:64px;height:64px;background:rgba(255,255,255,0.2);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:1.5rem;font-weight:800">${tenant.name.charAt(0)}</div>`}
    <h1>${tenant.name}</h1>
    <p>Rejoignez notre équipe — ${offersRes.rows.length} offre${offersRes.rows.length !== 1 ? 's' : ''} disponible${offersRes.rows.length !== 1 ? 's' : ''}</p>
  </header>
  <div class="container">
    ${offersRes.rows.length === 0
    ? `<div class="empty"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" stroke-width="1.5" style="margin-bottom:16px"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg><h2 style="font-size:1.25rem;margin-bottom:8px">Aucune offre pour le moment</h2><p>Revenez bientôt pour découvrir nos nouvelles opportunités.</p></div>`
    : `<div class="grid">
        ${offersRes.rows.map((offer) => `
        <div class="card">
          <h2>${offer.title}</h2>
          <div style="margin-top:8px">
            ${offer.contract_type ? `<span class="badge badge-contract">${offer.contract_type}</span>` : ''}
            ${offer.location ? `<span class="badge badge-location">📍 ${offer.location}</span>` : ''}
            ${offer.remote ? `<span class="badge badge-remote">🏠 Télétravail</span>` : ''}
          </div>
          ${offer.salary_min && offer.salary_max ? `<p class="meta">💶 ${offer.salary_min.toLocaleString('fr-FR')} – ${offer.salary_max.toLocaleString('fr-FR')} € / an</p>` : ''}
          ${offer.description ? `<p style="font-size:.875rem;color:#4B5563;margin-top:12px;line-height:1.6">${offer.description.substring(0, 200)}${offer.description.length > 200 ? '…' : ''}</p>` : ''}
          <p class="meta">Publiée le ${new Date(offer.published_at).toLocaleDateString('fr-FR')}</p>
          <a href="#apply-${offer.id}" class="btn">Postuler →</a>
        </div>`).join('')}
      </div>

      ${offersRes.rows.map((offer) => `
      <div id="apply-${offer.id}" class="apply-form" style="scroll-margin-top:24px">
        <h2>Postuler — ${offer.title}</h2>
        <div id="success-${offer.id}" style="display:none;background:#F0FDF4;border:1px solid #86EFAC;border-radius:12px;padding:20px;text-align:center;margin-bottom:16px">
          <div style="font-size:2rem;margin-bottom:8px">✅</div>
          <p style="color:#16A34A;font-weight:700">Candidature envoyée !</p>
          <p style="color:#374151;font-size:.9rem;margin-top:4px">Nous reviendrons vers vous dans les meilleurs délais.</p>
        </div>
        <div id="error-${offer.id}" style="display:none;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:12px;padding:16px;margin-bottom:16px">
          <p style="color:#DC2626;font-size:.9rem">Une erreur est survenue. Veuillez réessayer.</p>
        </div>
        <form id="form-${offer.id}" onsubmit="submitApplication(event,'${offer.id}','${tenantSlug}')">
          <div class="form-row">
            <div class="form-group">
              <label for="firstName-${offer.id}">Prénom *</label>
              <input type="text" id="firstName-${offer.id}" required placeholder="Alice">
            </div>
            <div class="form-group">
              <label for="lastName-${offer.id}">Nom *</label>
              <input type="text" id="lastName-${offer.id}" required placeholder="Martin">
            </div>
          </div>
          <div class="form-group">
            <label for="email-${offer.id}">Email *</label>
            <input type="email" id="email-${offer.id}" required placeholder="alice@exemple.com">
          </div>
          <div class="form-group">
            <label for="phone-${offer.id}">Téléphone</label>
            <input type="tel" id="phone-${offer.id}" placeholder="0612345678">
          </div>
          <div class="form-group">
            <label for="currentPosition-${offer.id}">Poste actuel</label>
            <input type="text" id="currentPosition-${offer.id}" placeholder="Développeur Frontend">
          </div>
          <div class="form-group">
            <label for="message-${offer.id}">Lettre de motivation / Message</label>
            <textarea id="message-${offer.id}" rows="5" placeholder="Parlez-nous de votre motivation pour ce poste..."></textarea>
          </div>
          <button type="submit" class="submit-btn" id="btn-${offer.id}">Envoyer ma candidature</button>
        </form>
      </div>`).join('')}
      <script>
      async function submitApplication(e, offerId, tenantSlug) {
        e.preventDefault();
        var btn = document.getElementById('btn-' + offerId);
        var errEl = document.getElementById('error-' + offerId);
        var successEl = document.getElementById('success-' + offerId);
        btn.disabled = true;
        btn.textContent = 'Envoi en cours...';
        errEl.style.display = 'none';
        try {
          var res = await fetch('/recruitment/careers/' + tenantSlug + '/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobOfferId: offerId,
              firstName: document.getElementById('firstName-' + offerId).value,
              lastName: document.getElementById('lastName-' + offerId).value,
              email: document.getElementById('email-' + offerId).value,
              phone: document.getElementById('phone-' + offerId).value || undefined,
              currentPosition: document.getElementById('currentPosition-' + offerId).value || undefined,
              message: document.getElementById('message-' + offerId).value || undefined,
            })
          });
          if (res.ok) {
            document.getElementById('form-' + offerId).style.display = 'none';
            successEl.style.display = 'block';
          } else {
            throw new Error('Server error');
          }
        } catch(_) {
          errEl.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Envoyer ma candidature';
        }
      }
      </script>
    `}
  </div>
  <footer>
    <p>Powered by <strong>NexusRH</strong> — SIRH SaaS Multi-Tenant</p>
  </footer>
</body>
</html>`

        await pgPool.end()
        return reply.header('Content-Type', 'text/html; charset=utf-8').send(html)
      } catch (err) {
        await pgPool.end().catch(() => undefined)
        throw err
      }
    },
  })

  // ── POST /careers/:tenantSlug/apply — Soumission candidature externe ────────
  fastify.post('/careers/:tenantSlug/apply', {
    schema: { tags: ['recruitment'], summary: 'Soumission de candidature depuis la page carrières publique' },
    handler: async (request, reply) => {
      const { tenantSlug } = request.params as { tenantSlug: string }
      const body = request.body as {
        jobOfferId: string
        firstName: string
        lastName: string
        email: string
        phone?: string
        currentPosition?: string
        message?: string
      }

      const { Pool: PgPool } = await import('pg')
      const pgPool = new PgPool({ connectionString: process.env['DATABASE_URL'] })
      try {
        const tenantRes = await pgPool.query<{ schema_name: string; name: string }>(
          `SELECT schema_name, name FROM platform.tenants WHERE slug = $1 AND status = 'active' LIMIT 1`,
          [tenantSlug],
        )
        if (!tenantRes.rows.length) {
          await pgPool.end()
          return reply.status(404).send({ error: 'Tenant introuvable' })
        }

        const { schema_name: schemaName } = tenantRes.rows[0]!
        await pgPool.query(
          `INSERT INTO "${schemaName}".candidates
             (job_offer_id, first_name, last_name, email, phone, current_position, source, stage, cover_letter_url)
           VALUES ($1,$2,$3,$4,$5,$6,'careers_page','new',$7)
           ON CONFLICT (email, job_offer_id) DO NOTHING`,
          [body.jobOfferId, body.firstName, body.lastName, body.email,
           body.phone ?? null, body.currentPosition ?? null,
           body.message ? body.message.substring(0, 500) : null],
        )

        await pgPool.end()
        return reply.send({ success: true, message: `Candidature de ${body.firstName} reçue avec succès` })
      } catch (err) {
        await pgPool.end().catch(() => undefined)
        throw err
      }
    },
  })
}

export default recruitmentRoutes
