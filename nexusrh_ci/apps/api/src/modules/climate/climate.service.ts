/**
 * Enquêtes climat social — logique PURE (statuts, validation des questions,
 * agrégation des résultats). Aucune dépendance (Fastify/DB) → testable.
 *
 * CONFIDENTIALITÉ : l'agrégation ne produit QUE des statistiques (moyennes,
 * distributions, comptes) — jamais de réponse rattachée à un salarié. C'est ce
 * qui garantit l'anonymat exigé pour une enquête de climat social.
 */

export const SURVEY_STATUSES = ['draft', 'open', 'closed'] as const
export type SurveyStatus = (typeof SURVEY_STATUSES)[number]

const STATUS_TRANSITIONS: Record<SurveyStatus, SurveyStatus[]> = {
  draft: ['open'],
  open: ['closed'],
  closed: [],
}

export const QUESTION_TYPES = ['scale', 'text', 'boolean'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export interface SurveyQuestion {
  key: string
  label: string
  type: QuestionType
}

export function isValidStatus(s: unknown): s is SurveyStatus {
  return typeof s === 'string' && (SURVEY_STATUSES as readonly string[]).includes(s)
}

export function canTransition(from: SurveyStatus, to: SurveyStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}

/** Normalise/valide une liste de questions ; lève si invalide. Clés uniques. */
export function validateQuestions(input: unknown): SurveyQuestion[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Au moins une question est requise')
  }
  const seen = new Set<string>()
  return input.map((q, i) => {
    const o = q as Record<string, unknown>
    const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : `q${i + 1}`
    const label = typeof o.label === 'string' ? o.label.trim() : ''
    const type = (QUESTION_TYPES as readonly string[]).includes(o.type as string)
      ? (o.type as QuestionType) : 'scale'
    if (!label) throw new Error(`Libellé manquant pour la question ${i + 1}`)
    if (seen.has(key)) throw new Error(`Clé de question dupliquée : ${key}`)
    seen.add(key)
    return { key, label, type }
  })
}

export interface ScaleAggregate {
  type: 'scale'
  key: string
  label: string
  count: number
  average: number
  distribution: Record<string, number> // '1'..'5' → count
}
export interface BooleanAggregate {
  type: 'boolean'
  key: string
  label: string
  count: number
  yes: number
  yesRate: number // 0..1
}
export interface TextAggregate {
  type: 'text'
  key: string
  label: string
  count: number
  answers: string[] // réponses libres (anonymes)
}
export type QuestionAggregate = ScaleAggregate | BooleanAggregate | TextAggregate

export interface SurveyResults {
  responseCount: number
  questions: QuestionAggregate[]
}

/**
 * Agrège les réponses d'une enquête. `responses` = liste de maps
 * { questionKey: value }. Aucune information nominative n'entre ici.
 */
export function aggregateResults(
  questions: SurveyQuestion[],
  responses: Array<Record<string, unknown>>,
): SurveyResults {
  const out: QuestionAggregate[] = []
  for (const q of questions) {
    const values = responses
      .map((r) => r[q.key])
      .filter((v) => v !== undefined && v !== null && v !== '')

    if (q.type === 'scale') {
      const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
      for (const n of nums) {
        const k = String(Math.min(5, Math.max(1, Math.round(n))))
        distribution[k] = (distribution[k] ?? 0) + 1
      }
      const sum = nums.reduce((a, b) => a + b, 0)
      const average = nums.length ? Math.round((sum / nums.length) * 100) / 100 : 0
      out.push({ type: 'scale', key: q.key, label: q.label, count: nums.length, average, distribution })
    } else if (q.type === 'boolean') {
      const bools = values.map((v) => v === true || v === 'true' || v === 1 || v === '1')
      const yes = bools.filter(Boolean).length
      const yesRate = bools.length ? Math.round((yes / bools.length) * 100) / 100 : 0
      out.push({ type: 'boolean', key: q.key, label: q.label, count: bools.length, yes, yesRate })
    } else {
      const texts = values.map((v) => String(v)).filter((s) => s.trim().length > 0)
      out.push({ type: 'text', key: q.key, label: q.label, count: texts.length, answers: texts })
    }
  }
  return { responseCount: responses.length, questions: out }
}
