/**
 * Mobilités — logique PURE.
 *
 * Workflow de validation d'une passerelle de mobilité + analyse d'écart entre
 * les compétences requises par le poste cible et les compétences évaluées du
 * salarié (taxonomie de Bloom 1–6). Aucune dépendance (Fastify/DB) → testable.
 */

export const MOBILITY_STATUSES = ['proposed', 'in_review', 'approved', 'rejected', 'cancelled'] as const
export type MobilityStatus = (typeof MOBILITY_STATUSES)[number]

// Workflow : Manager propose → DRH/Finance en revue → décision (approuvé/rejeté).
const STATUS_TRANSITIONS: Record<MobilityStatus, MobilityStatus[]> = {
  proposed: ['in_review', 'cancelled'],
  in_review: ['approved', 'rejected', 'cancelled'],
  approved: [],
  rejected: [],
  cancelled: [],
}

export function isValidStatus(s: unknown): s is MobilityStatus {
  return typeof s === 'string' && (MOBILITY_STATUSES as readonly string[]).includes(s)
}
export function canTransition(from: MobilityStatus, to: MobilityStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}
export function isDecision(to: MobilityStatus): boolean {
  return to === 'approved' || to === 'rejected'
}

export interface RequiredItem { competencyId: string; label: string; requiredLevel: number }
export interface GapRow {
  competencyId: string; label: string
  requiredLevel: number
  currentLevel: number | null
  /** Écart à combler = max(0, requis − acquis). null/0 = pas d'écart. */
  gap: number
}
export interface GapAnalysis {
  rows: GapRow[]
  gapsCount: number
  /** Vrai si le salarié atteint tous les niveaux requis (aucun écart). */
  ready: boolean
  /** % de couverture (compétences sans écart / total requis), 0–100. */
  coveragePct: number
}

/**
 * Compare les compétences REQUISES par le poste cible aux niveaux ÉVALUÉS du
 * salarié. assessed = map competencyId → niveau acquis. Pur, trié par libellé.
 */
export function gapAnalysis(required: RequiredItem[], assessed: Map<string, number>): GapAnalysis {
  const rows: GapRow[] = required
    .map((r) => {
      const current = assessed.has(r.competencyId) ? assessed.get(r.competencyId)! : null
      const gap = Math.max(0, r.requiredLevel - (current ?? 0))
      return { competencyId: r.competencyId, label: r.label, requiredLevel: r.requiredLevel, currentLevel: current, gap }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  const gapsCount = rows.filter((r) => r.gap > 0).length
  const coveragePct = rows.length === 0 ? 100 : Math.round(((rows.length - gapsCount) / rows.length) * 100)
  return { rows, gapsCount, ready: gapsCount === 0 && rows.length > 0, coveragePct }
}
