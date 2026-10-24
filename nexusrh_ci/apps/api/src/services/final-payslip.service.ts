/**
 * Entrées / sorties en cours de mois et bulletin de solde.
 *
 *  - Population d'un lot de paie : salariés actifs + salariés sortis dans le
 *    mois (même archivés à la clôture du dossier de sortie) ; un salarié sorti
 *    avant le mois ou embauché après n'est plus payé.
 *  - Proratisation : seuls les jours ouvrables (lundi–samedi) compris entre la
 *    date d'embauche et la date de sortie sont rémunérés.
 *  - Bulletin de solde : les indemnités du solde de tout compte (congés non
 *    pris, préavis non effectué, licenciement / retraite) sont portées sur le
 *    bulletin du mois de sortie — ou du mois suivant si le solde a été calculé
 *    après la paie de ce mois — puis marquées payées pour ne jamais être
 *    versées deux fois.
 *
 * Date de sortie = employees.exit_date (déclaration CNPS) sinon date de départ
 * du dossier de sortie le plus récent, s'il est soldé / clôturé ou si le départ
 * est prévu à partir du mois payé. Un dossier encore ouvert dont la date est
 * dépassée n'est pas une sortie avérée : le salarié actif reste payé.
 */
import { pool as rawPool } from '../db/pool.js'
import { getWorkingDays, resolveAbsenceForPayroll } from './payroll-absences.service.js'
import {
  resolveAttendanceForPayroll,
  type AttendancePayrollResult, type AttendancePayrollSettings,
} from './attendance-payroll.service.js'
import type { SettlementEarning } from './payroll-engine-ci.js'

export interface PayrollEmployeeRow {
  id: string
  base_salary: string
  marital_status: string
  children_count: number
  mobile_money_provider: string
  mobile_money_phone: string
  payment_method: string | null
  first_name: string
  last_name: string
  cnps_number: string
  nni: string
  hire_date: string | null
  legal_entity_id: string | null
  exit_date: string | null
  offboarding_id: string | null
  departure_type: string | null
  settlement: unknown
}

export interface EmploymentWindow {
  /** Premier et dernier jour rémunérés du mois (YYYY-MM-DD) */
  start: string
  end: string
  /** Jours ouvrables (lundi–samedi) rémunérables dans le mois */
  contractDays: number
  workingDaysMonth: number
  hiredInMonth: boolean
  leavesInMonth: boolean
  /** Date de sortie comprise dans le mois (dernier jour inclus) : bulletin de solde */
  exitsThisMonth: boolean
  /** Sorti avant le mois : bulletin portant uniquement le solde de tout compte */
  settlementOnly: boolean
}

function monthBounds(month: string): { start: string; end: string; year: number; monthNum: number } {
  const [year, monthNum] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, year, monthNum }
}

function isoDay(v: string | Date | null | undefined): string | null {
  if (!v) return null
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v))
  return m ? m[1]! : null
}

function workingDaysBetween(start: string, end: string): number {
  const d = new Date(`${start}T00:00:00Z`)
  const stop = new Date(`${end}T00:00:00Z`)
  let n = 0
  for (; d <= stop; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0) n++
  }
  return n
}

/** Fenêtre d'emploi rémunérée dans le mois. */
export function employmentWindow(
  month: string,
  hireDate: string | Date | null | undefined,
  exitDate: string | Date | null | undefined,
): EmploymentWindow {
  const b = monthBounds(month)
  const workingDaysMonth = getWorkingDays(b.year, b.monthNum)
  const hire = isoDay(hireDate)
  const exit = isoDay(exitDate)
  const hiredInMonth = !!hire && hire > b.start && hire <= b.end
  const leavesInMonth = !!exit && exit >= b.start && exit < b.end
  const start = hire && hire > b.start ? hire : b.start
  const end = exit && exit < b.end ? exit : b.end
  const exitsThisMonth = !!exit && exit >= b.start && exit <= b.end
  const settlementOnly = !!exit && exit < b.start
  const flags = { workingDaysMonth, hiredInMonth, leavesInMonth, exitsThisMonth, settlementOnly }
  if (start > end) return { start, end, contractDays: 0, ...flags }
  const contractDays = hiredInMonth || leavesInMonth
    ? Math.min(workingDaysMonth, workingDaysBetween(start, end))
    : workingDaysMonth
  return { start, end, contractDays, ...flags }
}

/** Jours rémunérés = jours sous contrat − jours d'absence (maternité, AT, maladie). */
export function workedDaysFor(window: EmploymentWindow, absenceDays: number | undefined): number {
  return Math.max(0, window.contractDays - Math.max(0, absenceDays ?? 0))
}

const SETTLEMENT_KEYS = ['conges', 'preavis', 'licenciement'] as const

/**
 * Indemnités du solde de tout compte (offboarding_cases.settlement) → lignes
 * du bulletin. Les montants nuls sont ignorés ; un solde déjà payé sur un
 * autre mois ne produit rien.
 */
export function settlementEarningsFrom(settlement: unknown, month: string): SettlementEarning[] {
  if (!settlement || typeof settlement !== 'object') return []
  const s = settlement as Record<string, unknown>
  if (typeof s.paidInMonth === 'string' && s.paidInMonth !== month) return []
  const amounts: Record<(typeof SETTLEMENT_KEYS)[number], unknown> = {
    conges: s.indemniteConges, preavis: s.indemnitePreavis, licenciement: s.indemniteLicenciement,
  }
  const labels = new Map<string, string>()
  if (Array.isArray(s.lines)) {
    for (const l of s.lines as Array<{ key?: unknown; label?: unknown }>) {
      if (typeof l?.key === 'string' && typeof l.label === 'string') labels.set(l.key, l.label)
    }
  }
  const out: SettlementEarning[] = []
  for (const key of SETTLEMENT_KEYS) {
    const amount = Math.round(Number(amounts[key]) || 0)
    if (amount > 0) out.push({ key, label: labels.get(key) ?? defaultSettlementLabel(key), amount })
  }
  return out
}

function defaultSettlementLabel(key: (typeof SETTLEMENT_KEYS)[number]): string {
  if (key === 'conges') return 'Indemnité compensatrice de congés'
  if (key === 'preavis') return 'Indemnité compensatrice de préavis'
  return 'Indemnité de licenciement'
}

const EMPLOYEE_COLUMNS = `e.id, e.base_salary, e.marital_status, e.children_count,
  e.mobile_money_provider, e.mobile_money_phone, e.payment_method,
  e.first_name, e.last_name, e.cnps_number, e.nni,
  e.hire_date::text AS hire_date, e.legal_entity_id`

/** Mode de paiement porté sur le bulletin : virement, sinon l'opérateur Mobile Money. */
export function slipPaymentMethod(emp: Pick<PayrollEmployeeRow, 'payment_method' | 'mobile_money_provider'>): string {
  if (emp.payment_method === 'bank_transfer') return 'bank_transfer'
  return emp.mobile_money_provider || 'mobile_money'
}

/**
 * Salariés à payer pour un mois (lot de clôture, ou un salarié pour la
 * simulation). Sans table offboarding_cases (schéma non migré) : repli sur la
 * seule date de sortie de la fiche.
 */
export async function loadPayrollPopulation(
  schema: string,
  month: string,
  opts: { legalEntityId?: string | null; employeeId?: string } = {},
): Promise<PayrollEmployeeRow[]> {
  const b = monthBounds(month)
  // Rattrapage d'un solde calculé après la paie du mois de sortie : mois suivant uniquement.
  const prev = monthBounds(previousMonth(month))
  const params: unknown[] = [b.start, b.end, prev.start, month]
  let scope = ''
  if (opts.legalEntityId) { params.push(opts.legalEntityId); scope += ` AND e.legal_entity_id = $${params.length}` }
  if (opts.employeeId) { params.push(opts.employeeId); scope += ` AND e.id = $${params.length}` }

  const exitExpr = `COALESCE(e.exit_date, oc.departure_date)`
  const sql = `
    SELECT ${EMPLOYEE_COLUMNS},
           ${exitExpr}::text AS exit_date,
           oc.id AS offboarding_id, oc.departure_type, oc.settlement
    FROM "${schema}".employees e
    LEFT JOIN LATERAL (
      SELECT o.id, o.departure_date, o.departure_type, o.settlement
      FROM "${schema}".offboarding_cases o
      WHERE o.employee_id = e.id AND o.status <> 'cancelled'
        AND (o.status IN ('settled', 'closed') OR o.departure_date >= $1)
      ORDER BY o.departure_date DESC LIMIT 1
    ) oc ON true
    WHERE (e.hire_date IS NULL OR e.hire_date <= $2)
      AND (
        (e.is_active = true AND e.deleted_at IS NULL AND (${exitExpr} IS NULL OR ${exitExpr} >= $1))
        OR ${exitExpr} BETWEEN $1 AND $2
        OR (${exitExpr} >= $3 AND ${exitExpr} < $1
            AND oc.settlement IS NOT NULL
            AND COALESCE(oc.settlement->>'paidInMonth', $4) = $4)
      )${scope}`
  try {
    const res = await rawPool.query<PayrollEmployeeRow>(sql, params)
    return res.rows
  } catch {
    // Schéma sans offboarding_cases : population historique + date de sortie de la fiche
    const legacyParams: unknown[] = [b.start, b.end]
    let legacyScope = ''
    if (opts.legalEntityId) { legacyParams.push(opts.legalEntityId); legacyScope += ` AND e.legal_entity_id = $${legacyParams.length}` }
    if (opts.employeeId) { legacyParams.push(opts.employeeId); legacyScope += ` AND e.id = $${legacyParams.length}` }
    const res = await rawPool.query<PayrollEmployeeRow>(
      `SELECT ${EMPLOYEE_COLUMNS}, e.exit_date::text AS exit_date,
              NULL::uuid AS offboarding_id, NULL::text AS departure_type, NULL::jsonb AS settlement
       FROM "${schema}".employees e
       WHERE (e.hire_date IS NULL OR e.hire_date <= $2)
         AND ((e.is_active = true AND e.deleted_at IS NULL AND (e.exit_date IS NULL OR e.exit_date >= $1))
              OR e.exit_date BETWEEN $1 AND $2)${legacyScope}`,
      legacyParams,
    )
    return res.rows
  }
}

export function previousMonth(month: string): string {
  const { year, monthNum } = monthBounds(month)
  return monthNum === 1 ? `${year - 1}-12` : `${year}-${String(monthNum - 1).padStart(2, '0')}`
}

/** Le solde porté sur un bulletin est marqué payé (jamais versé deux fois). */
export async function markSettlementPaid(
  schema: string, offboardingId: string, month: string, paySlipId: string | null,
): Promise<void> {
  await rawPool.query(
    `UPDATE "${schema}".offboarding_cases
        SET settlement = settlement || jsonb_build_object('paidInMonth', $2::text, 'paySlipId', $3::text),
            updated_at = now()
      WHERE id = $1 AND settlement IS NOT NULL`,
    [offboardingId, month, paySlipId],
  ).catch(() => undefined)
}

export interface EmployeeMonthInputs {
  window: EmploymentWindow
  /** Jours rémunérés (prorata entrée / sortie, moins les absences) */
  workedDays: number
  absenceCtx: Awaited<ReturnType<typeof resolveAbsenceForPayroll>>
  attendance: AttendancePayrollResult | null
  settlementEarnings: SettlementEarning[]
}

/**
 * Entrées du moteur pour un salarié et un mois : fenêtre d'emploi, absences,
 * pointage (borné aux jours sous contrat) et, au mois de sortie, solde de tout
 * compte. Partagé par la simulation et les deux lots de clôture.
 */
export async function resolveEmployeeMonth(
  schema: string,
  emp: Pick<PayrollEmployeeRow, 'id' | 'base_salary' | 'hire_date'> & Partial<Pick<PayrollEmployeeRow, 'exit_date' | 'settlement'>>,
  month: string,
  attendanceSettings: AttendancePayrollSettings | null,
): Promise<EmployeeMonthInputs> {
  const window = employmentWindow(month, emp.hire_date, emp.exit_date ?? null)
  const settlementEarnings = window.exitsThisMonth || window.settlementOnly
    ? settlementEarningsFrom(emp.settlement, month) : []
  if (window.contractDays === 0) {
    return { window, workedDays: 0, absenceCtx: null, attendance: null, settlementEarnings }
  }
  const absenceCtx = await resolveAbsenceForPayroll(schema, emp.id, month, emp.hire_date)
  const partial = window.hiredInMonth || window.leavesInMonth
  const attendance = await resolveAttendanceForPayroll(
    attendanceSettings, schema, emp.id, month, parseInt(emp.base_salary, 10), window.workingDaysMonth,
    partial ? { start: window.start, end: window.end } : undefined)
  return {
    window,
    workedDays: workedDaysFor(window, absenceCtx?.absenceDays),
    absenceCtx, attendance, settlementEarnings,
  }
}
