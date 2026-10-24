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

import type { PayBasis, TerminationRules } from '../../services/legislation-packs.js'
import { resolveNotice, severanceAmount } from '../../services/termination-rules.service.js'

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
 * Durée de préavis (mois) selon l'ancienneté, la catégorie et le mode de paie,
 * d'après les règles du pays (ou de la convention du tenant). Sans catégorie
 * connue : barème par défaut (CI : payés au mois, catégories 1 à 5).
 * null = aucune règle paramétrée.
 */
export function noticeMonths(
  seniorityMonths: number,
  rules: TerminationRules | null,
  employee: { categoryLevel?: number | null; payBasis?: PayBasis } = {},
): number | null {
  return resolveNotice(rules, {
    seniorityMonths,
    categoryLevel: employee.categoryLevel ?? null,
    payBasis: employee.payBasis ?? 'monthly',
  })?.months ?? null
}

/** Départs ouvrant droit à l'indemnité (licenciement ; retraite : décret 2017-210 art. 5). */
const SEVERANCE_LABELS: Partial<Record<DepartureType, string>> = {
  licenciement: 'Indemnité de licenciement',
  retraite: 'Indemnité de départ à la retraite',
}

export interface SettlementInput {
  monthlyGross: number
  seniorityMonths: number
  departureType: DepartureType
  congesDaysOutstanding: number
  /** Indemnité compensatrice de congés déjà chiffrée (paid-leave.service) ; défaut : jours × brut / 30. */
  indemniteCongesAmount?: number
  /** Préavis effectué ? Si non (dispense employeur), une indemnité compensatrice est due. */
  noticeServed: boolean
  /** Règles de rupture applicables (tenant > pack pays) ; null = non paramétrées. */
  rules: TerminationRules | null
  /** Préavis saisi au dossier (contrat, convention) : prime sur les règles. */
  noticeMonthsOverride?: number
  /** Niveau de catégorie professionnelle (categoryLevel) ; null = inconnu. */
  categoryLevel?: number | null
  /** Mode de paie ; défaut : payé au mois. */
  payBasis?: PayBasis
  /** Salaire global mensuel moyen des 12 derniers mois (assiette de l'indemnité) ; défaut : brut mensuel. */
  averageMonthlyGross?: number
  /** Règles légales du pays : le préavis de la convention ne peut leur être inférieur. */
  legalRules?: TerminationRules | null
}

export interface SettlementLine { key: string; label: string; amount: number }
export interface Settlement {
  indemniteConges: number
  indemnitePreavis: number
  indemniteLicenciement: number
  total: number
  noticeMonths: number
  /** Ligne de catégorie appliquée au préavis (null = barème par défaut ou durée saisie). */
  noticeCategory: string | null
  seniorityYears: number
  /** Assiette de l'indemnité (salaire mensuel moyen). */
  severanceBase: number
  lines: SettlementLine[]
  /** Postes non calculés ou hypothèses à vérifier par la RH. */
  warnings: string[]
}

/**
 * Solde de tout compte indicatif (montants entiers). Hypothèses :
 *  - salaire journalier = brut mensuel / 30 ;
 *  - indemnité de congés = jours acquis non pris × salaire journalier ;
 *  - indemnité de préavis (compensatrice) due si départ licenciement / rupture
 *    conventionnelle ET préavis non effectué : durée × brut ; la durée dépend
 *    de l'ancienneté, de la catégorie et du mode de paie ;
 *  - indemnité de licenciement / de départ à la retraite (ancienneté ≥ seuil,
 *    CI : 1 an) : cumul progressif du taux du palier × salaire mensuel moyen
 *    des 12 derniers mois, fractions d'année comprises
 *    (CI : 30 % années 1–5 / 35 % 6–10 / 40 % au-delà).
 * Préavis et indemnité suivent `rules` : sans règles (pays non paramétré),
 * ces postes restent à 0 avec un avertissement — jamais les règles d'un autre pays.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const monthly = Math.max(0, Math.round(input.monthlyGross))
  const dailyRate = Math.round(monthly / 30)
  const seniority = Math.max(0, input.seniorityMonths)
  const seniorityYears = Math.floor(seniority / 12)
  const severanceBase = Math.max(0, Math.round(input.averageMonthlyGross ?? monthly))
  const warnings: string[] = []
  const employee = {
    seniorityMonths: seniority,
    categoryLevel: input.categoryLevel ?? null,
    payBasis: input.payBasis ?? 'monthly',
  }
  const notice = resolveNotice(input.rules, employee)
  const nm = input.noticeMonthsOverride ?? notice?.months ?? 0

  const indemniteConges = input.indemniteCongesAmount !== undefined
    ? Math.max(0, Math.round(input.indemniteCongesAmount))
    : Math.round(Math.max(0, input.congesDaysOutstanding) * dailyRate)

  let indemnitePreavis = 0
  if (
    (input.departureType === 'licenciement' || input.departureType === 'rupture_conventionnelle') &&
    !input.noticeServed
  ) {
    if (input.noticeMonthsOverride === undefined) {
      if (!notice) {
        warnings.push('Préavis non calculé : aucune règle de préavis paramétrée pour ce pays. Saisissez la durée au dossier ou dans les paramètres.')
      } else if (notice.categoryUnknown) {
        warnings.push('Catégorie professionnelle non renseignée au dossier : préavis calculé sur le barème par défaut (le préavis d\'un agent de maîtrise ou d\'un cadre est plus long).')
      }
    }
    const legal = resolveNotice(input.legalRules ?? null, employee)
    if (legal && nm < legal.months) {
      warnings.push(`Préavis retenu (${formatMonths(nm)}) inférieur au minimum légal (${formatMonths(legal.months)}) : seule une durée plus favorable au salarié est permise.`)
    }
    indemnitePreavis = Math.round(nm * monthly)
  }

  let indemniteLicenciement = 0
  const severanceLabel = SEVERANCE_LABELS[input.departureType]
  if (severanceLabel) {
    if (!input.rules) {
      if (seniorityYears >= 1) warnings.push('Indemnité de licenciement non calculée : aucun barème paramétré pour ce pays.')
    } else if (seniority >= (input.rules.severanceMinSeniorityMonths ?? 12)) {
      indemniteLicenciement = severanceAmount(seniority, severanceBase, input.rules)
    }
  }

  const total = indemniteConges + indemnitePreavis + indemniteLicenciement

  const lines: SettlementLine[] = [
    { key: 'conges', label: 'Indemnité compensatrice de congés', amount: indemniteConges },
    { key: 'preavis', label: 'Indemnité compensatrice de préavis', amount: indemnitePreavis },
    { key: 'licenciement', label: severanceLabel ?? 'Indemnité de licenciement', amount: indemniteLicenciement },
  ]

  return {
    indemniteConges, indemnitePreavis, indemniteLicenciement, total,
    noticeMonths: Math.round(nm * 100) / 100,
    noticeCategory: notice && input.noticeMonthsOverride === undefined ? notice.category?.label ?? null : null,
    seniorityYears, severanceBase, lines, warnings,
  }
}

/** « 1 mois », « 15 jours », « 2,5 mois ». */
function formatMonths(m: number): string {
  if (m > 0 && m < 1) return `${Math.round(m * 30)} jours`
  return `${String(Math.round(m * 100) / 100).replace('.', ',')} mois`
}
