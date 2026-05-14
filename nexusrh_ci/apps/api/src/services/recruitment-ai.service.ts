import { config } from '../config.js'

export type AiModelChoice = 'claude' | 'mistral'

export interface JobContext {
  title:        string
  description?: string | null
  requirements?: string | null
  contractType?: string | null
  location?:    string | null
  salaryMin?:   number | null
  salaryMax?:   number | null
}

export interface CvAnalysisResult {
  score:             number          // 0-100
  recommendation:    'strong_yes' | 'yes' | 'maybe' | 'no'
  summary:           string
  strengths:         string[]
  gaps:              string[]
  redFlags:          string[]
  interviewQuestions: string[]
  matchPercentage:   number
  modelUsed:         AiModelChoice
}

const SYSTEM_PROMPT = `Tu es un expert RH ivoirien chargé de pré-sélectionner des candidats.
Tu analyses un CV par rapport à une offre d'emploi et tu retournes UNIQUEMENT un objet JSON
valide (sans balises markdown, sans texte avant/après) avec exactement cette structure :

{
  "score": <entier 0-100>,
  "recommendation": "strong_yes" | "yes" | "maybe" | "no",
  "summary": "<résumé en 2-3 phrases en français>",
  "strengths": ["<atout 1>", "<atout 2>", ...],
  "gaps": ["<manque 1>", "<manque 2>", ...],
  "redFlags": ["<alerte 1>", ...],
  "interviewQuestions": ["<question 1>", "<question 2>", "<question 3>"],
  "matchPercentage": <entier 0-100>
}

Règles :
- score = jugement global, matchPercentage = adéquation aux requirements
- Tiens compte du contexte ivoirien (Code du Travail CI, conventions OHADA, marché Abidjan)
- redFlags = uniquement signaux objectifs (trous de carrière > 12 mois, incohérence, etc.)
- Rends 3 questions d'entretien spécifiques et pratiques
- N'invente jamais d'informations absentes du CV`

function buildUserPrompt(job: JobContext, cvText: string): string {
  const reqs = job.requirements?.trim() || '(non précisés)'
  const desc = job.description?.trim() || '(non précisée)'
  const salary = job.salaryMin && job.salaryMax
    ? `${job.salaryMin}–${job.salaryMax} FCFA`
    : '(non précisée)'
  return `OFFRE :
- Titre : ${job.title}
- Type de contrat : ${job.contractType ?? 'CDI'}
- Lieu : ${job.location ?? 'Abidjan'}
- Fourchette de salaire : ${salary}
- Description : ${desc}
- Prérequis : ${reqs}

CV DU CANDIDAT :
${cvText}

Analyse ce CV par rapport à l'offre et retourne le JSON.`
}

function extractJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('{')
  const end   = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Réponse IA sans JSON exploitable')
  }
  return JSON.parse(cleaned.slice(start, end + 1))
}

function normalize(raw: unknown, model: AiModelChoice): CvAnalysisResult {
  if (!raw || typeof raw !== 'object') throw new Error('Réponse IA invalide')
  const r = raw as Record<string, unknown>
  const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)))
  const matchPercentage = Math.max(0, Math.min(100,
    Math.round(Number(r.matchPercentage) || score)
  ))
  const recommendation = (['strong_yes', 'yes', 'maybe', 'no'] as const)
    .find(v => v === r.recommendation) ?? 'maybe'
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 10) : []
  return {
    score,
    recommendation,
    summary:           typeof r.summary === 'string' ? r.summary : '',
    strengths:         arr(r.strengths),
    gaps:              arr(r.gaps),
    redFlags:          arr(r.redFlags),
    interviewQuestions: arr(r.interviewQuestions),
    matchPercentage,
    modelUsed:         model,
  }
}

async function analyzeWithClaude(job: JobContext, cvText: string): Promise<CvAnalysisResult> {
  if (!config.ai.apiKey) {
    throw new Error('Clé Anthropic non configurée (ANTHROPIC_API_KEY)')
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey: config.ai.apiKey })
  const msg = await client.messages.create({
    model:       config.ai.model,
    max_tokens:  Math.min(config.ai.maxTokens, 2048),
    temperature: 0.2,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: buildUserPrompt(job, cvText) }],
  })
  const textBlock = msg.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Réponse Claude vide')
  }
  return normalize(extractJson(textBlock.text), 'claude')
}

async function analyzeWithMistral(job: JobContext, cvText: string): Promise<CvAnalysisResult> {
  if (!config.mistral.apiKey) {
    throw new Error('Clé Mistral non configurée (MISTRAL_API_KEY)')
  }
  const res = await fetch(`${config.mistral.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.mistral.apiKey}`,
    },
    body: JSON.stringify({
      model: config.mistral.model,
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(job, cvText) },
      ],
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Erreur Mistral ${res.status}: ${errText.slice(0, 200)}`)
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Réponse Mistral vide')
  return normalize(extractJson(content), 'mistral')
}

export function isModelAvailable(model: AiModelChoice): boolean {
  if (model === 'claude')  return Boolean(config.ai.apiKey)
  if (model === 'mistral') return Boolean(config.mistral.apiKey)
  return false
}

/**
 * Analyse un CV par rapport à une offre. Le choix du modèle se fait côté UI.
 * Si le modèle demandé n'a pas de clé, on bascule sur l'autre. Si aucun n'est
 * configuré, on remonte une erreur explicite (jamais de fallback silencieux).
 */
export async function analyzeCV(
  model: AiModelChoice,
  job: JobContext,
  cvText: string,
): Promise<CvAnalysisResult> {
  if (!cvText || cvText.trim().length < 50) {
    throw new Error('CV trop court ou vide (minimum 50 caractères)')
  }
  const preferred = isModelAvailable(model) ? model
    : isModelAvailable('claude') ? 'claude'
    : isModelAvailable('mistral') ? 'mistral'
    : null
  if (!preferred) {
    throw new Error('Aucun modèle IA configuré. Définissez ANTHROPIC_API_KEY ou MISTRAL_API_KEY.')
  }
  if (preferred === 'claude')  return analyzeWithClaude(job, cvText)
  return analyzeWithMistral(job, cvText)
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCING IA — génération de profils synthétiques pour une offre
// ─────────────────────────────────────────────────────────────────────────────
// Couverture multi-pays africains (groupes avec filiales africaines). Plateformes
// globales + panafricaines + locales par pays. Devise locale détectée selon le
// pays cible principal de l'offre.

export interface SourcingContext {
  title:         string
  description?:  string | null
  requirements?: string | null
  contractType?: string | null
  location?:     string | null
  salaryMin?:    number | null
  salaryMax?:    number | null
  currency?:     string | null   // XOF, XAF, NGN, EUR…
}

export interface SourcingProfile {
  firstName:            string
  lastName:             string
  currentPosition:      string
  currentCompany:       string
  location:             string
  experienceYears:      number
  keySkills:            string[]
  matchScore:           number
  availabilityEstimate: 'immediate' | '1month' | '3months' | 'passive'
  suggestedPlatform:    string
  linkedinSearch:       string
  approachStrategy:     string
  estimatedSalary:      number
  estimatedSalaryCurrency: string
}

export interface SourcingStrategy {
  summary:             string
  bestPlatforms:       Array<{ name: string; rationale: string; estimatedPool: number; url: string }>
  searchKeywords:      string[]
  booleanSearch:       string
  estimatedTimeToFill: string
  salaryBenchmark:     { min: number; max: number; median: number; currency: string }
  tips:                string[]
}

export interface SourcingResult {
  strategy: SourcingStrategy
  profiles: SourcingProfile[]
}

export interface SourcingProviderResult {
  provider:         AiModelChoice
  model:            string
  data:             SourcingResult | null
  jsonValid:        boolean
  richnessScore:    number
  profilesGenerated: number
  latencyMs:        number
  inputTokens:      number
  outputTokens:     number
  estimatedCostEur: number
  error:            string | null
}

export interface SourcingCompareResult {
  winner: AiModelChoice
  claude: SourcingProviderResult
  mistral: SourcingProviderResult
  ratios: {
    latency:  string
    cost:     string
    richness: string
  } | null
  recommendation: string
}

// Plateformes de sourcing par pays africain + panafricaines + globales.
// Liste indicative : l'IA en propose d'autres selon le poste et la localisation.
export const SOURCING_PLATFORMS_BY_COUNTRY: Record<string, string[]> = {
  CI: ['Emploi.ci', 'RMO Côte d\'Ivoire', 'Novojob', 'EducarriereCI'],
  SN: ['Emploi.sn', 'EmploiDakar', 'Senjob'],
  BJ: ['EmploiBénin', 'Bourse Emploi Bénin'],
  TG: ['Emploi-Togo', 'TogoEmploi'],
  CM: ['MinaJobs', 'JobsCameroon'],
  NG: ['Jobberman', 'MyJobMag', 'Hot Nigerian Jobs'],
  TD: ['Tchad-Emploi'],
  BF: ['Emploi.bf', 'Jobs Burkina'],
  ML: ['MaliEmploi', 'Emploi-Mali'],
  GA: ['EmploiGabon'],
  CG: ['CongoJob'],
  CD: ['MonCongo Jobs'],
  GH: ['Jobberman Ghana', 'JobWebGhana'],
  KE: ['BrighterMonday Kenya', 'Fuzu'],
  ZA: ['Careers24', 'PNet'],
  FR: ['Welcome to the Jungle', 'Apec', 'Cadremploi', 'HelloWork'],
}

export const SOURCING_PLATFORMS_PANAFRICAN = [
  'LinkedIn',
  'Africawork',
  'JobnetAfrica',
  'Glassdoor',
  'Indeed',
]

// Devise par défaut par pays (utilisée si l'offre n'a pas de devise explicite)
export const CURRENCY_BY_COUNTRY: Record<string, string> = {
  CI: 'XOF', SN: 'XOF', BJ: 'XOF', TG: 'XOF', BF: 'XOF', ML: 'XOF',
  CM: 'XAF', GA: 'XAF', CG: 'XAF', TD: 'XAF',
  NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR',
  CD: 'CDF', FR: 'EUR',
}

function buildSourcingPrompt(
  ctx: SourcingContext,
  platforms: string[],
  maxProfiles: number,
  countries: string[],
): string {
  const countriesList = countries.length ? countries.join(', ') : 'Afrique de l\'Ouest et Centrale'
  const primaryCountry = countries[0] ?? 'CI'
  const defaultCurrency = ctx.currency ?? CURRENCY_BY_COUNTRY[primaryCountry] ?? 'XOF'
  const salary = ctx.salaryMin && ctx.salaryMax
    ? `${ctx.salaryMin}–${ctx.salaryMax} ${defaultCurrency}`
    : '(non précisée)'

  return `Tu es un expert en sourcing RH pour des groupes opérant en Afrique (filiales et entreprises panafricaines).

Génère une stratégie de sourcing complète et ${maxProfiles} profils candidats SYNTHÉTIQUES réalistes pour ce poste.
Les profils doivent être crédibles : noms cohérents avec les pays cibles (mix prénoms locaux, francophones, anglophones selon les pays), parcours plausibles dans le contexte africain (universités locales, entreprises panafricaines, multinationales avec présence Afrique).

POSTE :
- Titre : ${ctx.title}
- Type de contrat : ${ctx.contractType ?? 'CDI'}
- Localisation : ${ctx.location ?? 'Abidjan'}
- Pays cibles : ${countriesList}
- Description : ${ctx.description ?? '(non précisée)'}
- Prérequis : ${ctx.requirements ?? '(non précisés)'}
- Fourchette de salaire : ${salary}
- Devise locale : ${defaultCurrency}

PLATEFORMES À CIBLER : ${platforms.join(', ')}

Adapte tes recommandations au contexte africain :
- Évoque la mobilité intra-africaine (filiales, expatriation régionale)
- Tiens compte des conventions OHADA pour les pays d'Afrique de l'Ouest et Centrale
- Mentionne les diasporas africaines (Paris, Londres, Montréal) si pertinent pour le sourcing
- Salaires estimés dans la devise locale (${defaultCurrency}), montants entiers

Réponds UNIQUEMENT en JSON valide (sans markdown, sans texte avant/après) avec cette structure :
{
  "strategy": {
    "summary": "<stratégie en 2-3 phrases>",
    "bestPlatforms": [{"name": "<plateforme>", "rationale": "<pourquoi>", "estimatedPool": <number>, "url": "<url>"}],
    "searchKeywords": ["<mot-clé 1>", "<mot-clé 2>", "<mot-clé 3>"],
    "booleanSearch": "<requête booléenne LinkedIn>",
    "estimatedTimeToFill": "<délai estimé en semaines>",
    "salaryBenchmark": {"min": <number>, "max": <number>, "median": <number>, "currency": "${defaultCurrency}"},
    "tips": ["<conseil 1>", "<conseil 2>"]
  },
  "profiles": [
    {
      "firstName": "<prénom>",
      "lastName": "<nom>",
      "currentPosition": "<poste actuel>",
      "currentCompany": "<entreprise>",
      "location": "<ville, pays>",
      "experienceYears": <number>,
      "keySkills": ["<compétence 1>", "<compétence 2>"],
      "matchScore": <0-100>,
      "availabilityEstimate": "immediate" | "1month" | "3months" | "passive",
      "suggestedPlatform": "<plateforme>",
      "linkedinSearch": "<requête LinkedIn pour retrouver ce profil>",
      "approachStrategy": "<comment approcher ce profil — message d'accroche court>",
      "estimatedSalary": <number entier>,
      "estimatedSalaryCurrency": "${defaultCurrency}"
    }
  ]
}`
}

function normalizeSourcing(raw: unknown): SourcingResult | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const profiles = Array.isArray(r['profiles']) ? r['profiles'] : []
  const strategy = (r['strategy'] && typeof r['strategy'] === 'object')
    ? r['strategy'] as Record<string, unknown>
    : null
  if (!strategy) return null

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const num = (v: unknown, fallback = 0): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }

  const bench = (strategy['salaryBenchmark'] && typeof strategy['salaryBenchmark'] === 'object')
    ? strategy['salaryBenchmark'] as Record<string, unknown>
    : {}

  const normalizedStrategy: SourcingStrategy = {
    summary:             typeof strategy['summary'] === 'string' ? strategy['summary'] : '',
    bestPlatforms:       Array.isArray(strategy['bestPlatforms'])
      ? (strategy['bestPlatforms'] as unknown[]).map((p) => {
          const pp = (p && typeof p === 'object') ? p as Record<string, unknown> : {}
          return {
            name:          typeof pp['name'] === 'string' ? pp['name'] : '',
            rationale:     typeof pp['rationale'] === 'string' ? pp['rationale'] : '',
            estimatedPool: num(pp['estimatedPool']),
            url:           typeof pp['url'] === 'string' ? pp['url'] : '',
          }
        })
      : [],
    searchKeywords:      strArr(strategy['searchKeywords']),
    booleanSearch:       typeof strategy['booleanSearch'] === 'string' ? strategy['booleanSearch'] : '',
    estimatedTimeToFill: typeof strategy['estimatedTimeToFill'] === 'string' ? strategy['estimatedTimeToFill'] : '',
    salaryBenchmark: {
      min:      num(bench['min']),
      max:      num(bench['max']),
      median:   num(bench['median']),
      currency: typeof bench['currency'] === 'string' ? bench['currency'] : 'XOF',
    },
    tips: strArr(strategy['tips']),
  }

  const normalizedProfiles: SourcingProfile[] = profiles.map((p) => {
    const pp = (p && typeof p === 'object') ? p as Record<string, unknown> : {}
    const availability = (['immediate', '1month', '3months', 'passive'] as const)
      .find(v => v === pp['availabilityEstimate']) ?? 'passive'
    return {
      firstName:            typeof pp['firstName'] === 'string' ? pp['firstName'] : '',
      lastName:             typeof pp['lastName'] === 'string' ? pp['lastName'] : '',
      currentPosition:      typeof pp['currentPosition'] === 'string' ? pp['currentPosition'] : '',
      currentCompany:       typeof pp['currentCompany'] === 'string' ? pp['currentCompany'] : '',
      location:             typeof pp['location'] === 'string' ? pp['location'] : '',
      experienceYears:      Math.max(0, Math.round(num(pp['experienceYears']))),
      keySkills:            strArr(pp['keySkills']),
      matchScore:           Math.max(0, Math.min(100, Math.round(num(pp['matchScore'])))),
      availabilityEstimate: availability,
      suggestedPlatform:    typeof pp['suggestedPlatform'] === 'string' ? pp['suggestedPlatform'] : '',
      linkedinSearch:       typeof pp['linkedinSearch'] === 'string' ? pp['linkedinSearch'] : '',
      approachStrategy:     typeof pp['approachStrategy'] === 'string' ? pp['approachStrategy'] : '',
      estimatedSalary:      Math.max(0, Math.round(num(pp['estimatedSalary']))),
      estimatedSalaryCurrency: typeof pp['estimatedSalaryCurrency'] === 'string'
        ? pp['estimatedSalaryCurrency']
        : 'XOF',
    }
  })

  return { strategy: normalizedStrategy, profiles: normalizedProfiles }
}

export function computeSourcingRichness(result: SourcingResult | null): number {
  if (!result) return 0
  let score = 0
  const { profiles, strategy } = result

  if (profiles.length > 0) score += 20
  if (profiles.length >= 5) score += 10
  score += Math.min(profiles.length, 10) * 2

  if (strategy.booleanSearch) score += 10
  if (strategy.searchKeywords.length >= 3) score += 10
  if (strategy.salaryBenchmark.median > 0) score += 10
  if (strategy.bestPlatforms.length >= 2) score += 10
  if (strategy.tips.length >= 2) score += 5

  const first = profiles[0]
  if (first) {
    if (first.linkedinSearch) score += 5
    if (first.approachStrategy) score += 5
    if (first.keySkills.length > 0) score += 5
  }

  return Math.min(score, 100)
}

interface AIRawResult {
  text:             string
  latencyMs:        number
  inputTokens:      number
  outputTokens:     number
  model:            string
}

async function callClaudeRaw(prompt: string, maxTokens: number): Promise<AIRawResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey: config.ai.apiKey })
  const t0 = Date.now()
  const msg = await client.messages.create({
    model:       config.ai.model,
    max_tokens:  maxTokens,
    temperature: 0.3,
    messages:    [{ role: 'user', content: prompt }],
  })
  const latencyMs = Date.now() - t0
  const textBlock = msg.content.find(b => b.type === 'text')
  const text = (textBlock && textBlock.type === 'text') ? textBlock.text : ''
  return {
    text,
    latencyMs,
    inputTokens:  msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    model:        config.ai.model,
  }
}

async function callMistralRaw(prompt: string, maxTokens: number): Promise<AIRawResult> {
  const t0 = Date.now()
  const res = await fetch(`${config.mistral.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.mistral.apiKey}`,
    },
    body: JSON.stringify({
      model:           config.mistral.model,
      temperature:     0.3,
      max_tokens:      maxTokens,
      response_format: { type: 'json_object' },
      messages:        [{ role: 'user', content: prompt }],
    }),
  })
  const latencyMs = Date.now() - t0
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Erreur Mistral ${res.status}: ${errText.slice(0, 200)}`)
  }
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?:   { prompt_tokens?: number; completion_tokens?: number }
  }
  return {
    text:         data.choices?.[0]?.message?.content ?? '',
    latencyMs,
    inputTokens:  data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    model:        config.mistral.model,
  }
}

// Tarifs au 2026-05 — convertis en EUR (×0.92 depuis USD pour Anthropic)
function costClaudeEur(inputTokens: number, outputTokens: number): number {
  return ((inputTokens * 3 + outputTokens * 15) / 1_000_000) * 0.92
}
function costMistralEur(inputTokens: number, outputTokens: number): number {
  return ((inputTokens * 2 + outputTokens * 6) / 1_000_000) * 0.92
}

async function sourceWithProvider(
  provider: AiModelChoice,
  ctx: SourcingContext,
  platforms: string[],
  maxProfiles: number,
  countries: string[],
): Promise<SourcingProviderResult> {
  const prompt = buildSourcingPrompt(ctx, platforms, maxProfiles, countries)
  try {
    const raw = provider === 'claude'
      ? await callClaudeRaw(prompt, 4000)
      : await callMistralRaw(prompt, 4000)

    let data: SourcingResult | null = null
    try {
      const parsed = extractJson(raw.text)
      data = normalizeSourcing(parsed)
    } catch {
      data = null
    }
    const cost = provider === 'claude'
      ? costClaudeEur(raw.inputTokens, raw.outputTokens)
      : costMistralEur(raw.inputTokens, raw.outputTokens)
    return {
      provider,
      model:            raw.model,
      data,
      jsonValid:        data !== null,
      richnessScore:    computeSourcingRichness(data),
      profilesGenerated: data?.profiles.length ?? 0,
      latencyMs:        raw.latencyMs,
      inputTokens:      raw.inputTokens,
      outputTokens:     raw.outputTokens,
      estimatedCostEur: cost,
      error:            null,
    }
  } catch (err) {
    return {
      provider,
      model:            provider === 'claude' ? config.ai.model : config.mistral.model,
      data:             null,
      jsonValid:        false,
      richnessScore:    0,
      profilesGenerated: 0,
      latencyMs:        0,
      inputTokens:      0,
      outputTokens:     0,
      estimatedCostEur: 0,
      error:            err instanceof Error ? err.message : String(err),
    }
  }
}

export async function sourceProfiles(
  model: AiModelChoice,
  ctx: SourcingContext,
  platforms: string[],
  maxProfiles: number,
  countries: string[],
): Promise<SourcingProviderResult> {
  const preferred = isModelAvailable(model) ? model
    : isModelAvailable('claude')  ? 'claude'
    : isModelAvailable('mistral') ? 'mistral'
    : null
  if (!preferred) {
    throw new Error('Aucun modèle IA configuré. Définissez ANTHROPIC_API_KEY ou MISTRAL_API_KEY.')
  }
  const capped = Math.max(1, Math.min(maxProfiles, 20))
  return sourceWithProvider(preferred, ctx, platforms, capped, countries)
}

function buildSourcingRecommendation(claude: SourcingProviderResult, mistral: SourcingProviderResult): string {
  if (!claude.jsonValid && !mistral.jsonValid) return 'Aucun résultat exploitable des deux modèles.'
  if (!mistral.jsonValid) return 'Mistral indisponible — utilisez Claude.'
  if (!claude.jsonValid)  return 'Claude indisponible — utilisez Mistral.'

  const richnessGap = Math.abs(claude.richnessScore - mistral.richnessScore)
  const costRatio = claude.estimatedCostEur / (mistral.estimatedCostEur || 0.0001)

  if (claude.richnessScore > mistral.richnessScore + 15) {
    return `Claude recommandé — richesse significativement supérieure (+${richnessGap} pts). Surcoût (×${costRatio.toFixed(1)}) justifié.`
  }
  if (mistral.richnessScore > claude.richnessScore + 15) {
    return `Mistral recommandé — qualité supérieure à moindre coût (+${richnessGap} pts).`
  }
  if (costRatio > 2 && richnessGap < 10) {
    return `Mistral recommandé — qualité comparable à ${costRatio.toFixed(1)}× moins cher. Idéal pour volume.`
  }
  if (mistral.latencyMs < claude.latencyMs * 0.7) {
    return `Mistral recommandé pour la réactivité — ${Math.round((claude.latencyMs - mistral.latencyMs) / 1000)}s plus rapide à qualité équivalente.`
  }
  return 'Qualité équivalente. Choisissez Claude pour la précision (OHADA, droit du travail africain) ou Mistral pour le volume.'
}

export async function sourceProfilesCompare(
  ctx: SourcingContext,
  platforms: string[],
  maxProfiles: number,
  countries: string[],
): Promise<SourcingCompareResult> {
  if (!isModelAvailable('claude')) {
    throw new Error('Clé Anthropic non configurée — comparaison impossible')
  }
  if (!isModelAvailable('mistral')) {
    throw new Error('Clé Mistral non configurée — comparaison impossible')
  }
  const capped = Math.max(1, Math.min(maxProfiles, 10))
  const [claude, mistral] = await Promise.all([
    sourceWithProvider('claude',  ctx, platforms, capped, countries),
    sourceWithProvider('mistral', ctx, platforms, capped, countries),
  ])

  const winner: AiModelChoice = claude.richnessScore >= mistral.richnessScore ? 'claude' : 'mistral'

  const ratios = (claude.jsonValid && mistral.jsonValid) ? {
    latency:  `Mistral ${mistral.latencyMs < claude.latencyMs ? 'plus rapide' : 'plus lent'} de ${Math.abs(mistral.latencyMs - claude.latencyMs)}ms`,
    cost:     `Mistral ${mistral.estimatedCostEur < claude.estimatedCostEur ? 'moins cher' : 'plus cher'} (×${(mistral.estimatedCostEur / (claude.estimatedCostEur || 0.0001)).toFixed(2)})`,
    richness: `${claude.richnessScore >= mistral.richnessScore ? 'Claude' : 'Mistral'} plus riche (+${Math.abs(claude.richnessScore - mistral.richnessScore)} pts)`,
  } : null

  return {
    winner,
    claude,
    mistral,
    ratios,
    recommendation: buildSourcingRecommendation(claude, mistral),
  }
}

// Exports internes pour les tests (sans réexposer l'API publique)
export const __internals = {
  buildSourcingPrompt,
  normalizeSourcing,
  computeSourcingRichness,
}
