import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { config } from '../../config.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'

const rawPool = new Pool({ connectionString: config.database.url })

// OWASP A03 (input validation) — schema strict pour POST /absences
const createAbsenceSchema = z.object({
  absenceTypeId: z.string().uuid('absenceTypeId doit être un UUID'),
  startDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  endDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  halfDay:       z.boolean().optional(),
  reason:        z.string().max(1000).optional(),
  employeeId:    z.string().uuid().optional(),
})

/**
 * OWASP A01 — un manager ne peut approuver/rejeter que les absences des
 * employés dont il est manager direct. Renvoie true si l'utilisateur a le
 * droit d'agir sur cette absence.
 */
async function managerCanActOnAbsence(
  schema: string,
  managerEmployeeId: string | null | undefined,
  absenceEmployeeId: string,
): Promise<boolean> {
  if (!managerEmployeeId) return false
  if (managerEmployeeId === absenceEmployeeId) return false // auto-approbation interdite
  const r = await rawPool.query<{ id: string }>(
    `SELECT id FROM "${schema}".employees WHERE id = $1 AND manager_id = $2 LIMIT 1`,
    [absenceEmployeeId, managerEmployeeId],
  )
  return r.rows.length > 0
}

function auditLogAbsence(
  schema: string, userId: string, action: string,
  absenceId: string, changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'absence', $3, $4, $5)`,
    [userId, action, absenceId, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

const absencesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /absences
  fastify.get('/', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager','readonly')],
    schema: { tags: ['absences'], summary: 'Liste des absences' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, status, year } = request.query as Record<string, string>
      let sql = `SELECT a.*, at.label AS type_label, at.color AS type_color,
                        e.first_name, e.last_name
                 FROM "${schema}".absences a
                 JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
                 JOIN "${schema}".employees e ON e.id = a.employee_id
                 WHERE 1=1`
      const params: unknown[] = []
      let idx = 1
      if (employeeId) { sql += ` AND a.employee_id = $${idx++}`; params.push(employeeId) }
      if (status)     { sql += ` AND a.status = $${idx++}`; params.push(status) }
      if (year)       { sql += ` AND EXTRACT(YEAR FROM a.start_date) = $${idx++}`; params.push(parseInt(year)) }
      if (request.user.role === 'manager') {
        const emp = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        if (emp.rows[0]) { sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id) }
      }
      sql += ` ORDER BY a.created_at DESC`
      const res = await rawPool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // GET /absences/my-absences
  fastify.get('/my-absences', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Mes absences (self-service)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      let employeeId: string | null = request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        employeeId = r.rows[0]?.id ?? null
      }
      if (!employeeId) return reply.send({ data: [] })
      const res = await rawPool.query(
        `SELECT a.*, at.label AS type_label, at.color AS type_color
         FROM "${schema}".absences a
         JOIN "${schema}".absence_types at ON at.id = a.absence_type_id
         WHERE a.employee_id = $1
         ORDER BY a.created_at DESC LIMIT 50`,
        [employeeId]
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /absences/balances
  fastify.get('/balances', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Soldes congés CI' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.query as { employeeId?: string }
      const year = new Date().getFullYear()
      let empId = employeeId ?? request.user.employeeId ?? null
      if (!empId) {
        const r = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        empId = r.rows[0]?.id ?? null
      }
      if (!empId) return reply.send({ data: [] })
      const res = await rawPool.query(
        `SELECT ab.*, at.label, at.code, at.color
         FROM "${schema}".absence_balances ab
         JOIN "${schema}".absence_types at ON at.id = ab.absence_type_id
         WHERE ab.employee_id = $1 AND ab.year = $2`,
        [empId, year]
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /absences/types
  fastify.get('/types', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Types d\'absences CI' },
    handler: async (request, reply) => {
      const res = await rawPool.query(
        `SELECT * FROM "${request.user.schemaName}".absence_types WHERE is_active = true ORDER BY label`
      )
      return reply.send({ data: res.rows })
    },
  })

  // POST /absences
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Créer une demande d\'absence' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      // OWASP A03 : validation stricte du body (rejette champs arbitraires)
      const parsed = createAbsenceSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Données de demande invalides',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      let employeeId = body.employeeId ?? request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        if (r.rows[0]) {
          employeeId = r.rows[0].id as string
        } else {
          return reply.status(422).send({ error: 'Aucun dossier employé associé à ce compte. Contactez votre RH.' })
        }
      }

      // Calcul jours ouvrables CI
      const start = new Date(body.startDate)
      const end   = new Date(body.endDate)
      let days = 0
      const cur = new Date(start)
      while (cur <= end) {
        const dow = cur.getDay()
        if (dow !== 0) days++ // dimanche = 0 exclu, samedi inclus (Code Travail CI)
        cur.setDate(cur.getDate() + 1)
      }
      if (body.halfDay) days = 0.5

      const res = await rawPool.query(
        `INSERT INTO "${schema}".absences
           (employee_id, absence_type_id, start_date, end_date, days, half_day, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [employeeId, body.absenceTypeId, body.startDate, body.endDate, days, body.halfDay ?? false, body.reason ?? null]
      )

      // Incrémenter pending dans absence_balances
      const year = start.getFullYear()
      await rawPool.query(
        `UPDATE "${schema}".absence_balances
         SET pending = pending + $1, remaining = remaining - $1, updated_at = now()
         WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
        [days, employeeId, body.absenceTypeId, year]
      ).catch(() => undefined)

      // OWASP A09 : trace de la création de demande
      auditLogAbsence(schema, request.user.sub, 'absence.created', res.rows[0].id, {
        employeeId, absenceTypeId: body.absenceTypeId,
        startDate: body.startDate, endDate: body.endDate, days,
      }, request.ip ?? null)

      return reply.status(201).send({ data: res.rows[0] })
    },
  })

  // PATCH /absences/:id/approve
  fastify.patch('/:id/approve', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    schema: { tags: ['absences'], summary: 'Approuver une absence (workflow multi-niveaux)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = request.user.schemaName

      const cfgRes = await rawPool.query<{ levels_count: number }>(
        `SELECT levels_count FROM "${schema}".workflow_configs WHERE module = 'absences' LIMIT 1`
      )
      const levelsCount = cfgRes.rows[0]?.levels_count ?? 1

      const cur = await rawPool.query<{ validation_level: number; status: string; employee_id: string; days: number; absence_type_id: string }>(
        `SELECT validation_level, status, employee_id, days, absence_type_id
         FROM "${schema}".absences WHERE id = $1`, [id]
      )
      const absence = cur.rows[0]
      if (!absence) return reply.status(404).send({ error: 'Absence introuvable' })
      if (absence.status === 'approved') return reply.status(422).send({ error: 'Déjà approuvée' })
      if (absence.status === 'rejected') return reply.status(422).send({ error: 'Déjà rejetée' })

      // OWASP A01 : un manager ne peut approuver que SES subordonnés directs.
      // admin/hr_manager/hr_officer ont la portée globale du tenant.
      if (request.user.role === 'manager') {
        const allowed = await managerCanActOnAbsence(schema, request.user.employeeId, absence.employee_id)
        if (!allowed) {
          return reply.status(403).send({ error: 'Vous ne pouvez approuver que les absences de votre équipe directe' })
        }
      }

      const nextLevel = absence.validation_level + 1
      const isApproved = nextLevel >= levelsCount

      const res = await rawPool.query(
        `UPDATE "${schema}".absences SET
           validation_level = $1, status = $2,
           approved_by = $3, approved_at = $4, updated_at = now()
         WHERE id = $5 RETURNING *`,
        [nextLevel, isApproved ? 'approved' : 'submitted',
         isApproved ? request.user.sub : null,
         isApproved ? new Date() : null, id]
      )

      if (isApproved) {
        const year = new Date(res.rows[0].start_date).getFullYear()
        await rawPool.query(
          `UPDATE "${schema}".absence_balances
           SET taken = taken + $1, pending = pending - $1, updated_at = now()
           WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
          [absence.days, absence.employee_id, absence.absence_type_id, year]
        ).catch(() => undefined)
      }

      // OWASP A09 : trace de l'approbation (niveau workflow + fully approved)
      auditLogAbsence(schema, request.user.sub,
        isApproved ? 'absence.approved' : 'absence.approval_step',
        id,
        { level: nextLevel, totalLevels: levelsCount, fullyApproved: isApproved,
          employeeId: absence.employee_id },
        request.ip ?? null)

      return reply.send({
        data: res.rows[0],
        message: isApproved ? 'Absence approuvée' : `Niveau ${nextLevel}/${levelsCount} validé`,
        fullyApproved: isApproved,
      })
    },
  })

  // PATCH /absences/:id/reject
  fastify.patch('/:id/reject', {
    preHandler: [fastify.authorize('admin','hr_manager','hr_officer','manager')],
    schema: { tags: ['absences'], summary: 'Refuser une absence' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const { reason } = (request.body as { reason?: string }) ?? {}
      const schema = request.user.schemaName

      const cur = await rawPool.query<{ employee_id: string; days: number; absence_type_id: string; start_date: string }>(
        `SELECT employee_id, days, absence_type_id, start_date FROM "${schema}".absences WHERE id = $1`, [id]
      )
      const absence = cur.rows[0]
      if (!absence) return reply.status(404).send({ error: 'Absence introuvable' })

      // OWASP A01 : un manager ne peut rejeter que les absences de son équipe directe
      if (request.user.role === 'manager') {
        const allowed = await managerCanActOnAbsence(schema, request.user.employeeId, absence.employee_id)
        if (!allowed) {
          return reply.status(403).send({ error: 'Vous ne pouvez rejeter que les absences de votre équipe directe' })
        }
      }

      const res = await rawPool.query(
        `UPDATE "${schema}".absences SET status = 'rejected', rejection_reason = $1,
         rejected_by = $2, updated_at = now() WHERE id = $3 RETURNING *`,
        [reason ?? null, request.user.sub, id]
      )

      // Remettre le pending
      const year = new Date(absence.start_date).getFullYear()
      await rawPool.query(
        `UPDATE "${schema}".absence_balances
         SET pending = pending - $1, remaining = remaining + $1, updated_at = now()
         WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
        [absence.days, absence.employee_id, absence.absence_type_id, year]
      ).catch(() => undefined)

      // OWASP A09 : trace du rejet (motif inclus)
      auditLogAbsence(schema, request.user.sub, 'absence.rejected', id, {
        employeeId: absence.employee_id, reason: reason ?? null,
      }, request.ip ?? null)

      return reply.send({ data: res.rows[0] })
    },
  })
}

export default absencesRoutes
