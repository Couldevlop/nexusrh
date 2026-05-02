import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })
const rawPool = pool

const trainingRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /training/catalog
  fastify.get('/catalog', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { is_fdfp_eligible, category } = request.query as Record<string, string>
      let sql = `SELECT t.*,
                   COUNT(DISTINCT ts.id)::int AS sessions_count,
                   COUNT(DISTINCT te.id)::int AS enrollments_count
                 FROM "${schema}".trainings t
                 LEFT JOIN "${schema}".training_sessions ts ON ts.training_id = t.id AND ts.status = 'planned'
                 LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
                 WHERE t.is_active = true`
      const params: unknown[] = []
      let idx = 1
      if (is_fdfp_eligible === 'true') sql += ` AND t.is_fdfp_eligible = true`
      if (category) { sql += ` AND t.category = $${idx++}`; params.push(category) }
      sql += ` GROUP BY t.id ORDER BY t.title`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/catalog
  fastify.post('/catalog', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as Record<string, unknown>
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".trainings
            (title, description, duration, duration_unit, format, category,
             is_fdfp_eligible, fdfp_code, max_participants)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [body.title, body.description || null,
            body.duration || null, body.duration_unit || 'hours',
            body.format || 'presentiel', body.category || null,
            body.is_fdfp_eligible || false, body.fdfp_code || null,
            body.max_participants || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/sessions
  fastify.get('/sessions', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status, training_id } = request.query as Record<string, string>
      let sql = `SELECT ts.*, t.title AS training_title, t.duration, t.duration_unit,
                   t.is_fdfp_eligible, t.category, t.format,
                   COUNT(te.id)::int AS enrolled_count
                 FROM "${schema}".training_sessions ts
                 JOIN "${schema}".trainings t ON t.id = ts.training_id
                 LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (status)      { sql += ` AND ts.status = $${idx++}`; params.push(status) }
      if (training_id) { sql += ` AND ts.training_id = $${idx++}`; params.push(training_id) }
      sql += ` GROUP BY ts.id, t.id ORDER BY ts.start_date DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/sessions
  fastify.post('/sessions', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as Record<string, unknown>
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".training_sessions
            (training_id, start_date, end_date, location, trainer, status, max_places)
          VALUES ($1,$2,$3,$4,$5,'planned',$6) RETURNING *
        `, [body.training_id, body.start_date, body.end_date || null,
            body.location || null, body.trainer || null,
            body.max_places || 20])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/enrollments
  fastify.get('/enrollments', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { session_id, employee_id } = request.query as Record<string, string>
      let sql = `SELECT te.*,
                   e.first_name, e.last_name,
                   ts.start_date AS session_start, ts.location,
                   t.title AS training_title, t.is_fdfp_eligible, t.category
                 FROM "${schema}".training_enrollments te
                 JOIN "${schema}".employees e ON e.id = te.employee_id
                 JOIN "${schema}".training_sessions ts ON ts.id = te.session_id
                 JOIN "${schema}".trainings t ON t.id = ts.training_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (session_id)  { sql += ` AND te.session_id = $${idx++}`; params.push(session_id) }
      if (employee_id) { sql += ` AND te.employee_id = $${idx++}`; params.push(employee_id) }
      sql += ` ORDER BY te.created_at DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/enroll
  fastify.post('/enroll', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as { session_id: string; employee_id?: string }
      try {
        let employeeId = body.employee_id
        if (!employeeId || request.user.role === 'employee') {
          const emp = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
          )
          if (!emp.rows[0]) return reply.status(400).send({ error: 'Employé introuvable' })
          employeeId = emp.rows[0].id as string
        }
        // Vérifier places
        const session = await pool.query(`
          SELECT ts.max_places, COUNT(te.id)::int AS enrolled
          FROM "${schema}".training_sessions ts
          LEFT JOIN "${schema}".training_enrollments te ON te.session_id = ts.id
          WHERE ts.id = $1 GROUP BY ts.id
        `, [body.session_id])
        if (!session.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
        if (session.rows[0].enrolled >= session.rows[0].max_places) {
          return reply.status(400).send({ error: 'Session complète' })
        }
        const res = await pool.query(`
          INSERT INTO "${schema}".training_enrollments (session_id, employee_id, status)
          VALUES ($1,$2,'enrolled') RETURNING *
        `, [body.session_id, employeeId])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /training/my-enrollments
  fastify.get('/my-enrollments', {
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
          SELECT te.*,
            ts.start_date AS session_start, ts.end_date AS session_end,
            ts.location, ts.trainer,
            t.title AS training_title, t.duration, t.duration_unit,
            t.category, t.is_fdfp_eligible, t.format
          FROM "${schema}".training_enrollments te
          JOIN "${schema}".training_sessions ts ON ts.id = te.session_id
          JOIN "${schema}".trainings t ON t.id = ts.training_id
          WHERE te.employee_id = $1
          ORDER BY ts.start_date DESC
        `, [employeeId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /training/fdfp/request — demande remboursement FDFP
  fastify.post('/fdfp/request', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['training'], summary: 'Soumettre demande remboursement FDFP CI' },
    handler: async (request, reply) => {
      const {
        training_title, training_id, session_date, employees_count,
        total_cost, provider_name, fdfp_code,
      } = request.body as {
        training_title: string; training_id?: string; session_date: string
        employees_count: number; total_cost: number
        provider_name: string; fdfp_code?: string
      }
      const schema = request.user.schemaName

      if (!training_title || !session_date || !total_cost || !provider_name) {
        return reply.status(400).send({ error: 'training_title, session_date, total_cost et provider_name requis' })
      }

      const estimated_refund = Math.floor(total_cost * 0.5)
      await rawPool.query(
        `INSERT INTO "${schema}".hr_events
           (type, title, description, date, metadata, created_by)
         VALUES ('fdfp_request','Demande remboursement FDFP',$1,$2,$3,$4)`,
        [
          `Formation : ${training_title} · Organisme : ${provider_name}`,
          session_date,
          JSON.stringify({
            training_title, training_id: training_id ?? null, session_date,
            employees_count, total_cost, provider_name,
            fdfp_code: fdfp_code ?? null,
            estimated_refund, currency: 'XOF',
            status: 'pending_validation',
          }),
          request.user.sub,
        ]
      )

      return reply.status(201).send({
        message: 'Demande FDFP enregistrée',
        data: {
          training_title, session_date, employees_count,
          total_cost, estimated_refund,
          fdfp_code: fdfp_code ?? null,
          status: 'pending_validation', currency: 'XOF',
        },
      })
    },
  })

  // GET /training/fdfp/eligible — liste formations agréées FDFP
  fastify.get('/fdfp/eligible', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'readonly')],
    schema: { tags: ['training'], summary: 'Formations éligibles remboursement FDFP' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT t.*, COUNT(ts.id)::int AS sessions_count
         FROM "${schema}".trainings t
         LEFT JOIN "${schema}".training_sessions ts ON ts.training_id = t.id
         WHERE t.is_fdfp_eligible = true AND t.is_active = true
         GROUP BY t.id ORDER BY t.title`
      )
      return reply.send({ data: res.rows })
    },
  })
}

export default trainingRoutes
