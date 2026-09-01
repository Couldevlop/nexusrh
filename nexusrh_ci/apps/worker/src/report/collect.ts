import type { Pool } from 'pg'
import type { Period } from './period.js'
import type { AgencyStats, PlatformAuthStats, ReportData, TenantStats, TrendPoint } from './types.js'

/**
 * Collecte du rapport — SEUL module du lot qui touche la base.
 *
 * Patron repris de jobs/interview-sim-consent-purge.ts : garde SAFE_SCHEMA
 * avant toute interpolation d'identifiant, cap anti-storm, et isolation stricte
 * par tenant. Un schéma cassé produit un TenantStats `collected: false`, jamais
 * une exception qui ferait perdre le rapport entier.
 *
 * ⚠️ FUSEAU HORAIRE : partout où un `timestamptz` est ramené à un jour
 * calendaire, la conversion est explicitement faite en UTC
 * (`AT TIME ZONE 'UTC'`). Sans cela le jour rendu dépendrait du fuseau de
 * SESSION du serveur PostgreSQL — que rien ne fixe dans le chart — alors que
 * les bornes de période et `indiceTranche` raisonnent, elles, en UTC. C'est la
 * même famille de défaut que le `date_trunc('week')` déjà écarté plus bas.
 *
 * ⚠️ RGPD : la colonne `changes` de l'audit n'est JAMAIS sélectionnée — elle
 * contient notamment l'e-mail saisi lors d'un échec de connexion.
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
    blockedOffline: 0, mfaRequired: 0, auditWrites: 0, loginsByDay: {},
  }
}

/**
 * Échecs de connexion de l'ENSEMBLE de la plateforme.
 *
 * `auth.login.failed` et `auth.login.locked` sont écrits par l'API dans le
 * schéma `platform` (auth.routes.ts) : au moment de l'échec, l'utilisateur
 * n'est pas identifié, donc son entreprise non plus. Les chercher dans le
 * schéma de chaque tenant renvoyait invariablement zéro — un faux signal
 * rassurant sur le seul indicateur de sécurité du rapport. Une seule requête,
 * hors de la boucle par tenant, et un total plateforme assumé comme tel.
 *
 * La colonne `changes` (qui porte l'e-mail saisi) n'est jamais lue.
 */
async function collectPlatformAuth(pool: Pool, period: Period): Promise<PlatformAuthStats> {
  const stats: PlatformAuthStats = { loginFailed: 0, loginLocked: 0 }
  const res = await pool.query<{ action: string; n: string }>(
    `SELECT action, count(*) AS n
       FROM platform.audit_log
      WHERE action IN ('auth.login.failed', 'auth.login.locked')
        AND created_at >= $1 AND created_at < $2
      GROUP BY action`,
    [period.start, period.end],
  ).catch((e: unknown) => {
    if (isMissingSchemaObject(e)) return { rows: [] as { action: string; n: string }[] }
    throw e
  })
  for (const r of res.rows) {
    if (r.action === 'auth.login.failed') stats.loginFailed += Number(r.n)
    else if (r.action === 'auth.login.locked') stats.loginLocked += Number(r.n)
  }
  return stats
}

export async function collectReport(pool: Pool, period: Period): Promise<ReportData> {
  // On demande une ligne de plus que le plafond : sa présence est le seul
  // moyen de savoir que le parc a dépassé la borne, et donc de le SIGNALER
  // au lieu de tronquer en silence.
  const tenantsRes = await pool.query<TenantRow>(
    `SELECT id, name, schema_name, status, plan_type, sector,
            max_users, max_employees, trial_ends_at, created_at
       FROM platform.tenants
      WHERE status NOT IN ('rejected', 'cancelled')
      ORDER BY name
      LIMIT $1`,
    [MAX_TENANTS + 1],
  )
  const truncated = tenantsRes.rows.length > MAX_TENANTS
  const tenantRows = tenantsRes.rows.slice(0, MAX_TENANTS)

  // La spec parle des cabinets ACTIFS : un cabinet archivé ne doit pas peser
  // dans la part du parc.
  const agenciesRes = await pool.query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM platform.agencies WHERE status = 'active' ORDER BY name`,
  )

  const linksRes = await pool.query<{ agency_id: string; tenant_id: string; attached: boolean; detached: boolean }>(
    `SELECT agency_id, tenant_id,
            (assigned_at >= $1 AND assigned_at < $2) AS attached,
            (detached_at IS NOT NULL AND detached_at >= $1 AND detached_at < $2) AS detached
       FROM platform.agency_tenants
      WHERE detached_at IS NULL OR detached_at >= $1`,
    [period.start, period.end],
  )

  const platformAuth = await collectPlatformAuth(pool, period)

  const tenants: TenantStats[] = []
  for (const t of tenantRows) {
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

  // La tendance porte sur EXACTEMENT la même liste d'entreprises que le
  // rapport : relire la table donnerait, au-delà du plafond, un sous-ensemble
  // différent (l'ancienne requête n'avait même pas d'ORDER BY).
  const trend = await collectTrend(pool, period, tenants.map((t) => t.schemaName))
  return { period, generatedAt: new Date(), tenants, agencies, platformAuth, truncated, trend }
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
 * Jour d'arrivée d'un salarié, en SQL.
 *
 * `hire_date` est la colonne métier (date d'embauche). `created_at` n'est que
 * la date de SAISIE de la fiche : s'en servir ferait annoncer « 200 arrivées »
 * la semaine où un nouveau client importe son effectif, et contaminerait la
 * courbe des 12 périodes. Repli sur `created_at` (converti en UTC) quand
 * l'embauche n'est pas renseignée, pour ne perdre personne.
 */
const JOUR_ARRIVEE = `COALESCE(hire_date, (created_at AT TIME ZONE 'UTC')::date)`

/**
 * Évolution sur les 12 dernières périodes, tous tenants confondus.
 *
 * Deux séries seulement : arrivées et connexions réussies. L'effectif
 * historique n'est pas reconstituable — rien ne conserve l'état passé — et le
 * reconstruire produirait un graphique faux avec l'apparence du vrai.
 *
 * La liste des schémas est FOURNIE par l'appelant (celle déjà collectée) et
 * non relue ici : deux lectures plafonnées, dont une sans ORDER BY, pouvaient
 * porter sur des sous-ensembles différents.
 *
 * Le regroupement SQL se fait par JOUR calendaire, jamais par
 * `date_trunc('week'|'month', …)` : PostgreSQL tronque la semaine sur un
 * LUNDI (ISO-8601) alors que nos périodes commencent un DIMANCHE (voir
 * `weeklyPeriod`) — une clé calculée par la base ne correspondrait alors
 * jamais à un libellé de tranche, et toutes les valeurs seraient écartées en
 * silence en mode hebdomadaire. L'affectation à la bonne tranche se fait donc
 * côté JavaScript, par comparaison aux bornes réelles (`indiceTranche`).
 */
export async function collectTrend(
  pool: Pool, period: Period, schemas: string[], buckets = BUCKETS,
): Promise<TrendPoint[]> {
  const debut = bucketStart(period, buckets - 1)
  const fin = period.end

  const points: TrendPoint[] = []
  const bornes: Date[] = []
  for (let i = buckets - 1; i >= 0; i--) {
    const borne = bucketStart(period, i)
    bornes.push(borne)
    points.push({ label: borne.toISOString().slice(0, 10), hires: 0, logins: 0 })
  }

  for (const s of schemas) {
    if (!SAFE_SCHEMA.test(s)) continue
    try {
      const hires = await pool.query<{ jour: string; n: string }>(
        `SELECT to_char(${JOUR_ARRIVEE}, 'YYYY-MM-DD') AS jour, count(*) AS n
           FROM "${s}".employees
          WHERE ${JOUR_ARRIVEE} >= $1::date AND ${JOUR_ARRIVEE} < $2::date
          GROUP BY jour`,
        [debut, fin],
      )
      for (const r of hires.rows) {
        const i = indiceTranche(bornes, r.jour)
        if (i !== -1) points[i]!.hires += Number(r.n)
      }

      // AT TIME ZONE 'UTC' : le jour ne doit pas dépendre du fuseau de session.
      const logins = await pool.query<{ jour: string; n: string }>(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS jour, count(*) AS n
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

/** Colonnes réellement présentes sur `<schéma>.employees`. */
async function colonnesEmployees(pool: Pool, s: string): Promise<Set<string>> {
  const res = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'employees'`,
    [s],
  )
  return new Set(res.rows.map((r) => r.column_name))
}

async function collectTenant(pool: Pool, t: TenantRow, period: Period): Promise<TenantStats> {
  const s = t.schema_name  // déjà validé par SAFE_SCHEMA
  const stats = emptyStats(t, true)

  const colonnes = await colonnesEmployees(pool, s)

  /*
   * Départs : `exit_date` est la colonne métier de sortie (provisioning.ts).
   * L'ancien compteur s'appuyait sur `NOT is_active AND updated_at` — or deux
   * des trois chemins de sortie (archivage employé, radiation CNPS) ne
   * touchent pas `updated_at` et aucun déclencheur ne la maintient : le
   * compteur ratait de vrais départs et en inventait d'autres (toute mise à
   * jour d'une fiche déjà inactive était comptée). `deleted_at` n'existe pas
   * dans tous les schémas historiques — d'où la vérification des colonnes
   * réellement présentes avant d'écrire la requête. `exit_date` elle-même
   * n'est pas garantie sur un schéma ancien : sans cette même vérification,
   * la requête lève 42703 (colonne inexistante) et le tenant entier est
   * marqué « données indisponibles » alors qu'il était collectable. Si ni
   * l'une ni l'autre colonne n'existe, le compteur de départs vaut 0.
   */
  const conditionsDeparts = [
    colonnes.has('exit_date') ? '(exit_date >= $1::date AND exit_date < $2::date)' : null,
    colonnes.has('deleted_at') ? '(deleted_at >= $1 AND deleted_at < $2)' : null,
  ].filter((c): c is string => c !== null)
  const departsSql = conditionsDeparts.length > 0 ? conditionsDeparts.join(' OR ') : 'false'

  const emp = await pool.query<{ headcount: string; hires: string; departures: string }>(
    `SELECT count(*) FILTER (WHERE is_active)                                 AS headcount,
            count(*) FILTER (WHERE ${JOUR_ARRIVEE} >= $1::date
                               AND ${JOUR_ARRIVEE} < $2::date)                AS hires,
            count(*) FILTER (WHERE ${departsSql})                             AS departures
       FROM "${s}".employees`,
    [period.start, period.end],
  )
  stats.headcount = Number(emp.rows[0]?.headcount ?? 0)
  stats.hires = Number(emp.rows[0]?.hires ?? 0)
  stats.departures = Number(emp.rows[0]?.departures ?? 0)

  const byContract = await pool.query<{ contract_type: string | null; n: string }>(
    `SELECT contract_type, count(*) AS n
       FROM "${s}".employees
      WHERE ${JOUR_ARRIVEE} >= $1::date AND ${JOUR_ARRIVEE} < $2::date
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

  // AT TIME ZONE 'UTC' : sans cela le regroupement par jour dépendrait du
  // fuseau de session du serveur, que rien ne fixe.
  // `auth.login.blocked_offline` est le seul échec d'authentification écrit
  // dans le schéma du tenant (identifiants valides → entreprise connue) ; il
  // reste donc légitimement attribué ici.
  const audit = await pool.query<{ action: string; day: string; n: string }>(
    `SELECT action, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS n
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
    } else if (r.action === 'auth.login.blocked_offline') stats.blockedOffline += n
    else if (r.action === 'auth.login.mfa_required') stats.mfaRequired += n
  }

  return stats
}
