import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { emitIntegrationEvent } from '../../services/integrations.service.js'
import { decryptIfPresent } from '../../utils/crypto.js'
import { joursFeriesCI } from '../../utils/ci-holidays.js'

// OWASP A03 (input validation) — schema strict pour POST /absences
const createAbsenceSchema = z.object({
  absenceTypeId: z.string().uuid('absenceTypeId doit être un UUID'),
  startDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  endDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  halfDay:       z.boolean().optional(),
  reason:        z.string().max(1000).optional(),
  employeeId:    z.string().uuid().optional(),
}).refine((d) => d.startDate <= d.endDate, {
  // ABS-003 — la date de fin doit être postérieure ou égale au début.
  // Comparaison lexicographique sûre sur des chaînes YYYY-MM-DD.
  message: 'La date de fin doit être postérieure ou égale à la date de début',
  path: ['endDate'],
})

/**
 * Notifie un utilisateur (table notifications). Non bloquant. `userId` peut être
 * null (employé sans compte / manager non lié) → on ignore silencieusement.
 */
function notifyUser(
  schema: string, userId: string | null | undefined, type: string,
  title: string, message: string, data: Record<string, unknown> = {},
): void {
  if (!userId) return
  rawPool.query(
    `INSERT INTO "${schema}".notifications (user_id, type, title, message, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, title, message, JSON.stringify(data)],
  ).catch(() => { /* table absente / user supprimé : non bloquant */ })
}

/** Résout le user_id du compte lié à un employé (null si aucun). */
async function userIdOfEmployee(schema: string, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null
  try {
    const r = await rawPool.query<{ user_id: string | null }>(
      `SELECT user_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`, [employeeId],
    )
    return r?.rows?.[0]?.user_id ?? null
  } catch { return null }
}

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
        // OWASP A01 — fail-closed : un manager sans dossier employé associé ne
        // doit voir AUCUNE absence (jamais toutes celles du tenant).
        if (!emp.rows[0]) return reply.send({ data: [] })
        sql += ` AND e.manager_id = $${idx++}`; params.push(emp.rows[0].id)
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

      // OWASP A01 (IDOR) — un employee ne peut créer une absence QUE pour
      // lui-même : on ignore body.employeeId et on force son propre dossier.
      // Seuls les rôles RH (admin/hr_manager/hr_officer) peuvent saisir pour autrui.
      const isHrRole = ['admin', 'hr_manager', 'hr_officer'].includes(request.user.role)
      let employeeId = isHrRole
        ? (body.employeeId ?? request.user.employeeId ?? null)
        : (request.user.employeeId ?? null)
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

      // Calcul jours ouvrables CI : dimanche exclu (samedi inclus, semaine 6 j)
      // + jours fériés CI exclus (ABS-008). Couvre les années traversées.
      const start = new Date(body.startDate)
      const end   = new Date(body.endDate)
      const feries = new Set<string>([
        ...joursFeriesCI(start.getFullYear()),
        ...joursFeriesCI(end.getFullYear()),
      ])
      const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      let days = 0
      const cur = new Date(start)
      while (cur <= end) {
        const dow = cur.getDay()
        if (dow !== 0 && !feries.has(ymdLocal(cur))) days++ // ni dimanche ni férié
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

      // ABS-002 — notifier le manager de la nouvelle demande (non bloquant, crash-safe)
      const newAbsenceId = res.rows[0].id as string
      void (async () => {
        try {
          const r = await rawPool.query<{ manager_user_id: string | null; first_name: string; last_name: string }>(
            `SELECT m.user_id AS manager_user_id, e.first_name, e.last_name
               FROM "${schema}".employees e LEFT JOIN "${schema}".employees m ON m.id = e.manager_id
              WHERE e.id = $1 LIMIT 1`, [employeeId],
          )
          const row = r?.rows?.[0]
          if (row?.manager_user_id) notifyUser(schema, row.manager_user_id, 'absence_request',
            'Nouvelle demande d\'absence',
            `${row.first_name} ${row.last_name} a soumis une demande d'absence du ${body.startDate} au ${body.endDate} (${days} j) — à valider.`,
            { absenceId: newAbsenceId, employeeId })
        } catch { /* non bloquant */ }
      })()

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

      if (isApproved) {
        emitIntegrationEvent(rawPool, schema, 'absence.approved', {
          id, employeeId: absence.employee_id, days: absence.days,
        }, decryptIfPresent)
        // ABS-004 — notifier l'employé de l'approbation (non bloquant)
        void userIdOfEmployee(schema, absence.employee_id).then(uid => notifyUser(
          schema, uid, 'absence_approved', 'Absence approuvée',
          `Votre demande d'absence (${absence.days} j) a été approuvée.`, { absenceId: id }))
      }

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

      // ABS-005 — notifier l'employé du refus + motif (non bloquant)
      void userIdOfEmployee(schema, absence.employee_id).then(uid => notifyUser(
        schema, uid, 'absence_rejected', 'Absence refusée',
        `Votre demande d'absence a été refusée.${reason ? ' Motif : ' + reason : ''}`,
        { absenceId: id, reason: reason ?? null }))

      return reply.send({ data: res.rows[0] })
    },
  })

  // PATCH /absences/:id/cancel — l'employé annule SA propre demande en attente
  fastify.patch('/:id/cancel', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Annuler ma demande d\'absence en attente (self-service)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const schema = request.user.schemaName

      // Résolution de l'employeeId du demandeur (token, sinon lookup par email)
      let employeeId: string | null = request.user.employeeId ?? null
      if (!employeeId) {
        const r = await rawPool.query(
          `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [request.user.email]
        )
        employeeId = r.rows[0]?.id ?? null
      }
      if (!employeeId) {
        return reply.status(422).send({ error: 'Aucun dossier employé associé à ce compte. Contactez votre RH.' })
      }

      const cur = await rawPool.query<{ employee_id: string; days: number; absence_type_id: string; start_date: string; status: string }>(
        `SELECT employee_id, days, absence_type_id, start_date, status
         FROM "${schema}".absences WHERE id = $1`, [id]
      )
      const absence = cur.rows[0]
      if (!absence) return reply.status(404).send({ error: 'Absence introuvable' })

      // OWASP A01 (IDOR) — un employé ne peut annuler QUE sa propre demande.
      // On répond 404 (et non 403) pour ne pas divulguer l'existence d'une
      // absence appartenant à un autre employé.
      if (absence.employee_id !== employeeId) {
        return reply.status(404).send({ error: 'Absence introuvable' })
      }

      // Annulation autorisée uniquement tant que la demande est en attente
      // (statut 'pending' à la création, ou 'submitted' en cours de workflow).
      if (absence.status !== 'pending' && absence.status !== 'submitted') {
        return reply.status(409).send({
          error: 'Seule une demande en attente peut être annulée',
        })
      }

      const res = await rawPool.query(
        `UPDATE "${schema}".absences
         SET status = 'cancelled', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id]
      )

      // Restaurer le solde "pending" décrémenté à la création
      const year = new Date(absence.start_date).getFullYear()
      await rawPool.query(
        `UPDATE "${schema}".absence_balances
         SET pending = pending - $1, remaining = remaining + $1, updated_at = now()
         WHERE employee_id = $2 AND absence_type_id = $3 AND year = $4`,
        [absence.days, absence.employee_id, absence.absence_type_id, year]
      ).catch(() => undefined)

      // OWASP A09 : trace de l'annulation par l'employé
      auditLogAbsence(schema, request.user.sub, 'absence.cancelled', id, {
        employeeId: absence.employee_id, days: absence.days,
      }, request.ip ?? null)

      return reply.send({ data: res.rows[0] })
    },
  })
}

export default absencesRoutes
