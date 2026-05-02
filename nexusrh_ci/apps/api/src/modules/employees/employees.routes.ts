import type { FastifyPluginAsync } from 'fastify'
import { eq, and, isNull, like, or } from 'drizzle-orm'
import { getTenantDbForRequest } from '../../plugins/tenant.js'
import { createTenantSchema } from '../../db/schema/tenant.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

const employeesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /employees
  fastify.get('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    schema: { tags: ['employees'], summary: 'Liste des employés' },
    handler: async (request, reply) => {
      const { search, departmentId, isActive = 'true' } = request.query as Record<string, string>
      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName

      let sql = `SELECT e.*, d.name AS department_name
                 FROM "${schema}".employees e
                 LEFT JOIN "${schema}".departments d ON d.id = e.department_id
                 WHERE e.deleted_at IS NULL`
      const params: unknown[] = []
      let idx = 1

      if (isActive === 'true') { sql += ` AND e.is_active = true` }
      if (departmentId) { sql += ` AND e.department_id = $${idx++}`; params.push(departmentId) }
      if (search) {
        sql += ` AND (lower(e.first_name) LIKE $${idx} OR lower(e.last_name) LIKE $${idx} OR e.cnps_number LIKE $${idx})`
        params.push(`%${search.toLowerCase()}%`); idx++
      }
      // Si manager : filtre équipe directe
      if (request.user.role === 'manager') {
        const empRes = await pool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        const mgr = empRes.rows[0]
        if (mgr) { sql += ` AND e.manager_id = $${idx++}`; params.push(mgr.id) }
      }

      sql += ` ORDER BY e.last_name, e.first_name`
      const res = await pool.query(sql, params)
      await pool.end()
      return reply.send({ data: res.rows, total: res.rowCount })
    },
  })

  // GET /employees/:id
  fastify.get('/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','employee','readonly')],
    schema: { tags: ['employees'], summary: 'Détail d\'un employé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName

      const res = await pool.query(
        `SELECT e.*, d.name AS department_name,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
         FROM "${schema}".employees e
         LEFT JOIN "${schema}".departments d ON d.id = e.department_id
         LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
         WHERE e.id = $1 AND e.deleted_at IS NULL LIMIT 1`,
        [id]
      )
      await pool.end()
      if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })

      // employee ne peut voir que son propre profil
      if (request.user.role === 'employee' && res.rows[0].email !== request.user.email) {
        return reply.status(403).send({ error: 'Accès interdit' })
      }

      return reply.send({ data: res.rows[0] })
    },
  })

  // POST /employees
  fastify.post('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    schema: { tags: ['employees'], summary: 'Créer un employé CI' },
    handler: async (request, reply) => {
      const body = request.body as {
        firstName: string; lastName: string; email?: string
        phone?: string; birthDate?: string; gender?: string
        nni?: string; cnpsNumber?: string
        mobileMoneyProvider?: string; mobileMoneyPhone?: string
        departmentId?: string; managerId?: string
        jobTitle?: string; jobLevel?: string; contractType?: string
        hireDate?: string; baseSalary: number
        city?: string; maritalStatus?: string; childrenCount?: number
      }
      if (!body.firstName || !body.lastName || body.baseSalary == null) {
        return reply.status(400).send({ error: 'firstName, lastName et baseSalary sont requis' })
      }
      if (body.baseSalary < 75000) {
        return reply.status(422).send({ error: 'Le salaire ne peut pas être inférieur au SMIG (75 000 FCFA)' })
      }

      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName

      const res = await pool.query(
        `INSERT INTO "${schema}".employees
           (first_name, last_name, email, phone, birth_date, gender,
            nni, cnps_number, mobile_money_provider, mobile_money_phone,
            department_id, manager_id, job_title, job_level, contract_type,
            hire_date, base_salary, city, marital_status, children_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          body.firstName, body.lastName, body.email ?? null, body.phone ?? null,
          body.birthDate ?? null, body.gender ?? null,
          body.nni ?? null, body.cnpsNumber ?? null,
          body.mobileMoneyProvider ?? null, body.mobileMoneyPhone ?? null,
          body.departmentId ?? null, body.managerId ?? null,
          body.jobTitle ?? null, body.jobLevel ?? null, body.contractType ?? 'cdi',
          body.hireDate ?? null, body.baseSalary,
          body.city ?? 'Abidjan', body.maritalStatus ?? null, body.childrenCount ?? 0,
        ]
      )
      await pool.end()
      return reply.status(201).send({ data: res.rows[0] })
    },
  })

  // PATCH /employees/:id
  fastify.patch('/:id', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','employee')],
    schema: { tags: ['employees'], summary: 'Modifier un employé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      // employee ne peut modifier que certains champs de son propre profil
      const allowedForEmployee = ['phone', 'address', 'mobile_money_provider', 'mobile_money_phone']
      const allowedForHR = [
        'first_name','last_name','email','phone','birth_date','gender',
        'nni','cnps_number','mobile_money_provider','mobile_money_phone',
        'department_id','manager_id','job_title','job_level','contract_type',
        'hire_date','base_salary','city','marital_status','children_count',
        'is_active','profile_photo_url',
      ]

      const allowed = request.user.role === 'employee' ? allowedForEmployee : allowedForHR

      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName

      // Vérification SMIG si modification salaire
      if (body.base_salary != null && Number(body.base_salary) < 75000) {
        await pool.end()
        return reply.status(422).send({ error: 'Salaire inférieur au SMIG (75 000 FCFA)' })
      }

      const sets: string[] = []
      const vals: unknown[] = []
      let idx = 1
      for (const [k, v] of Object.entries(body)) {
        const dbKey = k.replace(/([A-Z])/g, '_$1').toLowerCase()
        if (allowed.includes(dbKey)) {
          sets.push(`${dbKey} = $${idx++}`)
          vals.push(v)
        }
      }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ valide' })
      sets.push(`updated_at = now()`)
      vals.push(id)
      const res = await pool.query(
        `UPDATE "${schema}".employees SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
        vals
      )
      await pool.end()
      return reply.send({ data: res.rows[0] })
    },
  })

  // GET /employees/:id/check-delete — vérifie les actions en attente avant suppression
  fastify.get('/:id/check-delete', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['employees'], summary: 'Vérifier si un employé peut être supprimé' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName
      try {
        const pending: Array<{ type: string; label: string; path: string; count: number }> = []

        const absRes = await pool.query(
          `SELECT COUNT(*) FROM "${schema}".absences WHERE employee_id = $1 AND status IN ('submitted','pending')`, [id]
        )
        const absCount = parseInt(absRes.rows[0].count)
        if (absCount > 0) pending.push({ type: 'absences', label: `${absCount} absence(s) en attente de validation`, path: '/absences', count: absCount })

        const expRes = await pool.query(
          `SELECT COUNT(*) FROM "${schema}".expense_reports WHERE employee_id = $1 AND status IN ('draft','submitted')`, [id]
        )
        const expCount = parseInt(expRes.rows[0].count)
        if (expCount > 0) pending.push({ type: 'expenses', label: `${expCount} note(s) de frais non clôturée(s)`, path: '/expenses', count: expCount })

        await pool.end()
        return reply.send({ canDelete: pending.length === 0, pendingActions: pending })
      } catch (err) {
        fastify.log.error(err)
        await pool.end()
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /employees/:id (soft delete)
  fastify.delete('/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    schema: { tags: ['employees'], summary: 'Archiver un employé (soft delete)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName
      try {
        await pool.query(
          `UPDATE "${schema}".employees SET deleted_at = now(), is_active = false WHERE id = $1`, [id]
        )
        await pool.end()
        return reply.send({ message: 'Employé archivé' })
      } catch (err) {
        fastify.log.error(err)
        await pool.end()
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /employees/departments
  fastify.get('/departments', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    schema: { tags: ['employees'], summary: 'Liste des départements' },
    handler: async (request, reply) => {
      const { Pool } = await import('pg')
      const { config } = await import('../../config.js')
      const pool = new (Pool as any)({ connectionString: config.database.url })
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT d.*, e.first_name AS manager_first_name, e.last_name AS manager_last_name
         FROM "${schema}".departments d
         LEFT JOIN "${schema}".employees e ON e.id = d.manager_id
         ORDER BY d.name`
      )
      await pool.end()
      return reply.send({ data: res.rows })
    },
  })
}

export default employeesRoutes
