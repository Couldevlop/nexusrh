import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })

const careersRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /careers/skills
  fastify.get('/skills', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(
          `SELECT * FROM "${schema}".career_skills WHERE is_active = true ORDER BY category, name`
        )
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /careers/skills
  fastify.post('/skills', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as { name: string; category?: string }
      try {
        const res = await pool.query(
          `INSERT INTO "${schema}".career_skills (name, category) VALUES ($1,$2) RETURNING *`,
          [body.name, body.category || null]
        )
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/employee-skills/:employeeId
  fastify.get('/employee-skills/:employeeId', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      try {
        const res = await pool.query(`
          SELECT es.*, cs.name AS skill_name, cs.category
          FROM "${schema}".employee_skills es
          JOIN "${schema}".career_skills cs ON cs.id = es.skill_id
          WHERE es.employee_id = $1
          ORDER BY cs.category, cs.name
        `, [employeeId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PUT /careers/employee-skills
  fastify.put('/employee-skills', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        employee_id: string
        skills: Array<{ skill_id: string; level: number; target_level?: number }>
      }
      try {
        for (const skill of body.skills) {
          await pool.query(`
            INSERT INTO "${schema}".employee_skills (employee_id, skill_id, level, target_level, updated_at)
            VALUES ($1,$2,$3,$4,now())
            ON CONFLICT (employee_id, skill_id) DO UPDATE
            SET level = $3, target_level = $4, updated_at = now()
          `, [body.employee_id, skill.skill_id, skill.level, skill.target_level || null])
        }
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/evaluations
  fastify.get('/evaluations', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employee_id, year, status } = request.query as Record<string, string>
      let sql = `SELECT ev.*, e.first_name, e.last_name, e.job_title,
                   ev2.first_name AS evaluator_first_name, ev2.last_name AS evaluator_last_name
                 FROM "${schema}".evaluations ev
                 JOIN "${schema}".employees e ON e.id = ev.employee_id
                 LEFT JOIN "${schema}".employees ev2 ON ev2.id = ev.evaluator_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (request.user.role === 'manager') {
        const mgr = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        if (mgr.rows[0]) { sql += ` AND e.manager_id = $${idx++}`; params.push(mgr.rows[0].id) }
      }
      if (employee_id) { sql += ` AND ev.employee_id = $${idx++}`; params.push(employee_id) }
      if (year)        { sql += ` AND ev.year = $${idx++}`; params.push(parseInt(year)) }
      if (status)      { sql += ` AND ev.status = $${idx++}`; params.push(status) }
      sql += ` ORDER BY ev.year DESC, ev.created_at DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /careers/evaluations
  fastify.post('/evaluations', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as Record<string, unknown>
      try {
        const evaluatorRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        const evaluatorId = evaluatorRes.rows[0]?.id || null
        const res = await pool.query(`
          INSERT INTO "${schema}".evaluations
            (employee_id, evaluator_id, type, year, period, status,
             global_score, performance_score, goals_score, skills_score,
             comments, goals, strengths, improvements, training_needs)
          VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14)
          RETURNING *
        `, [
          body.employee_id, evaluatorId,
          body.type || 'annual', body.year || new Date().getFullYear(),
          body.period || null,
          body.global_score || null, body.performance_score || null,
          body.goals_score || null, body.skills_score || null,
          body.comments || null,
          JSON.stringify(body.goals || []),
          JSON.stringify(body.strengths || []),
          JSON.stringify(body.improvements || []),
          JSON.stringify(body.training_needs || []),
        ])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /careers/evaluations/:id
  fastify.patch('/evaluations/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const scalarFields = [
        'global_score','performance_score','goals_score','skills_score',
        'comments','manager_comments','employee_comments','status',
        'signed_by_employee','signed_by_manager',
      ]
      const jsonFields = ['goals','strengths','improvements','training_needs']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of scalarFields) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      for (const f of jsonFields) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(JSON.stringify(body[f])) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      if (body.status === 'completed') updates.push(`completed_at = now()`)
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".evaluations SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/my-evaluations — entretiens de l'employé connecté
  fastify.get('/my-evaluations', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const empRes = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE user_id = $1
           UNION SELECT id FROM "${schema}".employees WHERE email = $2
           LIMIT 1`,
          [request.user.sub, request.user.email]
        )
        const empId = empRes.rows[0]?.id
        if (!empId) return reply.send({ data: [] })

        const res = await pool.query(`
          SELECT ev.id, ev.type, ev.year, ev.status,
                 ev.global_score, ev.performance_score, ev.skills_score,
                 ev.comments AS notes, ev.manager_comments, ev.created_at, ev.completed_at,
                 e2.first_name AS evaluator_first_name,
                 e2.last_name  AS evaluator_last_name
          FROM "${schema}".evaluations ev
          LEFT JOIN "${schema}".employees e2 ON e2.id = ev.evaluator_id
          WHERE ev.employee_id = $1
          ORDER BY ev.year DESC, ev.created_at DESC
        `, [empId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/my-skills — compétences de l'employé connecté
  fastify.get('/my-skills', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const empRes = await pool.query<{ id: string }>(
          `SELECT id FROM "${schema}".employees WHERE user_id = $1
           UNION SELECT id FROM "${schema}".employees WHERE email = $2
           LIMIT 1`,
          [request.user.sub, request.user.email]
        )
        const empId = empRes.rows[0]?.id
        if (!empId) return reply.send({ data: [] })

        const res = await pool.query(`
          SELECT es.level, es.target_level,
                 cs.name AS skill_name, cs.category
          FROM "${schema}".employee_skills es
          JOIN "${schema}".career_skills cs ON cs.id = es.skill_id
          WHERE es.employee_id = $1
          ORDER BY cs.category NULLS LAST, cs.name
        `, [empId])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /careers/nine-box
  fastify.get('/nine-box', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { year = String(new Date().getFullYear()) } = request.query as Record<string, string>
      try {
        const res = await pool.query(`
          SELECT e.id, e.first_name, e.last_name, e.job_title, d.name AS department,
            ev.global_score AS performance, ev.skills_score AS potential,
            e.retention_score
          FROM "${schema}".employees e
          JOIN "${schema}".evaluations ev ON ev.employee_id = e.id
            AND ev.year = $1 AND ev.type = 'annual' AND ev.status = 'completed'
          LEFT JOIN "${schema}".departments d ON d.id = e.department_id
          WHERE e.is_active = true AND e.deleted_at IS NULL
          ORDER BY ev.global_score DESC NULLS LAST
        `, [parseInt(year)])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default careersRoutes
