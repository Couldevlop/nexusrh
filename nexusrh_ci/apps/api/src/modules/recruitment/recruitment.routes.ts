import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'

const pool = new Pool({ connectionString: config.database.url })

const recruitmentRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /recruitment/jobs
  fastify.get('/jobs', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { status, limit = '50', offset = '0' } = request.query as Record<string, string>
      let sql = `SELECT rj.*, d.name AS department_name,
                   COUNT(a.id)::int AS applications_count
                 FROM "${schema}".recruitment_jobs rj
                 LEFT JOIN "${schema}".departments d ON d.id = rj.department_id
                 LEFT JOIN "${schema}".applications a ON a.job_id = rj.id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (status) { sql += ` AND rj.status = $${idx++}`; params.push(status) }
      sql += ` GROUP BY rj.id, d.name ORDER BY rj.created_at DESC`
      sql += ` LIMIT $${idx++} OFFSET $${idx++}`
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

  // POST /recruitment/jobs
  fastify.post('/jobs', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as Record<string, unknown>
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".recruitment_jobs
            (title, department_id, location, contract_type, salary_min, salary_max,
             description, requirements, status, published_at, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [
          body.title, body.department_id || null,
          body.location || 'Abidjan', body.contract_type || 'cdi',
          body.salary_min || null, body.salary_max || null,
          body.description || null, body.requirements || null,
          body.status || 'open',
          body.status === 'open' ? new Date() : null,
          request.user.sub,
        ])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /recruitment/jobs/:id
  fastify.get('/jobs/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const jobRes = await pool.query(`
          SELECT rj.*, d.name AS department_name
          FROM "${schema}".recruitment_jobs rj
          LEFT JOIN "${schema}".departments d ON d.id = rj.department_id
          WHERE rj.id = $1
        `, [id])
        if (!jobRes.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
        const appsRes = await pool.query(
          `SELECT * FROM "${schema}".applications WHERE job_id = $1 ORDER BY created_at DESC`, [id]
        )
        return reply.send({ data: { ...jobRes.rows[0], applications: appsRes.rows } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /recruitment/jobs/:id
  fastify.patch('/jobs/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const fields = ['title','department_id','location','contract_type',
        'salary_min','salary_max','description','requirements','status']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of fields) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".recruitment_jobs SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /recruitment/jobs/:id
  fastify.delete('/jobs/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        await pool.query(`DELETE FROM "${schema}".recruitment_jobs WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /recruitment/applications
  fastify.get('/applications', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { job_id, stage } = request.query as Record<string, string>
      let sql = `SELECT a.*, rj.title AS job_title
                 FROM "${schema}".applications a
                 JOIN "${schema}".recruitment_jobs rj ON rj.id = a.job_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (job_id) { sql += ` AND a.job_id = $${idx++}`; params.push(job_id) }
      if (stage)  { sql += ` AND a.stage = $${idx++}`; params.push(stage) }
      sql += ` ORDER BY a.created_at DESC`
      try {
        const res = await pool.query(sql, params)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /recruitment/applications
  fastify.post('/applications', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as Record<string, unknown>
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".applications
            (job_id, first_name, last_name, email, phone, cover_letter, stage)
          VALUES ($1,$2,$3,$4,$5,$6,'new') RETURNING *
        `, [body.job_id, body.first_name, body.last_name, body.email,
            body.phone || null, body.cover_letter || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /recruitment/applications/:id/stage
  fastify.patch('/applications/:id/stage', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const { stage, notes } = request.body as { stage: string; notes?: string }
      const STAGES = ['new','screening','interview','test','offer','hired','rejected']
      if (!STAGES.includes(stage)) return reply.status(400).send({ error: 'Stage invalide' })
      try {
        const res = await pool.query(`
          UPDATE "${schema}".applications
          SET stage = $1, notes = COALESCE($2, notes), updated_at = now()
          WHERE id = $3 RETURNING *
        `, [stage, notes || null, id])
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
}

export default recruitmentRoutes
