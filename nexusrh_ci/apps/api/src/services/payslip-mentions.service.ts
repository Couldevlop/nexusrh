/**
 * Mentions obligatoires du bulletin de paie (Code du travail CI) qui ne sont
 * pas portées par la ligne `pay_slips` : date d'embauche / ancienneté,
 * catégorie professionnelle, temps de travail de la période, solde de congés
 * payés, RCCM et N° de compte contribuable (DGI) de l'employeur.
 *
 * Lecture seule, « au mieux » : chaque requête a son repli — une mention
 * indisponible (tenant ancien, table absente) n'empêche jamais l'édition du
 * bulletin. Aucune donnée de paie n'est recalculée ici (le moteur reste seul
 * maître des montants) : le temps de travail est une base de présentation.
 */
import { assertValidSchemaName } from '../utils/schema-name.js'

interface Queryable {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>
}

export interface PayslipMentions {
  employee: { hireDate: string | null; category: string | null }
  employer: { rccm: string | null; dgiNumber: string | null }
  worked:   { days: number; hours: number } | null
  leaveBalance: { year: number; acquired: number; taken: number; remaining: number } | null
}

/** Base mensuelle conventionnelle CI : 30 jours ; heures = horaire hebdo × 52 / 12. */
const MONTH_BASE_DAYS = 30

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Période AAAA-MM → [premier jour, dernier jour] (dates ISO). */
function monthBounds(month: string): [string, string] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2])
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return [`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`]
}

export async function loadPayslipMentions(
  db: Queryable, schema: string, employeeId: string, month: string,
): Promise<PayslipMentions> {
  assertValidSchemaName(schema)
  const out: PayslipMentions = {
    employee: { hireDate: null, category: null },
    employer: { rccm: null, dgiNumber: null },
    worked: null,
    leaveBalance: null,
  }
  const bounds = monthBounds(month)

  // 1. Fiche salarié : embauche, catégorie (classification conventionnelle,
  //    repli sur le niveau de poste), horaire hebdomadaire.
  let weeklyHours = 40
  try {
    const r = await db.query<{ hire_date: unknown; professional_category: unknown; job_level: unknown; weekly_hours: unknown }>(
      `SELECT hire_date::text AS hire_date, professional_category, job_level, weekly_hours
         FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    const e = r.rows[0]
    if (e) {
      out.employee.hireDate = str(e.hire_date)
      out.employee.category = str(e.professional_category) ?? str(e.job_level)
      weeklyHours = num(e.weekly_hours) ?? 40
    }
  } catch { /* mention indisponible */ }

  // 2. Temps de travail : base 30 jours moins les absences approuvées NON
  //    rémunérées (ou impactant le salaire) chevauchant la période.
  if (bounds) {
    let unpaidDays = 0
    try {
      const r = await db.query<{ d: unknown }>(
        `SELECT COALESCE(SUM(LEAST(a.end_date, $3::date) - GREATEST(a.start_date, $2::date) + 1), 0) AS d
           FROM "${schema}".absences a
           JOIN "${schema}".absence_types t ON t.id = a.absence_type_id
          WHERE a.employee_id = $1 AND a.status = 'approved'
            AND (t.is_paid = false OR t.affects_salary = true)
            AND a.start_date <= $3::date AND a.end_date >= $2::date`,
        [employeeId, bounds[0], bounds[1]],
      )
      unpaidDays = Math.max(0, num(r.rows[0]?.d) ?? 0)
    } catch { unpaidDays = 0 }
    const days = Math.max(0, MONTH_BASE_DAYS - Math.min(unpaidDays, MONTH_BASE_DAYS))
    const monthlyHours = (weeklyHours * 52) / 12
    out.worked = {
      days,
      hours: Math.round(((monthlyHours * days) / MONTH_BASE_DAYS) * 100) / 100,
    }
  }

  // 3. Congés payés de l'année du bulletin (type CP).
  const year = Number(month.slice(0, 4))
  if (Number.isInteger(year)) {
    try {
      const r = await db.query<{ acquired: unknown; taken: unknown; remaining: unknown }>(
        `SELECT b.acquired, b.taken, b.remaining
           FROM "${schema}".absence_balances b
           JOIN "${schema}".absence_types t ON t.id = b.absence_type_id
          WHERE b.employee_id = $1 AND b.year = $2 AND t.code = 'CP'
          LIMIT 1`, [employeeId, year],
      )
      const b = r.rows[0]
      const acquired = num(b?.acquired); const taken = num(b?.taken); const remaining = num(b?.remaining)
      if (acquired !== null && taken !== null && remaining !== null) {
        out.leaveBalance = { year, acquired, taken, remaining }
      }
    } catch { /* pas de solde */ }
  }

  // 4. Employeur : RCCM + N° de compte contribuable (paramètres du tenant).
  try {
    const r = await db.query<{ rccm: unknown; dgi_number: unknown }>(
      `SELECT rccm, dgi_number FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema],
    )
    out.employer.rccm = str(r.rows[0]?.rccm)
    out.employer.dgiNumber = str(r.rows[0]?.dgi_number)
  } catch { /* mention indisponible */ }

  return out
}
