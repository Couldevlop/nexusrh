import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })

const expensesRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /expenses — toutes les notes (RH)
  fastify.get('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status, employee_id, limit = '50', offset = '0' } = request.query as Record<string, string>
      let sql = `SELECT er.*, e.first_name, e.last_name, d.name AS department_name
                 FROM "${schema}".expense_reports er
                 JOIN "${schema}".employees e ON e.id = er.employee_id
                 LEFT JOIN "${schema}".departments d ON d.id = e.department_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (request.user.role === 'manager') {
        const emp = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        if (emp.rows[0]) { sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id) }
      }
      if (status)      { sql += ` AND er.status = $${idx++}`; params.push(status) }
      if (employee_id) { sql += ` AND er.employee_id = $${idx++}`; params.push(employee_id) }
      sql += ` ORDER BY er.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`
      params.push(parseInt(limit), parseInt(offset))
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /expenses/my-expenses
  fastify.get('/my-expenses', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        let employeeId = request.user.employeeId
        if (!employeeId) {
          const emp = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
          )
          if (!emp.rows[0]) return reply.send({ data: [] })
          employeeId = emp.rows[0].id as string
        }
        const res = await pool.query(`
          SELECT er.*,
            (SELECT json_agg(el ORDER BY el.date) FROM "${schema}".expense_lines el WHERE el.report_id = er.id) AS lines
          FROM "${schema}".expense_reports er
          WHERE er.employee_id = $1
          ORDER BY er.created_at DESC LIMIT 24
        `, [employeeId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /expenses/:id
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const role = request.user.role
      try {
        const reportRes = await pool.query(`
          SELECT er.*, e.first_name, e.last_name, e.email AS employee_email, d.name AS department_name
          FROM "${schema}".expense_reports er
          JOIN "${schema}".employees e ON e.id = er.employee_id
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE er.id = $1
        `, [id])
        if (!reportRes.rows[0]) return reply.status(404).send({ error: 'Note introuvable' })
        // Vérification ownership : employee ne peut accéder qu'à ses propres notes
        if (role === 'employee' && reportRes.rows[0].employee_email !== request.user.email) {
          return reply.status(403).send({ error: 'Accès interdit' })
        }
        const linesRes = await pool.query(
          `SELECT * FROM "${schema}".expense_lines WHERE report_id = $1 ORDER BY date`, [id]
        )
        return reply.send({ data: { ...reportRes.rows[0], lines: linesRes.rows } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /expenses
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as Record<string, unknown>
      try {
        let employeeId = body.employee_id as string | undefined
        if (!employeeId || request.user.role === 'employee') {
          const emp = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
          )
          if (emp.rows[0]) {
            employeeId = emp.rows[0].id as string
          } else {
            return reply.status(422).send({ error: 'Aucun dossier employé associé à ce compte. Contactez votre RH.' })
          }
        }
        const lines = (body.lines as Array<Record<string, unknown>>) ?? []
        const totalAmount = lines.reduce((sum, l) => sum + (parseInt(l.amount as string) || 0), 0)
        const res = await pool.query(`
          INSERT INTO "${schema}".expense_reports (employee_id, title, month, total_amount, status)
          VALUES ($1,$2,$3,$4,'draft') RETURNING *
        `, [employeeId, body.title, body.month || new Date().toISOString().slice(0, 7), totalAmount])
        const report = res.rows[0]
        for (const line of lines) {
          await pool.query(`
            INSERT INTO "${schema}".expense_lines (report_id, description, category, date, amount)
            VALUES ($1,$2,$3,$4,$5)
          `, [report.id, line.description, line.category || 'autre', line.date, line.amount])
        }
        return reply.status(201).send({ data: report })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/submit
  fastify.patch('/:id/submit', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        // Vérifier l'ownership avant la mise à jour
        if (request.user.role === 'employee') {
          const ownerCheck = await pool.query(
            `SELECT e.email FROM "${schema}".expense_reports er
             JOIN "${schema}".employees e ON e.id = er.employee_id
             WHERE er.id = $1 LIMIT 1`,
            [id]
          )
          if (!ownerCheck.rows[0] || ownerCheck.rows[0].email !== request.user.email) {
            return reply.status(403).send({ error: 'Accès interdit' })
          }
        }
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'submitted', submitted_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'draft' RETURNING *
        `, [id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non modifiable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/approve
  fastify.patch('/:id/approve', {
    preHandler: [fastify.authorize('admin','hr_manager','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
          WHERE id = $2 AND status = 'submitted' RETURNING *
        `, [request.user.sub, id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non approvable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/reject
  fastify.patch('/:id/reject', {
    preHandler: [fastify.authorize('admin','hr_manager','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const { reason } = request.body as { reason?: string }
      try {
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'rejected', rejection_reason = $1, updated_at = now()
          WHERE id = $2 AND status = 'submitted' RETURNING *
        `, [reason || null, id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non refusable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /expenses/:id/pay
  fastify.patch('/:id/pay', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const res = await pool.query(`
          UPDATE "${schema}".expense_reports
          SET status = 'paid', paid_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'approved' RETURNING *
        `, [id])
        if (!res.rows[0]) return reply.status(400).send({ error: 'Note non remboursable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /expenses/:id/lines
  fastify.post('/:id/lines', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      try {
        const lineRes = await pool.query(`
          INSERT INTO "${schema}".expense_lines (report_id, description, category, date, amount)
          VALUES ($1,$2,$3,$4,$5) RETURNING *
        `, [id, body.description, body.category || 'autre', body.date, body.amount])
        await pool.query(`
          UPDATE "${schema}".expense_reports
          SET total_amount = (SELECT COALESCE(SUM(amount),0) FROM "${schema}".expense_lines WHERE report_id = $1),
              updated_at = now()
          WHERE id = $1
        `, [id])
        return reply.status(201).send({ data: lineRes.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default expensesRoutes
