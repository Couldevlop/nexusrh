/**
 * Durée d'une demande d'absence et règles du congé de maternité.
 *
 * - Le décompte suit le mode du type d'absence (`absence_types.calculation_mode`,
 *   paramétrable) : jours ouvrables (lundi–samedi en CI, hors jours fériés)
 *   ou jours calendaires (maternité, maladie…).
 * - Maternité : durée légale du pack du pays de l'employée (CI, CT art. 23.6 :
 *   14 semaines consécutives dont 6 avant et 8 après l'accouchement ; +2
 *   semaines en cas de naissance multiple ; +3 semaines en cas de maladie
 *   résultant de la grossesse ou des couches ; prolongation de la durée
 *   d'hospitalisation de l'enfant, 12 mois au plus).
 *
 * Lectures tolérantes : si le type ou le pack est illisible, le décompte
 * retombe sur les jours ouvrables (comportement historique), sans erreur.
 */
import { joursFeriesCI } from '@nexusrhci/shared/ci-holidays'
import type { LeaveRules } from './legislation-packs.js'
import { loadEmployeeTenantContext } from './employee-tenant-context.service.js'

interface Queryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export type CalculationMode = 'working_days' | 'calendar_days'

function parts(d: string): [number, number, number] {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  return [y, m, day]
}

/** Jours d'absence entre deux dates incluses (YYYY-MM-DD). */
export function countAbsenceDays(
  startDate: string, endDate: string, mode: CalculationMode, workingDaysPerWeek: 5 | 6 = 6,
): number {
  const [sy, sm, sd] = parts(startDate)
  const [ey, em, ed] = parts(endDate)
  const start = Date.UTC(sy, sm - 1, sd)
  const end = Date.UTC(ey, em - 1, ed)
  if (end < start) return 0
  if (mode === 'calendar_days') return Math.round((end - start) / 86_400_000) + 1
  const feries = new Set<string>()
  for (let y = sy; y <= ey; y++) for (const f of joursFeriesCI(y)) feries.add(f)
  let days = 0
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t)
    const dow = d.getUTCDay()
    const ymd = d.toISOString().slice(0, 10)
    if (dow === 0 || (workingDaysPerWeek === 5 && dow === 6) || feries.has(ymd)) continue
    days++
  }
  return days
}

export function isMaternityCode(code: string | null | undefined): boolean {
  return (code ?? '').toLowerCase().includes('maternit')
}

export interface MaternityOptions {
  multipleBirth?: boolean
  illnessExtension?: boolean
  /** Jours d'hospitalisation de l'enfant (prolongation du post-natal) */
  childHospitalizedDays?: number
}

export interface MaternityRule {
  /** Durée légale de base, en jours calendaires */
  legalDays: number
  beforeDays: number | null
  afterDays: number | null
  multipleBirthDays: number
  illnessDays: number
  maxHospitalizationDays: number
}

export function maternityRule(rules: LeaveRules | undefined): MaternityRule | null {
  if (!rules || !(rules.maternityWeeks > 0)) return null
  return {
    legalDays: rules.maternityWeeks * 7,
    beforeDays: rules.maternitySplit ? rules.maternitySplit.before * 7 : null,
    afterDays: rules.maternitySplit ? rules.maternitySplit.after * 7 : null,
    multipleBirthDays: (rules.maternityExtensions?.multipleBirthWeeks ?? 0) * 7,
    illnessDays: (rules.maternityExtensions?.illnessWeeks ?? 0) * 7,
    maxHospitalizationDays: rules.maternityExtensions?.maxChildHospitalizationDays ?? 0,
  }
}

/** Durée maximale autorisée selon les cas de prolongation déclarés. */
export function maternityAllowedDays(rule: MaternityRule, opts: MaternityOptions = {}): number {
  const hosp = Math.min(Math.max(0, Math.floor(opts.childHospitalizedDays ?? 0)), rule.maxHospitalizationDays)
  return rule.legalDays
    + (opts.multipleBirth ? rule.multipleBirthDays : 0)
    + (opts.illnessExtension ? rule.illnessDays : 0)
    + hosp
}

export interface MaternityCheck {
  ok: boolean
  allowedDays: number
  legalDays: number
  /** Refus (durée au-delà du maximum légal) */
  error?: string
  /** Information non bloquante (durée inférieure au congé légal) */
  warning?: string
}

export function checkMaternityDuration(calendarDays: number, rule: MaternityRule, opts: MaternityOptions = {}): MaternityCheck {
  const allowedDays = maternityAllowedDays(rule, opts)
  const weeks = (n: number) => Math.round(n / 7 * 10) / 10
  if (calendarDays > allowedDays) {
    return {
      ok: false, allowedDays, legalDays: rule.legalDays,
      error: `Congé de maternité de ${calendarDays} jours : au-delà de la durée légale (${allowedDays} jours, soit ${weeks(allowedDays)} semaines). Déclarez la prolongation applicable (naissance multiple, maladie liée à la grossesse, hospitalisation de l'enfant).`,
    }
  }
  if (calendarDays < rule.legalDays) {
    return {
      ok: true, allowedDays, legalDays: rule.legalDays,
      warning: `Congé de maternité de ${calendarDays} jours, inférieur à la durée légale de ${rule.legalDays} jours (${weeks(rule.legalDays)} semaines)${rule.afterDays ? ` ; les ${weeks(rule.afterDays)} semaines après l'accouchement restent acquises` : ''}.`,
    }
  }
  return { ok: true, allowedDays, legalDays: rule.legalDays }
}

export interface AbsenceRequestRules {
  code: string | null
  mode: CalculationMode
  days: number
  maternity: MaternityCheck | null
}

/**
 * Décompte d'une demande selon son type + contrôle maternité. Ne lève jamais :
 * type illisible → jours ouvrables, sans contrôle.
 */
export async function resolveAbsenceRequest(
  db: Queryable, schema: string, employeeId: string, absenceTypeId: string,
  startDate: string, endDate: string, maternityOpts: MaternityOptions = {},
): Promise<AbsenceRequestRules> {
  let code: string | null = null
  let mode: CalculationMode = 'working_days'
  try {
    const t = await db.query<{ code: string; calculation_mode: string | null }>(
      `SELECT code, calculation_mode FROM "${schema}".absence_types WHERE id = $1 LIMIT 1`, [absenceTypeId],
    )
    code = t?.rows?.[0]?.code ?? null
    if (t?.rows?.[0]?.calculation_mode === 'calendar_days') mode = 'calendar_days'
  } catch { /* type illisible : jours ouvrables */ }

  let rules: LeaveRules | undefined
  let maternity: MaternityCheck | null = null
  if (isMaternityCode(code)) {
    try {
      const e = await db.query<{ legal_entity_id: string | null }>(
        `SELECT legal_entity_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
      )
      const ctx = await loadEmployeeTenantContext(db, schema, e?.rows?.[0]?.legal_entity_id ?? null)
      rules = ctx.legislation.legislationPack.leaveRules
    } catch { /* pack illisible : pas de contrôle */ }
    const rule = maternityRule(rules)
    // La maternité se compte toujours en jours calendaires (semaines consécutives).
    mode = 'calendar_days'
    if (rule) maternity = checkMaternityDuration(countAbsenceDays(startDate, endDate, 'calendar_days'), rule, maternityOpts)
  }
  const days = countAbsenceDays(startDate, endDate, mode, rules?.workingDaysPerWeek ?? 6)
  return { code, mode, days, maternity }
}