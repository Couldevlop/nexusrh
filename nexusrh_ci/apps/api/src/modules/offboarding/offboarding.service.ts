/**
 * Processus de sortie (offboarding) + solde de tout compte — logique PURE.
 *
 * Couche « domain » : motifs de départ, cycle de vie, checklist de restitution,
 * et calcul indicatif du solde de tout compte selon le Code du travail ivoirien.
 * Aucune dépendance (Fastify/DB) → entièrement testable.
 *
 * Montants en FCFA ENTIERS (jamais de décimale). Le solde est un ESTIMATIF RH
 * (indemnité de congés non pris + préavis non effectué + indemnité de
 * licenciement) ; il n'inclut pas la fiscalité (calculée par le moteur de paie).
 */

export const DEPARTURE_TYPES = [
  'demission',
  'retraite',
  'licenciement',
  'fin_cdd',
  'rupture_conventionnelle',
  'autre',
] as const
export type DepartureType = (typeof DEPARTURE_TYPES)[number]

export const OFFBOARDING_STATUSES = [
  'open',
  'in_progress',
  'settled',
  'closed',
  'cancelled',
] as const
export type OffboardingStatus = (typeof OFFBOARDING_STATUSES)[number]

const STATUS_TRANSITIONS: Record<OffboardingStatus, OffboardingStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['settled', 'cancelled'],
  settled: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
}

export interface ChecklistItem { key: string; label: string; done: boolean }

// Checklist de restitution par défaut (matériel, accès, documents).
export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { key: 'badge', label: 'Restitution du badge', done: false },
  { key: 'materiel_informatique', label: 'Restitution du matériel informatique (PC)', done: false },
  { key: 'telephone', label: 'Restitution du téléphone', done: false },
  { key: 'acces_si', label: 'Révocation des accès SI', done: false },
  { key: 'cles', label: 'Restitution des clés / moyens d\'accès', done: false },
  { key: 'documents_rh', label: 'Remise des documents RH (certificat, solde)', done: false },
]

export function isValidDepartureType(t: unknown): t is DepartureType {
  return typeof t === 'string' && (DEPARTURE_TYPES as readonly string[]).includes(t)
}
export function isValidStatus(s: unknown): s is OffboardingStatus {
  return typeof s === 'string' && (OFFBOARDING_STATUSES as readonly string[]).includes(s)
}
export function canTransition(from: OffboardingStatus, to: OffboardingStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}

/** Durée de préavis (mois) selon l'ancienneté — Code du travail CI (CDI). */
export function noticeMonths(seniorityMonths: number): number {
  if (seniorityMonths < 12) return 1
  if (seniorityMonths <= 60) return 2
  return 3
}

export interface SettlementInput {
  monthlyGross: number
  seniorityMonths: number
  departureType: DepartureType
  congesDaysOutstanding: number
  /** Préavis effectué ? Si non (dispense employeur), une indemnité compensatrice est due. */
  noticeServed: boolean
}

export interface SettlementLine { key: string; label: string; amount: number }
export interface Settlement {
  indemniteConges: number
  indemnitePreavis: number
  indemniteLicenciement: number
  total: number
  noticeMonths: number
  seniorityYears: number
  lines: SettlementLine[]
}

/** Taux progressif d'indemnité de licenciement par année d'ancienneté (CI). */
function licenciementRate(year: number): number {
  if (year <= 5) return 0.30
  if (year <= 10) return 0.35
  return 0.40
}

/**
 * Solde de tout compte indicatif (FCFA entiers). Hypothèses :
 *  - salaire journalier = brut mensuel / 30 ;
 *  - indemnité de congés = jours acquis non pris × salaire journalier ;
 *  - indemnité de préavis (compensatrice) due si départ licenciement / rupture
 *    conventionnelle ET préavis non effectué : noticeMonths × brut ;
 *  - indemnité de licenciement (départ licenciement, ancienneté ≥ 1 an) :
 *    cumul progressif 30 % (1–5 ans) / 35 % (6–10) / 40 % (>10) du brut par année.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const monthly = Math.max(0, Math.round(input.monthlyGross))
  const dailyRate = Math.round(monthly / 30)
  const seniorityYears = Math.floor(Math.max(0, input.seniorityMonths) / 12)
  const nm = noticeMonths(Math.max(0, input.seniorityMonths))

  const indemniteConges = Math.round(Math.max(0, input.congesDaysOutstanding) * dailyRate)

  let indemnitePreavis = 0
  if (
    (input.departureType === 'licenciement' || input.departureType === 'rupture_conventionnelle') &&
    !input.noticeServed
  ) {
    indemnitePreavis = nm * monthly
  }

  let indemniteLicenciement = 0
  if (input.departureType === 'licenciement' && seniorityYears >= 1) {
    for (let y = 1; y <= seniorityYears; y++) {
      indemniteLicenciement += Math.round(licenciementRate(y) * monthly)
    }
  }

  const total = indemniteConges + indemnitePreavis + indemniteLicenciement

  const lines: SettlementLine[] = [
    { key: 'conges', label: 'Indemnité compensatrice de congés', amount: indemniteConges },
    { key: 'preavis', label: 'Indemnité compensatrice de préavis', amount: indemnitePreavis },
    { key: 'licenciement', label: 'Indemnité de licenciement', amount: indemniteLicenciement },
  ]

  return { indemniteConges, indemnitePreavis, indemniteLicenciement, total, noticeMonths: nm, seniorityYears, lines }
}
