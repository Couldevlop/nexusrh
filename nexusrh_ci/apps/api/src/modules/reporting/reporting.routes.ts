import type { FastifyPluginAsync } from 'fastify'
import { pool } from '../../db/pool.js'
import { auditTenant } from '../../utils/audit-log.js'
import { requestHrScope, requestEmployeeScope, declarationScope } from '../../utils/hr-scope.js'
import type { FastifyRequest } from 'fastify'

interface ClosedMonthRow {
  month: string; total_gross: number; total_net: number; total_cnps: number; total_its: number; employees_count: number
}

/**
 * Évolution mensuelle de la paie des périodes clôturées. Sans restriction : totaux
 * de la période (historique). Avec périmètre filiale : recalculés sur les SEULS
 * bulletins des salariés du périmètre (jamais la masse salariale des autres filiales).
 */
function closedPayrollByMonth(
  schema: string, scopeSql: string, monthLike: string | null, limit: number | null, order: 'ASC' | 'DESC',
): Promise<{ rows: ClosedMonthRow[] }> {
  const params: unknown[] = monthLike === null ? [] : [monthLike]
  const monthFilter = monthLike === null ? '' : 'AND pp.month LIKE $1'
  const lim = limit === null ? '' : ` LIMIT ${Math.trunc(limit)}`
  if (scopeSql === 'TRUE') {
    return pool.query(
      `SELECT pp.month, pp.total_gross::int, pp.total_net::int, pp.total_cnps::int,
              COALESCE(pp.total_its,0)::int AS total_its,
              (SELECT COUNT(*)::int FROM "${schema}".pay_slips ps WHERE ps.month = pp.month) AS employees_count
         FROM "${schema}".pay_periods pp
        WHERE pp.status = 'closed' ${monthFilter} ORDER BY pp.month ${order}${lim}`,
      params,
    )
  }
  return pool.query(
    `SELECT pp.month,
            COALESCE(SUM(ps.gross_salary),0)::int AS total_gross,
            COALESCE(SUM(ps.net_payable),0)::int AS total_net,
            COALESCE(SUM(COALESCE(ps.total_cnps_sal,0) + COALESCE(ps.total_cnps_pat,0)),0)::int AS total_cnps,
            COALESCE(SUM(ps.its),0)::int AS total_its,
            COUNT(ps.id)::int AS employees_count
       FROM "${schema}".pay_periods pp
       JOIN "${schema}".pay_slips ps ON ps.period_id = pp.id
       JOIN "${schema}".employees e ON e.id = ps.employee_id
      WHERE pp.status = 'closed' ${monthFilter} AND ${scopeSql}
      GROUP BY pp.month ORDER BY pp.month ${order}${lim}`,
    params,
  )
}

// OWASP A03 — validation des paramètres query (year, month). Année comprise
// entre 2000 et l'année courante + 1 (limite la fenêtre d'agrégation possible).
function parseYearParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return new Date().getFullYear()
  if (!/^\d{4}$/.test(raw)) return null
  const y = parseInt(raw, 10)
  if (y < 2000 || y > new Date().getFullYear() + 1) return null
  return y
}

// OWASP A09 — audit log non bloquant des exports (vol potentiel de données :
// masse salariale, cotisations CNPS, distribution salaires). Action sensible.
function auditLogReporting(
  schema: string, userId: string, action: string,
  scope: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId, action: action, entity: 'reporting', entityId: null, changes: scope, ip: ip })
}

// OWASP A07 — rate-limit anti-DoS sur les agrégations coûteuses. Les routes
// /overview et /payroll-summary lancent 5-8 requêtes en parallèle avec
// GROUP BY massifs. Cap : 30 req/min/IP. Largement suffisant pour un dashboard
// qui se rafraîchit à l'usage, bloque le scraping abusif.
const HEAVY_REPORT_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } }

const reportingRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /reporting/overview
  fastify.get('/overview', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    config: HEAVY_REPORT_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const yearParam = parseYearParam((request.query as Record<string, string>).year)
      if (yearParam === null) return reply.status(400).send({ error: 'year invalide (format YYYY, 2000-courant+1)' })
      const year = String(yearParam)
      try {
        // Habilitations : tous les agrégats sont calculés sur le périmètre filiale.
        const empScope = await requestHrScope(request, 'e')
        const jobScope = await requestHrScope(request, 'j')
        const absScope = await requestEmployeeScope(request, 'a.employee_id')
        const [depts, pay, absTypes, recJobs, empsTotal] = await Promise.all([
          pool.query(`
            SELECT d.name AS department, COUNT(e.id)::int AS count, COALESCE(AVG(e.base_salary),0)::int AS avg_salary
            FROM "${schema}".employees e
            LEFT JOIN "${schema}".departments d ON d.id = e.department_id
            WHERE e.is_active = true AND e.deleted_at IS NULL AND ${empScope}
            GROUP BY d.name ORDER BY count DESC
          `),
          closedPayrollByMonth(schema, empScope, `${year}-%`, null, 'ASC'),
          pool.query(`
            SELECT at.label AS type_label, at.color AS type_color,
              COUNT(a.id)::int AS count, COALESCE(SUM(a.days),0)::int AS total_days
            FROM "${schema}".absences a
            JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
            WHERE EXTRACT(YEAR FROM a.start_date) = $1 AND a.status = 'approved' AND ${absScope}
            GROUP BY at.label, at.color ORDER BY total_days DESC
          `, [parseInt(year)]),
          // Offres : filiale cible (target_legal_entity_id) évaluée comme la filiale d'un employé.
          pool.query(`SELECT j.status, COUNT(*)::int AS count
                        FROM (SELECT status, target_legal_entity_id AS legal_entity_id FROM "${schema}".recruitment_jobs) j
                       WHERE ${jobScope} GROUP BY j.status`),
          pool.query(`SELECT COUNT(*)::int AS total FROM "${schema}".employees e WHERE e.is_active = true AND e.deleted_at IS NULL AND ${empScope}`),
        ])
        interface PayRow { total_gross: number; total_net: number; total_cnps: number; total_its: number }
        interface Totals { totalGross: number; totalNet: number; totalCnps: number; totalIts: number }
        const annualTotals = (pay.rows as PayRow[]).reduce<Totals>(
          (acc, p) => ({
            totalGross: acc.totalGross + (p.total_gross || 0),
            totalNet:   acc.totalNet   + (p.total_net   || 0),
            totalCnps:  acc.totalCnps  + (p.total_cnps  || 0),
            totalIts:   acc.totalIts   + (p.total_its   || 0),
          }),
          { totalGross: 0, totalNet: 0, totalCnps: 0, totalIts: 0 }
        )
        auditLogReporting(schema, request.user.sub, 'reporting.overview', { year: yearParam }, request.ip ?? null)
        return reply.send({
          data: {
            year: yearParam,
            activeEmployees: empsTotal.rows[0]?.total ?? 0,
            departments: depts.rows,
            payrollEvolution: pay.rows,
            annualTotals,
            absencesByType: absTypes.rows,
            recruitmentByStatus: recJobs.rows,
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /reporting/payroll-summary
  fastify.get('/payroll-summary', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    config: HEAVY_REPORT_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const salScope = await requestHrScope(request, 'e')
        const [periods, salaryDist] = await Promise.all([
          closedPayrollByMonth(schema, salScope, null, 12, 'DESC'),
          pool.query(`
            SELECT
              CASE
                WHEN base_salary < 100000  THEN '< 100K'
                WHEN base_salary < 300000  THEN '100–300K'
                WHEN base_salary < 600000  THEN '300–600K'
                WHEN base_salary < 1000000 THEN '600K–1M'
                ELSE '> 1M'
              END AS range,
              COUNT(*)::int AS count
            FROM "${schema}".employees e
            WHERE is_active = true AND deleted_at IS NULL AND ${salScope}
            GROUP BY range ORDER BY MIN(base_salary)
          `),
        ])
        auditLogReporting(schema, request.user.sub, 'reporting.payroll_summary', {}, request.ip ?? null)
        return reply.send({ data: { periods: periods.rows, salaryDistribution: salaryDist.rows } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /reporting/absences
  fastify.get('/absences', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    config: HEAVY_REPORT_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const yearParam = parseYearParam((request.query as Record<string, string>).year)
      if (yearParam === null) return reply.status(400).send({ error: 'year invalide (format YYYY, 2000-courant+1)' })
      const year = String(yearParam)
      try {
        const absScope = await requestEmployeeScope(request, 'absences.employee_id')
        const deptScope = await requestHrScope(request, 'e')
        const [byMonth, byDept] = await Promise.all([
          pool.query(`
            SELECT to_char(start_date,'YYYY-MM') AS month,
              COUNT(*)::int AS count, COALESCE(SUM(days),0)::int AS total_days
            FROM "${schema}".absences
            WHERE EXTRACT(YEAR FROM start_date) = $1 AND status = 'approved' AND ${absScope}
            GROUP BY to_char(start_date,'YYYY-MM') ORDER BY month
          `, [parseInt(year)]),
          pool.query(`
            SELECT COALESCE(d.name,'Sans département') AS department,
              COUNT(a.id)::int AS count, COALESCE(SUM(a.days),0)::int AS total_days
            FROM "${schema}".absences a
            JOIN "${schema}".employees e ON e.id = a.employee_id
            LEFT JOIN "${schema}".departments d ON d.id = e.department_id
            WHERE EXTRACT(YEAR FROM a.start_date) = $1 AND a.status = 'approved' AND ${deptScope}
            GROUP BY d.name ORDER BY total_days DESC
          `, [parseInt(year)]),
        ])
        auditLogReporting(schema, request.user.sub, 'reporting.absences', { year: yearParam }, request.ip ?? null)
        return reply.send({ data: { byMonth: byMonth.rows, byDepartment: byDept.rows } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /reporting/cnps-analytics
  fastify.get('/cnps-analytics', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    config: HEAVY_REPORT_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const yearParam = parseYearParam((request.query as Record<string, string>).year)
      if (yearParam === null) return reply.status(400).send({ error: 'year invalide (format YYYY, 2000-courant+1)' })
      const year = String(yearParam)
      try {
        const declarations = await pool.query(`
          SELECT year, quarter, status, masse_salariale::int,
            total_cotisations_salariales::int, total_cotisations_patronales::int, total_cotisations::int,
            employees_count
          FROM "${schema}".cnps_declarations d
          WHERE year = $1 AND ${await declarationScope(request, 'd')} ORDER BY quarter
        `, [parseInt(year)])
        const monthlyHistory = await closedPayrollByMonth(schema, await requestHrScope(request, 'e'), `${year}-%`, null, 'ASC')
        auditLogReporting(schema, request.user.sub, 'reporting.cnps_analytics', { year: yearParam }, request.ip ?? null)
        return reply.send({
          data: {
            declarations: declarations.rows,
            monthlyHistory: monthlyHistory.rows,
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /reporting/insights — alertes IA du dashboard (REP-007), max 3, calculées
  // sur des données réelles : périodes d'essai expirant, absentéisme du mois,
  // échéance de déclaration CNPS. Risque + libellé en français.
  fastify.get('/insights', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    config: HEAVY_REPORT_RATE_LIMIT,
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const insights: Array<{ type: string; severity: 'low'|'medium'|'high'; title: string; message: string }> = []
        const insEmpScope = await requestHrScope(request, 'e')
        const insAbsScope = await requestEmployeeScope(request, 'absences.employee_id')

        // 1) Périodes d'essai qui expirent sous 14 jours (essai cadre ~3 mois)
        const trials = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::int AS n FROM "${schema}".employees e
            WHERE is_active = true AND deleted_at IS NULL AND hire_date IS NOT NULL AND ${insEmpScope}
              AND (hire_date + INTERVAL '3 months') BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '14 days')`,
        ).catch(() => ({ rows: [{ n: '0' }] }))
        const nTrials = Number(trials.rows[0]?.n) || 0
        if (nTrials > 0) insights.push({
          type: 'trial_expiring', severity: 'medium',
          title: 'Périodes d\'essai à statuer',
          message: `${nTrials} période(s) d'essai arrive(nt) à échéance sous 14 jours — décision à prendre (confirmation/rupture).`,
        })

        // 2) Absentéisme du mois en cours (jours approuvés)
        const absMonth = await pool.query<{ d: string }>(
          `SELECT COALESCE(SUM(days),0) AS d FROM "${schema}".absences
            WHERE status = 'approved' AND ${insAbsScope}
              AND date_trunc('month', start_date) = date_trunc('month', CURRENT_DATE)`,
        ).catch(() => ({ rows: [{ d: '0' }] }))
        const absDays = Number(absMonth.rows[0]?.d) || 0
        if (absDays > 20) insights.push({
          type: 'absenteeism', severity: absDays > 60 ? 'high' : 'medium',
          title: 'Absentéisme élevé ce mois',
          message: `${absDays} jours d'absence approuvés ce mois — surveiller les pics par département.`,
        })

        // 3) Échéance de déclaration CNPS (avant le 15 du mois)
        const day = new Date().getDate()
        if (day <= 15) insights.push({
          type: 'cnps_deadline', severity: day >= 12 ? 'high' : 'low',
          title: 'Déclaration CNPS à soumettre',
          message: `La déclaration e-CNPS du mois doit être déposée avant le 15 (J-${Math.max(0, 15 - day)}).`,
        })

        // Max 3 alertes (priorité severity high > medium > low)
        const rank = { high: 0, medium: 1, low: 2 }
        insights.sort((a, b) => rank[a.severity] - rank[b.severity])
        return reply.send({ data: insights.slice(0, 3) })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default reportingRoutes
