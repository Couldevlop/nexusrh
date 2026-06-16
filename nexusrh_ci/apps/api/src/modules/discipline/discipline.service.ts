/**
 * Gestion disciplinaire / sanctions — logique PURE (échelle, statuts, transitions).
 *
 * Donnée de niveau 4 (hautement sensible) : l'accès est restreint côté routes
 * (RBAC RH habilités) et chaque action est journalisée. Ce module ne contient
 * que des règles métier sans dépendance — couche « domain » testable sans infra.
 */

// Échelle disciplinaire (du plus léger au plus grave) — contexte CI / général.
export const DISCIPLINE_TYPES = [
  'observation',
  'avertissement',
  'blame',
  'mise_a_pied',
  'licenciement',
] as const
export type DisciplineType = (typeof DISCIPLINE_TYPES)[number]

// Sévérité 1..5 (utile pour tri / alertes / récidive).
const SEVERITY: Record<DisciplineType, number> = {
  observation: 1,
  avertissement: 2,
  blame: 3,
  mise_a_pied: 4,
  licenciement: 5,
}

export const DISCIPLINE_STATUSES = [
  'draft',
  'issued',
  'contested',
  'closed',
  'cancelled',
] as const
export type DisciplineStatus = (typeof DISCIPLINE_STATUSES)[number]

// Transitions autorisées du cycle de vie. L'annulation (cancelled) reste
// possible depuis tout état non terminal — on garde la trace, jamais de
// suppression silencieuse.
const STATUS_TRANSITIONS: Record<DisciplineStatus, DisciplineStatus[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['contested', 'closed', 'cancelled'],
  contested: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
}

export function isValidType(t: unknown): t is DisciplineType {
  return typeof t === 'string' && (DISCIPLINE_TYPES as readonly string[]).includes(t)
}

export function isValidStatus(s: unknown): s is DisciplineStatus {
  return typeof s === 'string' && (DISCIPLINE_STATUSES as readonly string[]).includes(s)
}

export function severityOf(t: DisciplineType): number {
  return SEVERITY[t]
}

/** Vrai si la transition de statut est autorisée (idempotent : from===to OK). */
export function canTransition(from: DisciplineStatus, to: DisciplineStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}

/** États terminaux : aucune modification de statut possible. */
export function isTerminal(s: DisciplineStatus): boolean {
  return STATUS_TRANSITIONS[s].length === 0
}
