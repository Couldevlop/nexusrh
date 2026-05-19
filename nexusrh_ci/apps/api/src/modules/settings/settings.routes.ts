import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { randomBytes } from 'crypto'
import { config } from '../../config.js'
import bcrypt from 'bcryptjs'
import { provisionTenantSchema } from '../../db/provisioning.js'
import { sendEmployeeWelcomeEmail } from '../../services/email.js'

function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const special = '!@#$'
  const all = upper + lower + digits + special
  const rand = (s: string) => s[randomBytes(1)[0]! % s.length]!
  const chars = [rand(upper), rand(lower), rand(digits), rand(special),
    ...Array.from({ length: 8 }, () => rand(all))]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

const pool = new Pool({ connectionString: config.database.url })

// Applique les migrations lazy (legal_entities, variable_elements.month, etc.)
async function ensureMigrated(schemaName: string) {
  try { await provisionTenantSchema(schemaName) } catch { /* ignore */ }
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /settings/tenant
  fastify.get('/tenant', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      try {
        const res = await pool.query(
          `SELECT id, slug, name, plan_type, status, sector, city, cnps_number,
                  dgi_number, rccm, at_rate, max_users, max_employees,
                  primary_color, secondary_color, logo_url, trial_ends_at,
                  created_at, updated_at
           FROM platform.tenants WHERE id = $1`, [tenantId]
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Tenant introuvable' })
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/tenant
  fastify.patch('/tenant', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })
      const body = request.body as Record<string, unknown>
      const allowed = ['name','primary_color','secondary_color','logo_url','city','cnps_number','dgi_number','rccm','at_rate']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of allowed) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ modifiable' })
      updates.push(`updated_at = now()`)
      values.push(tenantId)
      try {
        const res = await pool.query(
          `UPDATE platform.tenants SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/users
  fastify.get('/users', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`
          SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.is_active,
            u.last_login_at, u.created_at,
            e.id AS employee_id, e.job_title
          FROM "${schema}".users u
          LEFT JOIN "${schema}".employees e ON e.id = u.employee_id
          ORDER BY u.created_at DESC
        `)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/users
  fastify.post('/users', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        email: string; first_name: string; last_name: string
        role?: string; department_id?: string; is_active?: boolean
      }
      try {
        const tempPassword = generateTempPassword()
        const hash = await bcrypt.hash(tempPassword, 12)
        const isActive = body.is_active !== false

        // Si un département est fourni, créer/lier un employé
        let employeeId: string | null = null
        if (body.department_id) {
          // Vérifier s'il existe déjà un employé avec cet email
          const existing = await pool.query(
            `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [body.email]
          )
          if (existing.rows[0]) {
            employeeId = existing.rows[0].id as string
            await pool.query(
              `UPDATE "${schema}".employees SET department_id = $1, updated_at = now() WHERE id = $2`,
              [body.department_id, employeeId]
            )
          } else {
            const emp = await pool.query(`
              INSERT INTO "${schema}".employees
                (first_name, last_name, email, hire_date, is_active, job_title, base_salary, contract_type, department_id)
              VALUES ($1,$2,$3,NOW(),$4,'Employé',60000,'cdi',$5) RETURNING id
            `, [body.first_name, body.last_name, body.email, isActive, body.department_id])
            employeeId = emp.rows[0].id as string
          }
        }

        const res = await pool.query(`
          INSERT INTO "${schema}".users
            (email, password_hash, first_name, last_name, role, is_active, employee_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING id, email, first_name, last_name, role, is_active, created_at
        `, [body.email, hash, body.first_name, body.last_name, body.role ?? 'employee', isActive, employeeId])

        // Lier l'employee_id si créé
        if (employeeId) {
          await pool.query(
            `UPDATE "${schema}".users SET employee_id = $1 WHERE id = $2`,
            [employeeId, res.rows[0].id]
          )
        }

        return reply.status(201).send({ data: res.rows[0], tempPassword })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur lors de la création' })
      }
    },
  })

  // PATCH /settings/users/:id
  fastify.patch('/users/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const { role, is_active } = request.body as { role?: string; is_active?: boolean }
      const updates: string[] = []
      const values: unknown[] = []
      if (role !== undefined)      { updates.push(`role = $${values.length + 1}`); values.push(role) }
      if (is_active !== undefined) { updates.push(`is_active = $${values.length + 1}`); values.push(is_active) }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".users SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING id, email, role, is_active`,
          values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/absence-types
  fastify.get('/absence-types', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`SELECT * FROM "${schema}".absence_types ORDER BY code`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/departments
  fastify.get('/departments', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`
          SELECT d.*, COUNT(e.id)::int AS employees_count
          FROM "${schema}".departments d
          LEFT JOIN "${schema}".employees e ON e.department_id = d.id AND e.is_active = true
          GROUP BY d.id ORDER BY d.name
        `)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/departments
  fastify.post('/departments', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as { name: string; code?: string; manager_id?: string }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".departments (name, code, manager_id)
          VALUES ($1,$2,$3) RETURNING *
        `, [body.name, body.code || null, body.manager_id || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/departments/:id
  fastify.patch('/departments/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; code?: string; manager_id?: string }
      const updates: string[] = []
      const values: unknown[] = []
      if (body.name !== undefined)       { updates.push(`name = $${values.length + 1}`);       values.push(body.name) }
      if (body.code !== undefined)       { updates.push(`code = $${values.length + 1}`);       values.push(body.code) }
      if (body.manager_id !== undefined) { updates.push(`manager_id = $${values.length + 1}`); values.push(body.manager_id) }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".departments SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/departments/:id
  fastify.delete('/departments/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const check = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM "${schema}".employees WHERE department_id = $1 AND is_active = true`, [id]
        )
        if ((check.rows[0]?.cnt ?? 0) > 0) {
          return reply.status(409).send({ error: 'Ce departement contient des employes actifs' })
        }
        await pool.query(`DELETE FROM "${schema}".departments WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/absence-types
  fastify.post('/absence-types', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        code: string; label: string; color?: string
        requires_approval?: boolean; max_days_per_year?: number
        is_paid?: boolean; calculation_mode?: string
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".absence_types
            (code, label, color, requires_approval, max_days_per_year, is_paid, calculation_mode)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        `, [body.code, body.label, body.color || '#6366F1',
            body.requires_approval ?? true, body.max_days_per_year || null,
            body.is_paid ?? true, body.calculation_mode || 'working_days'])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/absence-types/:id
  fastify.patch('/absence-types/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['label','color','requires_approval','max_days_per_year','is_paid','calculation_mode','is_active']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of allowed) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".absence_types SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/absence-types/:id
  fastify.delete('/absence-types/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const check = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM "${schema}".absences WHERE absence_type_id = $1`, [id]
        )
        if ((check.rows[0]?.cnt ?? 0) > 0) {
          return reply.status(409).send({ error: 'Ce type est utilise par des absences existantes' })
        }
        await pool.query(`DELETE FROM "${schema}".absence_types WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/payroll-rules
  fastify.get('/payroll-rules', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`SELECT * FROM "${schema}".payroll_rules ORDER BY "order", code`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/payroll-rules
  fastify.post('/payroll-rules', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        code: string; name: string; type: string; formula?: string
        rate?: number; ceiling_type?: string; is_active?: boolean; order?: number; description?: string
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".payroll_rules
            (code, name, type, formula, rate, ceiling_type, is_active, "order", description)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [body.code, body.name, body.type, body.formula || null,
            body.rate !== undefined ? body.rate : null, body.ceiling_type || null,
            body.is_active ?? true, body.order || 99, body.description || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/payroll-rules/:id
  fastify.patch('/payroll-rules/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['name','formula','rate','ceiling_type','is_active','order','description']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of allowed) {
        if (f in body) {
          updates.push(`${f === 'order' ? '"order"' : f} = $${values.length + 1}`)
          values.push(body[f])
        }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".payroll_rules SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/payroll-rules/:id
  fastify.delete('/payroll-rules/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        await pool.query(`DELETE FROM "${schema}".payroll_rules WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/legal-entities
  fastify.get('/legal-entities', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      try {
        const res = await pool.query(`
          SELECT le.*, COUNT(e.id)::int AS employees_count
          FROM "${schema}".legal_entities le
          LEFT JOIN "${schema}".employees e ON e.legal_entity_id = le.id AND e.is_active = true AND e.deleted_at IS NULL
          GROUP BY le.id ORDER BY le.name
        `)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/legal-entities
  fastify.post('/legal-entities', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      const body = request.body as {
        name: string; rccm?: string; cnps_number?: string; dgi_number?: string
        address?: string; city?: string; legal_form?: string
        collective_agreement?: string; at_rate?: number
        country_code?: string; legislation_pack_code?: string
      }
      if (!body.name || body.name.trim().length === 0) {
        return reply.status(400).send({ error: 'Le nom de la filiale est obligatoire' })
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".legal_entities
            (name, rccm, cnps_number, dgi_number, address, city, legal_form,
             collective_agreement, at_rate, country_code, legislation_pack_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [body.name, body.rccm || null, body.cnps_number || null, body.dgi_number || null,
            body.address || null, body.city || 'Abidjan', body.legal_form || 'SARL',
            body.collective_agreement || null, body.at_rate || 0.02,
            body.country_code || 'CIV', body.legislation_pack_code || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/legal-entities/:id
  fastify.patch('/legal-entities/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>
      const allowed = ['name','rccm','cnps_number','dgi_number','address','city',
        'legal_form','collective_agreement','at_rate','country_code','legislation_pack_code','is_active']
      const updates: string[] = []
      const values: unknown[] = []
      for (const f of allowed) {
        if (f in body) { updates.push(`${f} = $${values.length + 1}`); values.push(body[f]) }
      }
      if (!updates.length) return reply.status(400).send({ error: 'Aucun champ' })
      updates.push(`updated_at = now()`)
      values.push(id)
      try {
        const res = await pool.query(
          `UPDATE "${schema}".legal_entities SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values
        )
        return reply.send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/legal-entities/:id
  fastify.delete('/legal-entities/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        const check = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM "${schema}".employees WHERE legal_entity_id = $1 AND is_active = true`, [id]
        )
        if ((check.rows[0]?.cnt ?? 0) > 0) {
          return reply.status(409).send({ error: 'Cette entite a des employes actifs' })
        }
        await pool.query(`DELETE FROM "${schema}".legal_entities WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/workflow
  fastify.get('/workflow', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`SELECT * FROM "${schema}".workflow_configs ORDER BY module`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PATCH /settings/workflow
  fastify.patch('/workflow', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const configs = request.body as Array<{ module: string; levels_count: number }>
      try {
        for (const cfg of configs) {
          await pool.query(`
            INSERT INTO "${schema}".workflow_configs (module, levels_count)
            VALUES ($1,$2)
            ON CONFLICT (module) DO UPDATE SET levels_count = EXCLUDED.levels_count
          `, [cfg.module, cfg.levels_count])
        }
        const res = await pool.query(`SELECT * FROM "${schema}".workflow_configs ORDER BY module`)
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // GET /settings/variable-elements
  fastify.get('/variable-elements', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureMigrated(schema)
      const { month } = request.query as { month?: string }
      try {
        const res = await pool.query(`
          SELECT ve.*, e.first_name, e.last_name, e.registration_number
          FROM "${schema}".variable_elements ve
          JOIN "${schema}".employees e ON e.id = ve.employee_id
          WHERE ($1::text IS NULL OR ve.month = $1)
          ORDER BY e.last_name, e.first_name, ve.rule_code
        `, [month || null])
        return reply.send({ data: res.rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/variable-elements
  fastify.post('/variable-elements', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const body = request.body as {
        employee_id: string; rule_code: string; amount: number; month: string; description?: string
      }
      try {
        const res = await pool.query(`
          INSERT INTO "${schema}".variable_elements
            (employee_id, rule_code, amount, month, description)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (employee_id, rule_code, month)
            DO UPDATE SET amount = EXCLUDED.amount, description = EXCLUDED.description
          RETURNING *
        `, [body.employee_id, body.rule_code, body.amount, body.month, body.description || null])
        return reply.status(201).send({ data: res.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/variable-elements/:id
  fastify.delete('/variable-elements/:id', {
    preHandler: [fastify.authorize('admin','hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      try {
        await pool.query(`DELETE FROM "${schema}".variable_elements WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // DELETE /settings/users/:id
  fastify.delete('/users/:id', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (id === request.user.sub) return reply.status(400).send({ error: 'Impossible de supprimer votre propre compte' })
      try {
        await pool.query(`DELETE FROM "${schema}".users WHERE id = $1`, [id])
        return reply.send({ success: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // POST /settings/users/:id/reset-password — réinitialise le mot de passe et renvoie l'email
  fastify.post('/users/:id/reset-password', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const tenantId = request.user.tenantId
      try {
        const userRes = await pool.query(
          `SELECT email, first_name, last_name FROM "${schema}".users WHERE id = $1 LIMIT 1`, [id]
        )
        const user = userRes.rows[0] as { email: string; first_name: string; last_name: string } | undefined
        if (!user) return reply.status(404).send({ error: 'Utilisateur introuvable' })

        const tempPassword = generateTempPassword()
        const hash = await bcrypt.hash(tempPassword, 12)
        await pool.query(
          `UPDATE "${schema}".users SET password_hash = $1, last_login_at = NULL, updated_at = now() WHERE id = $2`,
          [hash, id]
        )

        // Essayer d'envoyer l'email (non bloquant)
        let emailSent = false
        if (tenantId) {
          try {
            const tenantRes = await pool.query(
              `SELECT name, primary_color FROM platform.tenants WHERE id = $1`, [tenantId]
            )
            const tenant = tenantRes.rows[0] as { name: string; primary_color: string } | undefined
            await sendEmployeeWelcomeEmail({
              to: user.email,
              firstName: user.first_name,
              lastName: user.last_name,
              tenantName: tenant?.name ?? 'Votre entreprise',
              primaryColor: tenant?.primary_color ?? '#4F46E5',
              loginUrl: config.appUrl ?? 'http://localhost:3001',
              tempPassword,
            })
            emailSent = true
          } catch (emailErr) {
            fastify.log.warn({ emailErr }, 'reset-password email failed')
          }
        }

        return reply.send({ tempPassword, emailSent })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /settings/import/users-status ──────────────────────────────────────
  fastify.get('/import/users-status', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(`
          SELECT COUNT(*) AS total_employees,
            (SELECT COUNT(*) FROM "${schema}".users WHERE role = 'employee') AS total_users
          FROM "${schema}".employees WHERE is_active = true AND email IS NOT NULL AND email != ''
        `)
        const total = parseInt(res.rows[0]?.total_employees ?? '0')
        const withAccount = parseInt(res.rows[0]?.total_users ?? '0')
        return reply.send({ data: { totalEmployees: total, withAccount, withoutAccount: total - withAccount } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /settings/import/generate-users ────────────────────────────────────
  fastify.post('/import/generate-users', {
    preHandler: [fastify.authorize('admin')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const tenantId = request.user.tenantId
      if (!tenantId) return reply.status(403).send({ error: 'Accès interdit' })

      try {
        // Récupérer infos tenant pour l'email
        const tenantRes = await pool.query(
          `SELECT name, primary_color FROM platform.tenants WHERE id = $1`, [tenantId]
        )
        const tenant = tenantRes.rows[0] as { name: string; primary_color: string } | undefined
        const tenantName = tenant?.name ?? 'Votre entreprise'
        const primaryColor = tenant?.primary_color ?? '#4F46E5'
        const loginUrl = config.appUrl ?? 'http://localhost:3001'

        // Employés actifs sans compte utilisateur
        const empRes = await pool.query(`
          SELECT e.id, e.first_name, e.last_name, e.email
          FROM "${schema}".employees e
          WHERE e.is_active = true
            AND e.email IS NOT NULL AND e.email != ''
            AND NOT EXISTS (SELECT 1 FROM "${schema}".users u WHERE u.email = e.email)
          ORDER BY e.last_name, e.first_name
        `)
        const employees = empRes.rows as Array<{ id: string; first_name: string; last_name: string; email: string }>

        if (employees.length === 0) {
          return reply.send({ created: 0, emailSent: 0, emailFailed: 0, skipped: 0,
            message: 'Tous les employés actifs ont déjà un compte.' })
        }

        let created = 0
        let emailSent = 0
        let emailFailed = 0
        let emailError: string | null = null
        const BATCH_SIZE = 20

        for (let i = 0; i < employees.length; i += BATCH_SIZE) {
          const batch = employees.slice(i, i + BATCH_SIZE)

          // Générer et insérer les comptes en une seule transaction par batch
          const emailJobs: Array<{ emp: typeof batch[0]; tempPassword: string }> = []

          for (const emp of batch) {
            const tempPassword = generateTempPassword()
            const passwordHash = await bcrypt.hash(tempPassword, 12)
            try {
              await pool.query(`
                INSERT INTO "${schema}".users (email, password_hash, first_name, last_name, role, is_active, employee_id)
                VALUES ($1,$2,$3,$4,'employee',true,$5)
                ON CONFLICT (email) DO NOTHING
              `, [emp.email, passwordHash, emp.first_name, emp.last_name, emp.id])
              created++
              emailJobs.push({ emp, tempPassword })
            } catch {
              // doublon ou erreur → skip
            }
          }

          // Envoyer les emails du batch en parallèle
          const results = await Promise.allSettled(
            emailJobs.map(({ emp, tempPassword }) =>
              sendEmployeeWelcomeEmail({
                to: emp.email,
                firstName: emp.first_name,
                lastName: emp.last_name,
                tenantName,
                primaryColor,
                loginUrl,
                tempPassword,
              })
            )
          )
          emailSent += results.filter(r => r.status === 'fulfilled').length
          const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
          emailFailed += rejected.length
          if (rejected.length > 0) {
            const first = rejected[0]
            const msg = first ? ((first.reason as Error | undefined)?.message ?? 'Erreur SMTP inconnue') : 'Erreur SMTP inconnue'
            fastify.log.error({ smtpError: msg }, 'Email batch failed')
            if (!emailError) emailError = msg
          }

          // Pause courte entre batches pour ne pas saturer le SMTP
          if (i + BATCH_SIZE < employees.length) {
            await new Promise(r => setTimeout(r, 300))
          }
        }

        return reply.send({
          created,
          emailSent,
          emailFailed,
          emailError,
          skipped: employees.length - created,
          total: employees.length,
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur lors de la génération des accès' })
      }
    },
  })

  // ── POST /settings/import/:type ─────────────────────────────────────────────
  fastify.post('/import/:type', {
    preHandler: [fastify.authorize('admin', 'hr_manager')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { type } = request.params as { type: string }
      const { headers, rows } = request.body as { headers: string[]; rows: string[][] }

      if (!headers?.length || !rows?.length) {
        return reply.status(400).send({ error: 'Fichier vide ou format invalide' })
      }

      const idx = (col: string) => headers.indexOf(col)
      const get = (row: string[], col: string) => row[idx(col)]?.trim() ?? ''
      const toDate = (v: string) => {
        if (!v) return null
        // DD/MM/YYYY → YYYY-MM-DD
        const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
        if (m) { const [, d, mo, y] = m; if (d && mo && y) return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}` }
        return v // déjà au bon format
      }

      let inserted = 0
      let skipped = 0
      const errors: string[] = []

      try {
        if (type === 'employees') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email')
            if (!email) { errors.push(`Ligne ${i + 2}: email manquant`); skipped++; continue }
            const deptName = get(row, 'departement')
            let deptId: string | null = null
            if (deptName) {
              const d = await pool.query(`SELECT id FROM "${schema}".departments WHERE name ILIKE $1 LIMIT 1`, [deptName])
              deptId = d.rows[0]?.id ?? null
            }
            try {
              await pool.query(`
                INSERT INTO "${schema}".employees
                  (first_name, last_name, email, birth_date, phone, job_title, department_id,
                   hire_date, base_salary, contract_type, is_active, gender, cnps_number, city)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                ON CONFLICT (email) DO UPDATE SET
                  first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
                  birth_date=EXCLUDED.birth_date, phone=EXCLUDED.phone,
                  job_title=EXCLUDED.job_title, department_id=EXCLUDED.department_id,
                  hire_date=EXCLUDED.hire_date, base_salary=EXCLUDED.base_salary,
                  contract_type=EXCLUDED.contract_type, is_active=EXCLUDED.is_active,
                  gender=EXCLUDED.gender, cnps_number=EXCLUDED.cnps_number,
                  city=EXCLUDED.city, updated_at=now()
              `, [
                get(row, 'prenom'), get(row, 'nom'), email,
                toDate(get(row, 'date_naissance')), get(row, 'telephone') || null,
                get(row, 'poste') || 'Employé', deptId,
                toDate(get(row, 'date_embauche')) || new Date().toISOString().slice(0, 10),
                parseInt(get(row, 'salaire_brut')) || 75000,
                (get(row, 'type_contrat') || 'cdi').toLowerCase(),
                get(row, 'statut') !== 'inactive',
                get(row, 'sexe') || null,
                get(row, 'numero_cnps') || null,
                get(row, 'ville') || 'Abidjan',
              ])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2} (${email}): ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'departments') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const name = get(row, 'nom')
            if (!name) { skipped++; continue }
            const ex = await pool.query(`SELECT id FROM "${schema}".departments WHERE name ILIKE $1 LIMIT 1`, [name])
            if (ex.rows[0]) { skipped++; continue }
            try {
              await pool.query(`INSERT INTO "${schema}".departments (name, code) VALUES ($1,$2)`,
                [name, get(row, 'code') || null])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'absences') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            if (!email) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { errors.push(`Ligne ${i + 2}: employé ${email} introuvable`); skipped++; continue }
            const typeLabel = get(row, 'type_absence')
            const absType = await pool.query(`SELECT id FROM "${schema}".absence_types WHERE label ILIKE $1 LIMIT 1`, [typeLabel])
            if (!absType.rows[0]) { errors.push(`Ligne ${i + 2}: type "${typeLabel}" inconnu`); skipped++; continue }
            const startDate = toDate(get(row, 'date_debut')) ?? get(row, 'date_debut')
            const endDate = toDate(get(row, 'date_fin')) ?? get(row, 'date_fin')
            const status = get(row, 'statut') || 'approved'
            const cur = new Date(startDate); const end = new Date(endDate); let days = 0
            while (cur <= end) { if (cur.getDay() !== 0) days++; cur.setDate(cur.getDate() + 1) }
            try {
              await pool.query(`
                INSERT INTO "${schema}".absences (employee_id, absence_type_id, start_date, end_date, days, status, reason)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
              `, [emp.rows[0].id, absType.rows[0].id, startDate, endDate, days, status, get(row, 'motif') || null])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'pay-slips') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            const month = get(row, 'periode')
            if (!email || !month) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { skipped++; errors.push(`Ligne ${i + 2}: ${email} introuvable`); continue }
            const ex = await pool.query(`SELECT id FROM "${schema}".pay_slips WHERE employee_id = $1 AND month = $2`, [emp.rows[0].id, month])
            if (ex.rows[0]) { skipped++; continue }
            let periodId: string
            const per = await pool.query(`SELECT id FROM "${schema}".pay_periods WHERE month = $1 LIMIT 1`, [month])
            if (per.rows[0]) { periodId = per.rows[0].id }
            else {
              const np = await pool.query(`INSERT INTO "${schema}".pay_periods (month, status) VALUES ($1,'closed') RETURNING id`, [month])
              periodId = np.rows[0].id
            }
            try {
              await pool.query(`
                INSERT INTO "${schema}".pay_slips (employee_id, period_id, month, gross_salary, employee_contributions, net_before_tax, income_tax, net_payable, employer_cost, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated')
              `, [
                emp.rows[0].id, periodId, month,
                parseInt(get(row, 'salaire_brut')) || 0,
                parseInt(get(row, 'cotis_cnps_sal')) || 0,
                (parseInt(get(row, 'salaire_brut')) || 0) - (parseInt(get(row, 'cotis_cnps_sal')) || 0),
                parseInt(get(row, 'its')) || 0,
                parseInt(get(row, 'net_paye')) || 0,
                parseInt(get(row, 'cout_employeur')) || 0,
              ])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else if (type === 'mobile-money') {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!
            const email = get(row, 'email_employe')
            if (!email) { skipped++; continue }
            const emp = await pool.query(`SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [email])
            if (!emp.rows[0]) { skipped++; errors.push(`Ligne ${i + 2}: ${email} introuvable`); continue }
            const provider = get(row, 'operateur')
            const phone = get(row, 'numero_telephone')
            try {
              await pool.query(`UPDATE "${schema}".employees SET mobile_money_provider=$1, mobile_money_number=$2 WHERE id=$3`,
                [provider, phone, emp.rows[0].id])
              inserted++
            } catch (e) { errors.push(`Ligne ${i + 2}: ${(e as Error).message}`); skipped++ }
          }

        } else {
          return reply.status(400).send({ error: `Type d'import inconnu : ${type}` })
        }

        return reply.send({ total: rows.length, inserted, skipped, errors })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur lors de l\'import' })
      }
    },
  })
}

export default settingsRoutes
