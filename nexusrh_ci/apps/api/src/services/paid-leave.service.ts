/**
 * Congés payés : acquisition, solde et allocation de congé.
 *
 * Règles du pays dans le pack (`leaveRules`), surcharge du tenant
 * (`platform.tenants.leave_policy`, convention ou usage plus favorable).
 *
 * Côte d'Ivoire :
 *  - acquisition 2,2 jours ouvrables par mois de service effectif (CT art. 25.1,
 *    CCI art. 69) + jours d'ancienneté (CT art. 25.2 : 1 j après 5 ans, 2 après
 *    10, 3 après 15, 5 après 20, 7 après 25, 8 après 30) ;
 *  - allocation : salaire mensuel moyen des 12 derniers mois (hors
 *    remboursements de frais : transport, panier) ÷ 30 × jours CALENDAIRES de
 *    congé (CCI art. 71) ; jours calendaires = jours ouvrables × 1,25 (usage) ;
 *    le décret 98-39 art. 12 fixe aussi 1/12 de la rémunération totale de la
 *    période de référence, et l'allocation est au moins égale au salaire
 *    maintenu (CT art. 25.7) : par défaut on retient le plus favorable.
 *
 * Le solde est tenu dans `absence_balances` (année civile) : `acquired` est
 * recalculé à la lecture selon l'ancienneté acquise à date (acquisition
 * mensuelle), `taken`/`pending` restent alimentés par le circuit d'absences.
 * Toute lecture qui échoue retombe sur le solde stocké, jamais sur une erreur.
 */
import { z } from 'zod'
import type { LeaveAllowanceMethod, LeaveRules } from './legislation-packs.js'
import { loadEmployeeTenantContext } from './employee-tenant-context.service.js'

interface Queryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

const seniorityTiersSchema = z.array(z.object({
  minYears: z.number().int().min(0).max(60),
  days: z.number().min(0).max(30),
}).strict()).max(12)

/** Surcharge tenant : chaque champ absent reprend la règle du pays. */
export const leavePolicySchema = z.object({
  /** monthly = acquisition recalculée chaque mois ; manual = soldes saisis par la RH */
  accrualMode: z.enum(['monthly', 'manual']).optional(),
  /** Jours ouvrables acquis par mois (convention plus favorable) */
  daysPerMonth: z.number().min(0).max(5).nullable().optional(),
  seniorityDays: seniorityTiersSchema.nullable().optional(),
  calendarDaysPerWorkingDay: z.number().min(1).max(2).nullable().optional(),
  allowanceMethod: z.enum(['most_favourable', 'average_calendar', 'one_twelfth']).nullable().optional(),
  /** Reporter le reliquat de l'année précédente */
  carryOver: z.boolean().optional(),
  /** Contrôle du solde à la demande de congé */
  balanceCheck: z.enum(['block', 'warn', 'off']).optional(),
  /** Jours pouvant être pris par anticipation au-delà du solde */
  maxAdvanceDays: z.number().min(0).max(60).optional(),
  /** Code du type d'absence « congés payés » */
  leaveTypeCode: z.string().trim().min(1).max(20).optional(),
}).strict()

export type LeavePolicyOverride = z.infer<typeof leavePolicySchema>

export interface EffectiveLeavePolicy {
  accrualMode: 'monthly' | 'manual'
  daysPerMonth: number
  seniorityDays: Array<{ minYears: number; days: number }>
  calendarDaysPerWorkingDay: number
  allowanceMethod: LeaveAllowanceMethod
  carryOver: boolean
  balanceCheck: 'block' | 'warn' | 'off'
  maxAdvanceDays: number
  leaveTypeCode: string
  /** Minimum légal du pays (contrôle de la surcharge tenant) */
  legalDaysPerMonth: number | null
}

/** Lecture tolérante de la surcharge en base : invalide ou absente → {}. */
export function parseLeavePolicy(raw: unknown): LeavePolicyOverride {
  const parsed = leavePolicySchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : {}
}

export function effectiveLeavePolicy(pack: LeaveRules | undefined, tenantRaw: unknown): EffectiveLeavePolicy {
  const t = parseLeavePolicy(tenantRaw)
  return {
    accrualMode: t.accrualMode ?? 'monthly',
    daysPerMonth: t.daysPerMonth ?? pack?.annualLeaveDaysPerMonth ?? 0,
    seniorityDays: t.seniorityDays ?? pack?.annualLeaveSeniorityDays ?? [],
    calendarDaysPerWorkingDay: t.calendarDaysPerWorkingDay ?? pack?.leaveAllowance?.calendarDaysPerWorkingDay ?? 1,
    allowanceMethod: t.allowanceMethod ?? pack?.leaveAllowance?.method ?? 'most_favourable',
    carryOver: t.carryOver ?? true,
    balanceCheck: t.balanceCheck ?? 'block',
    maxAdvanceDays: t.maxAdvanceDays ?? 0,
    leaveTypeCode: t.leaveTypeCode ?? 'CP',
    legalDaysPerMonth: pack?.annualLeaveDaysPerMonth ?? null,
  }
}

function ymd(d: string | Date): [number, number, number] {
  if (typeof d === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const x = new Date(d)
  return [x.getFullYear(), x.getMonth() + 1, x.getDate()]
}

/** Mois entiers écoulés de `from` (inclus) à `to` (exclu). */
function fullMonths(from: [number, number, number], to: [number, number, number]): number {
  let m = (to[0] - from[0]) * 12 + (to[1] - from[1])
  if (to[2] < from[2]) m -= 1
  return Math.max(0, m)
}

function nextDay(d: [number, number, number]): [number, number, number] {
  const x = new Date(Date.UTC(d[0], d[1] - 1, d[2] + 1))
  return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** Mois de service accomplis dans l'année civile, à la date `asOf`. */
export function monthsServedInYear(hireDate: string | Date | null, year: number, asOf: string | Date): number {
  const jan1: [number, number, number] = [year, 1, 1]
  const hire = hireDate ? ymd(hireDate) : jan1
  const start = cmp(hire, jan1) > 0 ? hire : jan1
  const as = ymd(asOf)
  const dec31: [number, number, number] = [year, 12, 31]
  const end = cmp(as, dec31) < 0 ? as : dec31
  if (cmp(end, start) < 0) return 0
  return Math.min(12, fullMonths(start, nextDay(end)))
}

/** Années complètes d'ancienneté à une date. */
export function seniorityYearsAt(hireDate: string | Date | null, asOf: string | Date): number {
  if (!hireDate) return 0
  return Math.floor(fullMonths(ymd(hireDate), ymd(asOf)) / 12)
}

function ceil1(x: number): number {
  return Math.ceil(Math.round(x * 1000) / 100) / 10
}

/** Jours ouvrables acquis dans l'année à `asOf` (principal + ancienneté au prorata). */
export function accruedPaidLeaveDays(
  policy: Pick<EffectiveLeavePolicy, 'daysPerMonth' | 'seniorityDays'>,
  hireDate: string | Date | null,
  year: number,
  asOf: string | Date,
): { months: number; principal: number; seniority: number; total: number } {
  const months = monthsServedInYear(hireDate, year, asOf)
  const years = seniorityYearsAt(hireDate, asOf)
  const tier = [...policy.seniorityDays].sort((a, b) => b.minYears - a.minYears).find((t) => years >= t.minYears)
  const principal = policy.daysPerMonth * months
  const seniority = (tier?.days ?? 0) * months / 12
  return { months, principal: ceil1(principal), seniority: ceil1(seniority), total: ceil1(principal + seniority) }
}

export interface PaidLeaveAllowanceInput {
  /** Jours ouvrables de congé */
  days: number
  /** Salaire mensuel moyen des 12 derniers mois, hors remboursements de frais */
  averageMonthlyExclFrais: number
  /** Rémunération mensuelle moyenne totale (base du 1/12) */
  averageMonthlyTotal: number
  /** Salaire mensuel actuel (allocation au moins égale au salaire maintenu) */
  currentMonthly: number
  policy: Pick<EffectiveLeavePolicy, 'daysPerMonth' | 'calendarDaysPerWorkingDay' | 'allowanceMethod'>
}

export interface PaidLeaveAllowance {
  amount: number
  method: 'average_calendar' | 'one_twelfth' | 'maintained_salary'
  calendarDays: number
  candidates: { average_calendar: number; one_twelfth: number; maintained_salary: number }
}

/** Allocation (ou indemnité compensatrice) de congés pour `days` jours ouvrables. */
export function paidLeaveAllowance(input: PaidLeaveAllowanceInput): PaidLeaveAllowance {
  const days = Math.max(0, input.days)
  const calendarDays = Math.round(days * input.policy.calendarDaysPerWorkingDay * 100) / 100
  const candidates = {
    average_calendar: Math.round(Math.max(0, input.averageMonthlyExclFrais) / 30 * calendarDays),
    one_twelfth: input.policy.daysPerMonth > 0
      ? Math.round(Math.max(0, input.averageMonthlyTotal) / (12 * input.policy.daysPerMonth) * days)
      : 0,
    maintained_salary: Math.round(Math.max(0, input.currentMonthly) / 30 * calendarDays),
  }
  const allowed: Array<keyof typeof candidates> =
    input.policy.allowanceMethod === 'average_calendar' ? ['average_calendar', 'maintained_salary']
      : input.policy.allowanceMethod === 'one_twelfth' ? ['one_twelfth', 'maintained_salary']
        : ['average_calendar', 'one_twelfth', 'maintained_salary']
  let method = allowed[0]!
  for (const k of allowed) if (candidates[k] > candidates[method]) method = k
  return { amount: candidates[method], method, calendarDays, candidates }
}

/**
 * Codes de ligne exclus de l'assiette CCI : remboursements de frais,
 * l'allocation elle-même et les indemnités du bulletin de solde.
 */
const EXCLUDED_FROM_ALLOWANCE = new Set(['1300', '1600', '1610', '1620', '1630'])

/**
 * Indemnités de rupture portées par le bulletin de solde (congés, préavis,
 * licenciement). Exclues des DEUX moyennes : elles sont calculées à partir de
 * ces moyennes, les y compter ferait gonfler le solde à chaque recalcul.
 */
const SETTLEMENT_LINES = new Set(['1610', '1620', '1630'])

/**
 * Moyennes mensuelles des 12 derniers bulletins jusqu'au mois `month` inclus,
 * hors indemnités de rupture (`total` : rémunération globale, assiette de
 * l'indemnité de licenciement ; `exclFrais` : assiette CCI des congés).
 * null = aucun bulletin (l'appelant retombe sur le salaire de base).
 */
export async function averageRemuneration(
  db: Queryable, schema: string, employeeId: string, month: string,
): Promise<{ total: number; exclFrais: number; months: number } | null> {
  try {
    const res = await db.query<{ gross_salary: string | number; lines: unknown }>(
      `SELECT gross_salary, lines FROM "${schema}".pay_slips
       WHERE employee_id = $1 AND month <= $2 ORDER BY month DESC LIMIT 12`,
      [employeeId, month],
    )
    const rows = res?.rows ?? []
    if (rows.length === 0) return null
    let total = 0
    let excl = 0
    for (const r of rows) {
      const gross = Number(r.gross_salary) || 0
      let lines: Array<{ code?: string; amount?: number }> = []
      try { lines = Array.isArray(r.lines) ? r.lines as typeof lines : JSON.parse(String(r.lines ?? '[]')) } catch { lines = [] }
      const sumOf = (codes: Set<string>): number =>
        lines.filter((l) => l && codes.has(String(l.code))).reduce((s, l) => s + (Number(l.amount) || 0), 0)
      total += Math.max(0, gross - sumOf(SETTLEMENT_LINES))
      excl += Math.max(0, gross - sumOf(EXCLUDED_FROM_ALLOWANCE))
    }
    return { total: Math.round(total / rows.length), exclFrais: Math.round(excl / rows.length), months: rows.length }
  } catch {
    return null
  }
}

export interface PaidLeaveBalance {
  year: number
  mode: 'monthly' | 'manual'
  /** Acquis de l'année à date (acquisition mensuelle) */
  accrued: number
  carriedOver: number
  acquired: number
  taken: number
  pending: number
  remaining: number
  monthsServed: number
}

/** Type d'absence « congés payés » du tenant (null = aucun). */
export async function paidLeaveTypeId(db: Queryable, schema: string, code: string): Promise<string | null> {
  try {
    const r = await db.query<{ id: string }>(
      `SELECT id FROM "${schema}".absence_types WHERE code = $1 LIMIT 1`, [code],
    )
    return r?.rows?.[0]?.id ?? null
  } catch {
    return null
  }
}

/**
 * Met à jour l'acquis de congés payés de l'année (mode mensuel) et renvoie le
 * solde. null = calcul impossible (pas de type CP, base illisible) : l'appelant
 * garde le solde stocké.
 */
export async function refreshPaidLeaveBalance(
  db: Queryable, schema: string, employeeId: string, policy: EffectiveLeavePolicy, asOf: string | Date = new Date(),
  opts: { persist?: boolean } = {},
): Promise<PaidLeaveBalance | null> {
  // persist=false : simulation (ex. solde à une date de départ future), rien n'est écrit.
  const persist = opts.persist ?? true
  try {
    const typeId = await paidLeaveTypeId(db, schema, policy.leaveTypeCode)
    if (!typeId) return null
    const year = ymd(asOf)[0]
    const emp = await db.query<{ hire_date: string | Date | null }>(
      `SELECT hire_date FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    if (!emp?.rows?.[0]) return null
    const hire = emp.rows[0].hire_date

    const cur = await db.query<{ id: string; acquired: string; taken: string; pending: string }>(
      `SELECT id, acquired, taken, pending FROM "${schema}".absence_balances
       WHERE employee_id = $1 AND absence_type_id = $2 AND year = $3 ORDER BY updated_at DESC LIMIT 1`,
      [employeeId, typeId, year],
    )
    let row = cur?.rows?.[0]
    if (!row) {
      const used = await db.query<{ taken: string | null; pending: string | null }>(
        `SELECT SUM(days) FILTER (WHERE status = 'approved') AS taken,
                SUM(days) FILTER (WHERE status IN ('pending', 'submitted')) AS pending
         FROM "${schema}".absences
         WHERE employee_id = $1 AND absence_type_id = $2
           AND start_date >= $3 AND start_date <= $4`,
        [employeeId, typeId, `${year}-01-01`, `${year}-12-31`],
      )
      const takenSum = Number(used?.rows?.[0]?.taken) || 0
      const pendingSum = Number(used?.rows?.[0]?.pending) || 0
      if (persist) {
        const ins = await db.query<{ id: string; acquired: string; taken: string; pending: string }>(
          `INSERT INTO "${schema}".absence_balances (employee_id, absence_type_id, year, acquired, taken, pending, remaining)
           VALUES ($1, $2, $3, 0, $4, $5, 0) RETURNING id, acquired, taken, pending`,
          [employeeId, typeId, year, takenSum, pendingSum],
        )
        row = ins?.rows?.[0]
        if (!row) return null
      } else {
        row = { id: '', acquired: '0', taken: String(takenSum), pending: String(pendingSum) }
      }
    }
    const taken = Number(row.taken) || 0
    const pending = Number(row.pending) || 0
    const months = monthsServedInYear(hire, year, asOf)

    if (policy.accrualMode === 'manual') {
      const acquired = Number(row.acquired) || 0
      return { year, mode: 'manual', accrued: acquired, carriedOver: 0, acquired, taken, pending,
        remaining: Math.round((acquired - taken - pending) * 10) / 10, monthsServed: months }
    }

    let carriedOver = 0
    if (policy.carryOver) {
      const prev = await db.query<{ remaining: string }>(
        `SELECT remaining FROM "${schema}".absence_balances
         WHERE employee_id = $1 AND absence_type_id = $2 AND year = $3 ORDER BY updated_at DESC LIMIT 1`,
        [employeeId, typeId, year - 1],
      )
      carriedOver = Math.max(0, Number(prev?.rows?.[0]?.remaining) || 0)
    }
    const accrued = accruedPaidLeaveDays(policy, hire, year, asOf).total
    const acquired = Math.round((accrued + carriedOver) * 10) / 10
    const remaining = Math.round((acquired - taken - pending) * 10) / 10
    if (persist && row.id) {
      await db.query(
        `UPDATE "${schema}".absence_balances SET acquired = $1, remaining = $2, updated_at = now() WHERE id = $3`,
        [acquired, remaining, row.id],
      )
    }
    return { year, mode: 'monthly', accrued, carriedOver, acquired, taken, pending, remaining, monthsServed: months }
  } catch {
    return null
  }
}

/** Politique de congés effective d'un tenant pour une filiale (pack du pays + surcharge). */
export async function loadLeavePolicy(
  db: Queryable, schema: string, pack: { leaveRules?: LeaveRules },
): Promise<EffectiveLeavePolicy> {
  let raw: unknown = null
  try {
    const r = await db.query<{ leave_policy: unknown }>(
      `SELECT leave_policy FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
    )
    raw = r?.rows?.[0]?.leave_policy ?? null
  } catch { /* colonne absente → règles du pays */ }
  return effectiveLeavePolicy(pack.leaveRules, raw)
}
/** Politique applicable à un employé : pack du pays de sa filiale + surcharge tenant. */
export async function loadLeavePolicyForEmployee(
  db: Queryable, schema: string, employeeId: string,
): Promise<EffectiveLeavePolicy> {
  let legalEntityId: string | null = null
  try {
    const r = await db.query<{ legal_entity_id: string | null }>(
      `SELECT legal_entity_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    legalEntityId = r?.rows?.[0]?.legal_entity_id ?? null
  } catch { /* repli : pack du tenant */ }
  try {
    // Lecture séparée de leave_policy : une colonne pas encore migrée ne doit
    // jamais casser le contexte tenant (paie, solde de tout compte).
    const ctx = await loadEmployeeTenantContext(db, schema, legalEntityId)
    return await loadLeavePolicy(db, schema, ctx.legislation.legislationPack)
  } catch {
    return effectiveLeavePolicy(undefined, null)
  }
}

export interface PaidLeaveRequestCheck {
  balance: PaidLeaveBalance
  requested: number
  available: number
  insufficient: boolean
  /** true = la demande doit être refusée (balanceCheck = block) */
  blocked: boolean
}

/**
 * Contrôle d'une demande de congés payés contre le solde acquis à date.
 * null = pas un congé payé, contrôle désactivé ou solde incalculable
 * (la demande suit alors le circuit habituel, sans blocage).
 */
export async function checkPaidLeaveRequest(
  db: Queryable, schema: string, employeeId: string, absenceTypeId: string, days: number, asOf: string | Date = new Date(),
): Promise<PaidLeaveRequestCheck | null> {
  try {
    const t = await db.query<{ code: string }>(
      `SELECT code FROM "${schema}".absence_types WHERE id = $1 LIMIT 1`, [absenceTypeId],
    )
    const code = t?.rows?.[0]?.code
    if (!code) return null
    const policy = await loadLeavePolicyForEmployee(db, schema, employeeId)
    if (code !== policy.leaveTypeCode || policy.balanceCheck === 'off') return null
    const balance = await refreshPaidLeaveBalance(db, schema, employeeId, policy, asOf)
    if (!balance) return null
    const available = Math.round((balance.remaining + policy.maxAdvanceDays) * 10) / 10
    const insufficient = days > available
    return { balance, requested: days, available, insufficient, blocked: insufficient && policy.balanceCheck === 'block' }
  } catch {
    return null
  }
}
