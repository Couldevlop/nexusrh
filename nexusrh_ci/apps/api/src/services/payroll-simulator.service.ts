/**
 * Simulateur de paie UEMOA — briques de calcul pures : ancienneté (règle du
 * pack) et heures supplémentaires (majorations du pack). Aucun accès DB.
 */
import type { LegislationPack, SeniorityBonusRule } from './legislation-packs.js'
import { overtimeLabels } from './payroll-engine-ci.js'

export interface SeniorityRuleOutcome {
  rate: number
  base: number
  amount: number
  confidence: 'confirmed' | 'to_confirm'
  legalSource: string
}

export interface SeniorityResult {
  years: number
  months: number
  /** Origine du montant retenu. */
  source: 'rule' | 'manual' | 'none'
  /** Montant retenu. */
  amount: number
  /** Ce que donne la règle du pack (null si le pack n'en a pas), même en saisie manuelle. */
  rule: SeniorityRuleOutcome | null
}

export type OvertimeElementKey =
  | 'HEURES_SUPP_NORM' | 'HEURES_SUPP_47' | 'HEURES_SUPP_NUIT' | 'HEURES_SUPP_DIM' | 'HEURES_SUPP_FERIE'

export type OvertimeCategory = 'weekly' | 'weeklyBeyond' | 'night' | 'sunday' | 'holiday' | 'sundayHolidayNight'

/** Heures supplémentaires du mois par catégorie (les catégories CI optionnelles valent 0 si absentes). */
export interface OvertimeHours {
  weekly: number
  /** Au-delà de `weeklyBeyondFromHour` − 1 (CI : au-delà de la 46e heure) */
  weeklyBeyond?: number
  night: number
  /** Dimanche (de jour si le pack distingue la nuit des dimanches / fériés) */
  sunday: number
  /** Jour férié (de jour si le pack distingue la nuit des dimanches / fériés) */
  holiday: number
  /** Nuit des dimanches et jours fériés */
  sundayHolidayNight?: number
}

export interface OvertimeLine {
  category: OvertimeCategory
  element: OvertimeElementKey
  label: string
  hours: number
  majoration: number
  hourlyRate: number
  amount: number
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/

/** Années et mois révolus entre l'embauche et le dernier jour du mois de paie. */
export function completedYears(hireDate: string, payMonth: string): { years: number; months: number } {
  const h = DATE_RE.exec(hireDate)
  const p = MONTH_RE.exec(payMonth)
  if (!h || !p) throw new RangeError('Format de date invalide (attendu AAAA-MM-JJ / AAAA-MM)')
  const hy = Number(h[1]), hm = Number(h[2]), hd = Number(h[3])
  const py = Number(p[1]), pm = Number(p[2])
  if (pm < 1 || pm > 12 || hm < 1 || hm > 12) throw new RangeError('Mois invalide (attendu 1 à 12)')
  if (hd < 1 || hd > new Date(Date.UTC(hy, hm, 0)).getUTCDate()) {
    throw new RangeError("Date d'embauche inexistante")
  }
  // Évalué au dernier jour du mois de paie : le jour anniversaire est toujours
  // atteint (un 29 février en année non bissextile compte le 28), donc seul
  // l'écart de mois civils compte.
  const total = (py - hy) * 12 + (pm - hm)
  if (total < 0) {
    throw new RangeError("La date d'embauche est postérieure à la fin du mois de paie")
  }
  return { years: Math.floor(total / 12), months: total % 12 }
}

/** Taux d'ancienneté pour un nombre d'années révolues. */
export function seniorityRate(rule: SeniorityBonusRule, years: number): number {
  const steps = rule.steps
  let idx = -1
  for (let i = 0; i < steps.length; i++) {
    if (years >= steps[i]!.years) idx = i
  }
  if (idx < 0) return 0
  const step = steps[idx]!
  let rate = step.rate
  if (idx === steps.length - 1) rate += rule.incrementPerYear * (years - step.years)
  if (rule.maxRate !== null) rate = Math.min(rate, rule.maxRate)
  return Math.round(rate * 10000) / 10000
}

export function computeSeniority(input: {
  pack: LegislationPack
  hireDate: string
  payMonth: string
  baseSalary: number
  categoryMinimum: number
  override?: number
}): SeniorityResult {
  const { pack, baseSalary, categoryMinimum, override } = input
  const { years, months } = completedYears(input.hireDate, input.payMonth)
  const rule = pack.seniorityBonus
  let outcome: SeniorityRuleOutcome | null = null
  if (rule) {
    const rate = seniorityRate(rule, years)
    const base = rule.base === 'category_minimum' ? categoryMinimum : baseSalary
    outcome = {
      rate, base, amount: Math.round(rate * base),
      confidence: rule.confidence, legalSource: rule.source,
    }
  }
  if (override !== undefined) return { years, months, source: 'manual', amount: override, rule: outcome }
  if (!outcome) return { years, months, source: 'none', amount: 0, rule: null }
  return { years, months, source: 'rule', amount: outcome.amount, rule: outcome }
}

/** Taux horaire = salaire de base ÷ (heures hebdomadaires × 52 ÷ 12), non arrondi. */
export function hourlyRate(baseSalary: number, weeklyHours: number): number {
  return baseSalary / ((weeklyHours * 52) / 12)
}

/**
 * Heures supplémentaires → éléments variables du moteur.
 *
 * Pack à nuit de dimanche / férié distincte (`sundayHolidayNight`, CI : décret
 * n° 2024-898 art. 25) : dimanche et férié de jour → HEURES_SUPP_DIM, nuit des
 * dimanches / fériés → HEURES_SUPP_FERIE. Sinon (autres packs, inchangé) :
 * dimanche → HEURES_SUPP_NUIT, férié → HEURES_SUPP_FERIE. Les heures au-delà du
 * seuil hebdomadaire vont dans HEURES_SUPP_47. Heures saisies pour une
 * majoration absente du pack → erreur.
 */
export function computeOvertime(
  pack: LegislationPack,
  baseSalary: number,
  weeklyHours: number,
  hours: OvertimeHours,
): {
  lines: OvertimeLine[]
  variableElements: Partial<Record<OvertimeElementKey, number>>
} {
  const rates = pack.leaveRules?.overtimeRates ?? {}
  const labels = overtimeLabels(pack)
  const th = hourlyRate(baseSalary, weeklyHours)
  const splitSundayHolidayNight = rates.sundayHolidayNight !== undefined
  const spec: Array<{ category: OvertimeCategory; element: OvertimeElementKey; label: string }> = [
    { category: 'weekly', element: 'HEURES_SUPP_NORM', label: labels.norm },
    { category: 'weeklyBeyond', element: 'HEURES_SUPP_47', label: labels.beyond },
    { category: 'night', element: 'HEURES_SUPP_NUIT', label: labels.nuit },
    splitSundayHolidayNight
      ? { category: 'sunday', element: 'HEURES_SUPP_DIM', label: labels.dim }
      : { category: 'sunday', element: 'HEURES_SUPP_NUIT', label: labels.nuit },
    splitSundayHolidayNight
      ? { category: 'holiday', element: 'HEURES_SUPP_DIM', label: labels.dim }
      : { category: 'holiday', element: 'HEURES_SUPP_FERIE', label: labels.ferie },
    { category: 'sundayHolidayNight', element: 'HEURES_SUPP_FERIE', label: labels.ferie },
  ]
  const lines: OvertimeLine[] = []
  const variableElements: Partial<Record<OvertimeElementKey, number>> = {}
  for (const s of spec) {
    const h = hours[s.category] ?? 0
    if (!(h > 0)) continue
    const majoration = rates[s.category]
    if (majoration === undefined) {
      throw new Error(`Majoration « ${s.category} » non paramétrée dans le pack ${pack.code}`)
    }
    const amount = Math.round(h * th * (1 + majoration))
    lines.push({ category: s.category, element: s.element, label: s.label, hours: h, majoration, hourlyRate: th, amount })
    variableElements[s.element] = (variableElements[s.element] ?? 0) + amount
  }
  return { lines, variableElements }
}
