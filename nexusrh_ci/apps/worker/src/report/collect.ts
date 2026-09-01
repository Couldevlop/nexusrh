import type { Pool } from 'pg'
import type { Period } from './period.js'
import type { AgencyStats, ReportData, TenantStats, TrendPoint } from './types.js'

/**
 * Collecte du rapport — SEUL module du lot qui touche la base.
 *
 * Patron repris de jobs/interview-sim-consent-purge.ts : garde SAFE_SCHEMA
 * avant toute interpolation d'identifiant, cap anti-storm, et isolation stricte
 * par tenant. Un schéma cassé produit un TenantStats `collected: false`, jamais
 * une exception qui ferait perdre le rapport entier.
 */
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/
const MAX_TENANTS = Number(process.env['PLATFORM_REPORT_MAX_TENANTS'] ?? 500)

const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

interface TenantRow {
  id: string; name: string; schema_name: string; status: string
  plan_type: string; sector: string | null; max_users: number
  max_employees: number; trial_ends_at: Date | null; created_at: Date
}

function emptyStats(t: TenantRow, collected: boolean): TenantStats {
  return {
    tenantId: t.id, name: t.name, schemaName: t.schema_name, status: t.status,
    planType: t.plan_type, sector: t.sector, maxUsers: t.max_users,
    maxEmployees: t.max_employees, trialEndsAt: t.trial_ends_at, createdAt: t.created_at,
    collected, headcount: 0, hires: 0, departures: 0, hiresByContract: {},
    activeUsers: 0, usersLoggedIn: 0, lastLoginAt: null, loginSuccess: 0,
    loginFailed: 0, loginLocked: 0, mfaRequired: 0, auditWrites: 0, loginsByDay: {},
  }
}

export async function collectReport(pool: Pool, period: Period): Promise<ReportData> {
  const tenantsRes = await pool.query<TenantRow>(
    `SELECT id, name, schema_name, status, plan_type, sector,
            max_users, max_employees, trial_ends_at, created_at
       FROM platform.tenants
      WHERE status NOT IN ('rejected', 'cancelled')
      ORDER BY name
      LIMIT $1`,
    [MAX_TENANTS],
  )

  const agenciesRes = await pool.query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM platform.agencies ORDER BY name`,
  )

  const linksRes = await pool.query<{ agency_id: string; tenant_id: string; attached: boolean; detached: boolean }>(
    `SELECT agency_id, tenant_id,
            (assigned_at >= $1 AND assigned_at < $2) AS attached,
            (detached_at IS NOT NULL AND detached_at >= $1 AND detached_at < $2) AS detached
       FROM platform.agency_tenants
      WHERE detached_at IS NULL OR detached_at >= $1`,
    [period.start, period.end],
  )

  const tenants: TenantStats[] = []
  for (const t of tenantsRes.rows) {
    if (!SAFE_SCHEMA.test(t.schema_name)) {
      tenants.push(emptyStats(t, false))
      continue
    }
    try {
      tenants.push(await collectTenant(pool, t, period))
    } catch {
      // Isolation : ce tenant est marqué indisponible, les autres continuent.
      tenants.push(emptyStats(t, false))
    }
  }

  const agencies: AgencyStats[] = agenciesRes.rows.map((a) => {
    const links = linksRes.rows.filter((l) => l.agency_id === a.id)
    const tenantIds = links.filter((l) => !l.detached).map((l) => l.tenant_id)
    const headcount = tenantIds.reduce(
      (sum, id) => sum + (tenants.find((x) => x.tenantId === id)?.headcount ?? 0), 0,
    )
    return {
      agencyId: a.id, name: a.name, status: a.status, tenantIds,
      managedTenants: tenantIds.length, headcount,
      attached: links.filter((l) => l.attached).length,
      detached: links.filter((l) => l.detached).length,
    }
  })

  const trend = await collectTrend(pool, period)
  return { period, generatedAt: new Date(), tenants, agencies, trend }
}

const BUCKETS = 12

/** Début de la tranche n avant la période courante (0 = la plus récente). */
function bucketStart(period: Period, n: number): Date {
  const d = new Date(period.start)
  if (period.type === 'weekly') d.setUTCDate(d.getUTCDate() - 7 * n)
  else d.setUTCMonth(d.getUTCMonth() - n)
  return d
}

/**
 * Indice de la tranche contenant ce jour, ou -1 s'il est hors fenêtre.
 *
 * On compare aux bornes RÉELLES des tranches plutôt que de faire confiance à
 * une clé calculée par la base : `date_trunc('week', …)` de PostgreSQL renvoie
 * un lundi (ISO-8601) alors que nos périodes commencent un dimanche. Se fier à
 * l'égalité des chaînes faisait disparaître toutes les valeurs en silence.
 * `bornes` est trié du plus ancien au plus récent ; on cherche la dernière
 * borne inférieure ou égale au jour considéré.
 */
function indiceTranche(bornes: Date[], jour: string): number {
  const d = new Date(`${jour}T00:00:00.000Z`)
  let indice = -1
  for (let i = 0; i < bornes.length; i++) {
    if (bornes[i]! > d) break
    indice = i
  }
  return indice
}

/**
 * Évolution sur les 12 dernières périodes, tous tenants confondus.
 *
 * Deux séries seulement : arrivées et connexions réussies. L'effectif
 * historique n'est pas reconstituable — rien ne conserve l'état passé — et le
 * reconstruire produirait un graphique faux avec l'apparence du vrai.
 *
 * Le regroupement SQL se fait par JOUR calendaire (`to_char(created_at,
 * 'YYYY-MM-DD')`), jamais par `date_trunc('week'|'month', …)` : PostgreSQL
 * tronque la semaine sur un LUNDI (ISO-8601) alors que nos périodes
 * commencent un DIMANCHE (voir `weeklyPeriod`) — une clé calculée par la base
 * ne correspondrait alors jamais à un libellé de tranche, et toutes les
 * valeurs seraient écartées en silence en mode hebdomadaire. L'affectation à
 * la bonne tranche se fait donc côté JavaScript, par comparaison aux bornes
 * réelles (`indiceTranche`).
 */
export async function collectTrend(pool: Pool, period: Period, buckets = BUCKETS): Promise<TrendPoint[]> {
  const debut = bucketStart(period, buckets - 1)
  const fin = period.end

  const points: TrendPoint[] = []
  const bornes: Date[] = []
  for (let i = buckets - 1; i >= 0; i--) {
    const borne = bucketStart(period, i)
    bornes.push(borne)
    points.push({ label: borne.toISOString().slice(0, 10), hires: 0, logins: 0 })
  }

  const tenants = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM platform.tenants
      WHERE status NOT IN ('rejected', 'cancelled') LIMIT $1`,
    [MAX_TENANTS],
  )

  for (const t of tenants.rows) {
    const s = t.schema_name
    if (!SAFE_SCHEMA.test(s)) continue
    try {
      const hires = await pool.query<{ jour: string; n: string }>(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS jour, count(*) AS n
           FROM "${s}".employees
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY jour`,
        [debut, fin],
      )
      for (const r of hires.rows) {
        const i = indiceTranche(bornes, r.jour)
        if (i !== -1) points[i]!.hires += Number(r.n)
      }

      const logins = await pool.query<{ jour: string; n: string }>(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS jour, count(*) AS n
           FROM "${s}".audit_log
          WHERE action = 'auth.login.success' AND created_at >= $1 AND created_at < $2
          GROUP BY jour`,
        [debut, fin],
      )
      for (const r of logins.rows) {
        const i = indiceTranche(bornes, r.jour)
        if (i !== -1) points[i]!.logins += Number(r.n)
      }
    } catch {
      // Isolation : ce tenant ne contribue pas à la tendance, les autres si.
    }
  }
  return points
}

async function collectTenant(pool: Pool, t: TenantRow, period: Period): Promise<TenantStats> {
  const s = t.schema_name  // déjà validé par SAFE_SCHEMA
  const stats = emptyStats(t, true)

  const emp = await pool.query<{ headcount: string; hires: string; departures: string }>(
    `SELECT count(*) FILTER (WHERE is_active)                                   AS headcount,
            count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)        AS hires,
            count(*) FILTER (WHERE NOT is_active AND updated_at >= $1 AND updated_at < $2) AS departures
       FROM "${s}".employees`,
    [period.start, period.end],
  )
  stats.headcount = Number(emp.rows[0]?.headcount ?? 0)
  stats.hires = Number(emp.rows[0]?.hires ?? 0)
  stats.departures = Number(emp.rows[0]?.departures ?? 0)

  const byContract = await pool.query<{ contract_type: string | null; n: string }>(
    `SELECT contract_type, count(*) AS n
       FROM "${s}".employees
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY contract_type`,
    [period.start, period.end],
  )
  for (const r of byContract.rows) {
    stats.hiresByContract[r.contract_type ?? 'non précisé'] = Number(r.n)
  }

  const users = await pool.query<{ active_users: string; logged_in: string; last_login_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE is_active)                                        AS active_users,
            count(*) FILTER (WHERE last_login_at >= $1 AND last_login_at < $2)       AS logged_in,
            max(last_login_at)                                                       AS last_login_at
       FROM "${s}".users`,
    [period.start, period.end],
  )
  stats.activeUsers = Number(users.rows[0]?.active_users ?? 0)
  stats.usersLoggedIn = Number(users.rows[0]?.logged_in ?? 0)
  stats.lastLoginAt = users.rows[0]?.last_login_at ?? null

  const audit = await pool.query<{ action: string; day: string; n: string }>(
    `SELECT action, to_char(created_at, 'YYYY-MM-DD') AS day, count(*) AS n
       FROM "${s}".audit_log
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY action, day`,
    [period.start, period.end],
  ).catch((e: unknown) => {
    if (isMissingSchemaObject(e)) return { rows: [] as { action: string; day: string; n: string }[] }
    throw e
  })
  for (const r of audit.rows) {
    const n = Number(r.n)
    stats.auditWrites += n
    if (r.action === 'auth.login.success') {
      stats.loginSuccess += n
      stats.loginsByDay[r.day] = (stats.loginsByDay[r.day] ?? 0) + n
    } else if (r.action === 'auth.login.failed') stats.loginFailed += n
    else if (r.action === 'auth.login.locked') stats.loginLocked += n
    else if (r.action === 'auth.login.mfa_required') stats.mfaRequired += n
  }

  return stats
}
