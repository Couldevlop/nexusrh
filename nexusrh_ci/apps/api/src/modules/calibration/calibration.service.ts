/**
 * Calibrage (sessions 9-box) — logique PURE.
 *
 * Mapping performance × potentiel (échelle 1–3) vers l'une des 9 cases de la
 * matrice 9-box, avec une clé i18n cohérente avec le module Carrières.
 * Aucune dépendance (Fastify/DB) → testable.
 */

export const SESSION_STATUSES = ['draft', 'in_progress', 'closed'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

const STATUS_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  draft: ['in_progress', 'closed'],
  in_progress: ['closed'],
  closed: [],
}

// Échelle 1–3 pour performance et potentiel (faible / moyen / élevé).
export const SCALE_MIN = 1
export const SCALE_MAX = 3

export function isValidStatus(s: unknown): s is SessionStatus {
  return typeof s === 'string' && (SESSION_STATUSES as readonly string[]).includes(s)
}
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}
export function isValidScore(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= SCALE_MIN && n <= SCALE_MAX
}

// Clés des 9 cases (cohérentes avec le module Carrières : star, high_perf, …).
// Indexées par [performance][potential] sur l'échelle 1–3.
const NINE_BOX: Record<number, Record<number, { cell: number; key: string }>> = {
  1: { 1: { cell: 1, key: 'risk' },         2: { cell: 2, key: 'inconsistent' }, 3: { cell: 3, key: 'enigma' } },
  2: { 1: { cell: 4, key: 'solid' },        2: { cell: 5, key: 'core' },         3: { cell: 6, key: 'high_pot' } },
  3: { 1: { cell: 7, key: 'expert' },       2: { cell: 8, key: 'high_perf' },    3: { cell: 9, key: 'star' } },
}

export interface NineBox { cell: number; key: string }

/** Case 9-box pour (performance, potentiel) sur l'échelle 1–3. null si scores absents/invalides. */
export function nineBox(performance: number | null | undefined, potential: number | null | undefined): NineBox | null {
  if (!isValidScore(performance) || !isValidScore(potential)) return null
  return NINE_BOX[performance]![potential]!
}

/** Synthèse d'une session : répartition des collaborateurs par case (sur l'état le plus récent). */
export interface CalibrationCounts {
  total: number
  byKey: Record<string, number>
}

export function summarizeSession(
  entries: Array<{ performance_after: number | null; potential_after: number | null; performance_before: number | null; potential_before: number | null }>,
): CalibrationCounts {
  const byKey: Record<string, number> = {}
  let total = 0
  for (const e of entries) {
    // L'état « après calibrage » prime ; sinon l'état « avant ».
    const box = nineBox(e.performance_after, e.potential_after) ?? nineBox(e.performance_before, e.potential_before)
    if (box) {
      byKey[box.key] = (byKey[box.key] ?? 0) + 1
      total += 1
    }
  }
  return { total, byKey }
}
