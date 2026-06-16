/**
 * Plans de succession & viviers de talents — logique PURE.
 *
 * Couche « domain » : niveaux de criticité des postes clés, niveaux de
 * préparation (readiness) des successeurs, et synthèse de couverture d'un plan.
 * Aucune dépendance (Fastify/DB) → testable.
 */

export const CRITICALITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export type Criticality = (typeof CRITICALITY_LEVELS)[number]

export const PLAN_STATUSES = ['active', 'archived'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

// Niveau de préparation du successeur (du plus prêt au moins prêt).
export const READINESS_LEVELS = ['ready_now', 'short_term', 'medium_term', 'long_term'] as const
export type Readiness = (typeof READINESS_LEVELS)[number]

export function isValidCriticality(v: unknown): v is Criticality {
  return typeof v === 'string' && (CRITICALITY_LEVELS as readonly string[]).includes(v)
}
export function isValidReadiness(v: unknown): v is Readiness {
  return typeof v === 'string' && (READINESS_LEVELS as readonly string[]).includes(v)
}
export function isValidPlanStatus(v: unknown): v is PlanStatus {
  return typeof v === 'string' && (PLAN_STATUSES as readonly string[]).includes(v)
}

export interface CoverageSummary {
  candidateCount: number
  readyNow: number
  byReadiness: Record<Readiness, number>
  /** Risque de relève : aucun successeur (true) ou aucun « prêt maintenant ». */
  atRisk: boolean
}

/**
 * Synthèse de couverture d'un plan à partir des niveaux de préparation de ses
 * candidats. atRisk = aucun candidat OU aucun « ready_now ».
 */
export function summarizeCoverage(readinessList: Array<string | null | undefined>): CoverageSummary {
  const byReadiness: Record<Readiness, number> = {
    ready_now: 0, short_term: 0, medium_term: 0, long_term: 0,
  }
  let candidateCount = 0
  for (const r of readinessList) {
    if (isValidReadiness(r)) {
      byReadiness[r] += 1
      candidateCount += 1
    } else if (r != null) {
      // valeur inconnue : comptée comme candidat mais non classée
      candidateCount += 1
    }
  }
  const readyNow = byReadiness.ready_now
  return { candidateCount, readyNow, byReadiness, atRisk: candidateCount === 0 || readyNow === 0 }
}
