/**
 * Simulateur de paie UEMOA — briques de calcul pures : ancienneté (règle du
 * pack) et heures supplémentaires (majorations du pack). Aucun accès DB.
 */
import type { LegislationPack, SeniorityBonusRule } from './legislation-packs.js'
import { overtimeLabels } from './payroll-engine-ci.js'

export interface SeniorityResult {
  years: number
  months: number
  rate: number
  base: number
  amount: number
  source: 'rule' | 'manual' | 'none'
  confidence: 'confirmed' | 'to_confirm' | null
  legalSource: string | null
}

export type OvertimeElementKey = 'HEURES_SUPP_NORM' | 'HEURES_SUPP_NUIT' | 'HEURES_SUPP_FERIE'

export interface OvertimeLine {
  category: 'weekly' | 'night' | 'sunday' | 'holiday'
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
  const hy = Number(h[1]), hm = Number(h[2])
  const py = Number(p[1]), pm = Number(p[2])
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
  const meta = rule
    ? { confidence: rule.confidence, legalSource: rule.source }
    : { confidence: null, legalSource: null }
  if (override !== undefined) {
    return { years, months, rate: 0, base: 0, amount: override, source: 'manual', ...meta }
  }
  if (!rule) {
    return { years, months, rate: 0, base: 0, amount: 0, source: 'none', ...meta }
  }
  const rate = seniorityRate(rule, years)
  const base = rule.base === 'category_minimum' ? categoryMinimum : baseSalary
  return { years, months, rate, base, amount: Math.round(rate * base), source: 'rule', ...meta }
}

/** Taux horaire = salaire de base ÷ (heures hebdomadaires × 52 ÷ 12), non arrondi. */
export function hourlyRate(baseSalary: number, weeklyHours: number): number {
  return baseSalary / ((weeklyHours * 52) / 12)
}

export function computeOvertime(
  pack: LegislationPack,
  baseSalary: number,
  weeklyHours: number,
  hours: { weekly: number; night: number; sunday: number; holiday: number },
): {
  lines: OvertimeLine[]
  variableElements: { HEURES_SUPP_NORM?: number; HEURES_SUPP_NUIT?: number; HEURES_SUPP_FERIE?: number }
} {
  const rates = pack.leaveRules?.overtimeRates ?? {}
  const labels = overtimeLabels(pack)
  const th = hourlyRate(baseSalary, weeklyHours)
  const spec: Array<{ category: OvertimeLine['category']; element: OvertimeElementKey; label: string }> = [
    { category: 'weekly', element: 'HEURES_SUPP_NORM', label: labels.norm },
    { category: 'night', element: 'HEURES_SUPP_NUIT', label: labels.nuit },
    { category: 'sunday', element: 'HEURES_SUPP_NUIT', label: labels.nuit },
    { category: 'holiday', element: 'HEURES_SUPP_FERIE', label: labels.ferie },
  ]
  const lines: OvertimeLine[] = []
  const variableElements: { HEURES_SUPP_NORM?: number; HEURES_SUPP_NUIT?: number; HEURES_SUPP_FERIE?: number } = {}
  for (const s of spec) {
    const h = hours[s.category]
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
