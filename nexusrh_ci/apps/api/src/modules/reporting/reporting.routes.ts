import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })

const reportingRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /reporting/overview
  fastify.get('/overview', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year = String(new Date().getFullYear()) } = request.query as Record<string, string>
      try {
        const [depts, pay, absTypes, recJobs, empsTotal] = await Promise.all([
          pool.query(`
            SELECT d.name AS department, COUNT(e.id)::int AS count, COALESCE(AVG(e.base_salary),0)::int AS avg_salary
            FROM "${schema}".employees e
            LEFT JOIN "${schema}".departments d ON d.id = e.department_id
            WHERE e.is_active = true AND e.deleted_at IS NULL
            GROUP BY d.name ORDER BY count DESC
          `),
          pool.query(`
            SELECT month, total_gross::int, total_net::int, total_cnps::int, COALESCE(total_its,0)::int AS total_its
            FROM "${schema}".pay_periods
            WHERE month LIKE $1 AND status = 'closed' ORDER BY month
          `, [`${year}-%`]),
          pool.query(`
            SELECT at.label AS type_label, at.color AS type_color,
              COUNT(a.id)::int AS count, COALESCE(SUM(a.days),0)::int AS total_days
            FROM "${schema}".absences a
            JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
            WHERE EXTRACT(YEAR FROM a.start_date) = $1 AND a.status = 'approved'
            GROUP BY at.label, at.color ORDER BY total_days DESC
          `, [parseInt(year)]),
          pool.query(`SELECT status, COUNT(*)::int AS count FROM "${schema}".recruitment_jobs GROUP BY status`),
          pool.query(`SELECT COUNT(*)::int AS total FROM "${schema}".employees WHERE is_active = true AND deleted_at IS NULL`),
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
        return reply.send({
          data: {
            year: parseInt(year),
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
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const [periods, salaryDist] = await Promise.all([
          pool.query(`
            SELECT month, total_gross::int, total_net::int, total_cnps::int, COALESCE(total_its,0)::int AS total_its,
              (SELECT COUNT(*)::int FROM "${schema}".pay_slips ps WHERE ps.month = pp.month) AS employees_count
            FROM "${schema}".pay_periods pp
            WHERE status = 'closed' ORDER BY month DESC LIMIT 12
          `),
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
            FROM "${schema}".employees
            WHERE is_active = true AND deleted_at IS NULL
            GROUP BY range ORDER BY MIN(base_salary)
          `),
        ])
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
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year = String(new Date().getFullYear()) } = request.query as Record<string, string>
      try {
        const [byMonth, byDept] = await Promise.all([
          pool.query(`
            SELECT to_char(start_date,'YYYY-MM') AS month,
              COUNT(*)::int AS count, COALESCE(SUM(days),0)::int AS total_days
            FROM "${schema}".absences
            WHERE EXTRACT(YEAR FROM start_date) = $1 AND status = 'approved'
            GROUP BY to_char(start_date,'YYYY-MM') ORDER BY month
          `, [parseInt(year)]),
          pool.query(`
            SELECT COALESCE(d.name,'Sans département') AS department,
              COUNT(a.id)::int AS count, COALESCE(SUM(a.days),0)::int AS total_days
            FROM "${schema}".absences a
            JOIN "${schema}".employees e ON e.id = a.employee_id
            LEFT JOIN "${schema}".departments d ON d.id = e.department_id
            WHERE EXTRACT(YEAR FROM a.start_date) = $1 AND a.status = 'approved'
            GROUP BY d.name ORDER BY total_days DESC
          `, [parseInt(year)]),
        ])
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
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year = String(new Date().getFullYear()) } = request.query as Record<string, string>
      try {
        const declarations = await pool.query(`
          SELECT year, quarter, status, masse_salariale::int,
            total_cotisations_salariales::int, total_cotisations_patronales::int, total_cotisations::int,
            employees_count
          FROM "${schema}".cnps_declarations
          WHERE year = $1 ORDER BY quarter
        `, [parseInt(year)])
        const monthlyHistory = await pool.query(`
          SELECT month, total_cnps::int, total_its::int, total_gross::int
          FROM "${schema}".pay_periods
          WHERE month LIKE $1 AND status = 'closed'
          ORDER BY month
        `, [`${year}-%`])
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
}

export default reportingRoutes
