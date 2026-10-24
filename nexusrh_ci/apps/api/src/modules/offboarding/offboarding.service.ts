/**
 * Processus de sortie (offboarding) + solde de tout compte — logique PURE.
 *
 * Couche « domain » : motifs de départ, cycle de vie, checklist de restitution,
 * et calcul indicatif du solde de tout compte selon les règles de rupture du
 * pays de l'employé (pack législatif) ou de la convention du tenant.
 * Aucune dépendance (Fastify/DB) → entièrement testable.
 *
 * Montants ENTIERS dans la devise du pack (jamais de décimale). Le solde est un ESTIMATIF RH
 * (indemnité de congés non pris + préavis non effectué + indemnité de
 * licenciement) ; il n'inclut pas la fiscalité (calculée par le moteur de paie).
 */

import type { TerminationRules } from '../../services/legislation-packs.js'

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

export function isValidStatus(s: unknown): s is OffboardingStatus {
  return typeof s === 'string' && (OFFBOARDING_STATUSES as readonly string[]).includes(s)
}
export function canTransition(from: OffboardingStatus, to: OffboardingStatus): boolean {
  if (from === to) return true
  return STATUS_TRANSITIONS[from].includes(to)
}

/** Premier palier dont la borne haute (incluse) couvre `value` ; null = sans borne. */
function tierFor<T>(tiers: ReadonlyArray<T>, value: number, upTo: (t: T) => number | null): T | null {
  for (const t of tiers) {
    const max = upTo(t)
    if (max === null || value <= max) return t
  }
  return null
}

/**
 * Durée de préavis (mois) selon l'ancienneté, d'après les règles du pays (ou
 * de la convention du tenant). null = aucune règle paramétrée.
 */
export function noticeMonths(seniorityMonths: number, rules: TerminationRules | null): number | null {
  if (!rules) return null
  return tierFor(rules.noticeMonths, seniorityMonths, (t) => t.upToSeniorityMonths)?.months ?? null
}

export interface SettlementInput {
  monthlyGross: number
  seniorityMonths: number
  departureType: DepartureType
  congesDaysOutstanding: number
  /** Préavis effectué ? Si non (dispense employeur), une indemnité compensatrice est due. */
  noticeServed: boolean
  /** Règles de rupture applicables (tenant > pack pays) ; null = non paramétrées. */
  rules: TerminationRules | null
  /** Préavis saisi au dossier (contrat, convention) : prime sur les règles. */
  noticeMonthsOverride?: number
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
  /** Postes non calculés faute de règles paramétrées (à compléter par la RH). */
  warnings: string[]
}

/**
 * Solde de tout compte indicatif (FCFA entiers). Hypothèses :
 *  - salaire journalier = brut mensuel / 30 ;
 *  - indemnité de congés = jours acquis non pris × salaire journalier ;
 *  - indemnité de préavis (compensatrice) due si départ licenciement / rupture
 *    conventionnelle ET préavis non effectué : noticeMonths × brut ;
 *  - indemnité de licenciement (départ licenciement, ancienneté ≥ 1 an) :
 *    cumul progressif, par année, du taux du palier d'ancienneté × brut
 *    (CI : 30 % années 1–5 / 35 % 6–10 / 40 % au-delà).
 * Préavis et licenciement suivent `rules` : sans règles (pays non paramétré),
 * ces postes restent à 0 avec un avertissement — jamais les règles d'un autre pays.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const monthly = Math.max(0, Math.round(input.monthlyGross))
  const dailyRate = Math.round(monthly / 30)
  const seniorityYears = Math.floor(Math.max(0, input.seniorityMonths) / 12)
  const warnings: string[] = []
  const ruleNotice = noticeMonths(Math.max(0, input.seniorityMonths), input.rules)
  const nm = input.noticeMonthsOverride ?? ruleNotice ?? 0

  const indemniteConges = Math.round(Math.max(0, input.congesDaysOutstanding) * dailyRate)

  let indemnitePreavis = 0
  if (
    (input.departureType === 'licenciement' || input.departureType === 'rupture_conventionnelle') &&
    !input.noticeServed
  ) {
    if (input.noticeMonthsOverride === undefined && ruleNotice === null) {
      warnings.push('Préavis non calculé : aucune règle de préavis paramétrée pour ce pays. Saisissez la durée au dossier ou dans les paramètres.')
    }
    indemnitePreavis = nm * monthly
  }

  let indemniteLicenciement = 0
  if (input.departureType === 'licenciement' && seniorityYears >= 1) {
    if (!input.rules) {
      warnings.push("Indemnité de licenciement non calculée : aucun barème paramétré pour ce pays.")
    } else {
      for (let y = 1; y <= seniorityYears; y++) {
        const rate = tierFor(input.rules.severanceRates, y, (t) => t.upToYear)?.rate ?? 0
        indemniteLicenciement += Math.round(rate * monthly)
      }
    }
  }

  const total = indemniteConges + indemnitePreavis + indemniteLicenciement

  const lines: SettlementLine[] = [
    { key: 'conges', label: 'Indemnité compensatrice de congés', amount: indemniteConges },
    { key: 'preavis', label: 'Indemnité compensatrice de préavis', amount: indemnitePreavis },
    { key: 'licenciement', label: 'Indemnité de licenciement', amount: indemniteLicenciement },
  ]

  return { indemniteConges, indemnitePreavis, indemniteLicenciement, total, noticeMonths: nm, seniorityYears, lines, warnings }
}
