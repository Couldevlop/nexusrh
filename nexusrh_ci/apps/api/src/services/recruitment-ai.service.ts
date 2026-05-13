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
