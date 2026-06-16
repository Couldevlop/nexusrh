/**
 * Processus de sortie (offboarding) + solde de tout compte — routes Fastify
 * (prefix /offboarding).
 *
 * Couvre l'exigence DAO : motifs de départ, checklist de restitution, calcul du
 * solde de tout compte, transmission au module Paie (le solde calculé est
 * historisé et exploitable par la paie).
 *
 * SÉCURITÉ : OWASP A01 (RBAC RH ; suppression admin/hr_manager), A03 (Zod
 * safeParse + transitions de statut contrôlées), A09 (audit_log).
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  DEPARTURE_TYPES,
  OFFBOARDING_STATUSES,
  DEFAULT_CHECKLIST,
  canTransition,
  computeSettlement,
  type OffboardingStatus,
  type DepartureType,
} from './offboarding.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly'] as const
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const createSchema = z.object({
  employeeId: z.string().uuid(),
  departureType: z.enum(DEPARTURE_TYPES),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  reason: z.string().max(2000).optional(),
  noticeServed: z.boolean().optional(),
})

const updateSchema = z.object({
  status: z.enum(OFFBOARDING_STATUSES).optional(),
  reason: z.string().max(2000).optional(),
  noticeServed: z.boolean().optional(),
  checklist: z.array(z.object({
    key: z.string().max(50),
    label: z.string().max(200),
    done: z.boolean(),
  })).optional(),
})

const settlementSchema = z.object({
  congesDaysOutstanding: z.number().min(0).max(400).optional(),
})

function badRequest(reply: import('fastify').FastifyReply, err: z.ZodError) {
  return reply.status(400).send({
    error: 'Validation échouée',
    issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  })
}

function audit(
  schema: string, userId: string | undefined, action: string,
  id: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool
    .query(
      `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, $2, 'offboarding_case', $3, $4, $5)`,
      [userId ?? null, action, id, JSON.stringify(changes), ip],
    )
    .catch(() => { /* tenant sans audit_log : non bloquant */ })
}

/** Ancienneté en mois entre l'embauche et la date de départ (>= 0). */
function seniorityMonthsBetween(hireDate: string | Date, departureDate: string | Date): number {
  const h = new Date(hireDate)
  const d = new Date(departureDate)
  let months = (d.getFullYear() - h.getFullYear()) * 12 + (d.getMonth() - h.getMonth())
  if (d.getDate() < h.getDate()) months -= 1
  return Math.max(0, months)
}

const offboardingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /offboarding — liste
  fastify.get('/', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['offboarding'], summary: 'Liste des dossiers de sortie' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, status } = request.query as Record<string, string>
      let sql = `SELECT o.*, e.first_name, e.last_name, e.employee_number
                 FROM "${schema}".offboarding_cases o
                 JOIN "${schema}".employees e ON e.id = o.employee_id WHERE 1=1`
      const params: unknown[] = []
      let i = 1
      if (employeeId) { sql += ` AND o.employee_id = $${i++}`; params.push(employeeId) }
      if (status)     { sql += ` AND o.status = $${i++}`; params.push(status) }
      sql += ` ORDER BY o.departure_date DESC, o.created_at DESC`
      const res = await rawPool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // GET /offboarding/:id
  fastify.get('/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['offboarding'], summary: 'Détail d\'un dossier de sortie' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `SELECT o.*, e.first_name, e.last_name FROM "${schema}".offboarding_cases o
         JOIN "${schema}".employees e ON e.id = o.employee_id WHERE o.id = $1 LIMIT 1`,
        [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Dossier introuvable' })
      return reply.send({ data: res.rows[0] })
    },
  })

  // POST /offboarding — créer (checklist par défaut)
  fastify.post('/', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['offboarding'], summary: 'Ouvrir un dossier de sortie' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply, parsed.error)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".offboarding_cases
           (employee_id, departure_type, departure_date, reason, notice_served, checklist, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING *`,
        [b.employeeId, b.departureType, b.departureDate, b.reason ?? null,
         b.noticeServed ?? true, JSON.stringify(DEFAULT_CHECKLIST), request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'offboarding.created', row.id,
        { departureType: b.departureType, employeeId: b.employeeId }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  // PATCH /offboarding/:id — statut / checklist / motif
  fastify.patch('/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['offboarding'], summary: 'Mettre à jour un dossier de sortie' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = updateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply, parsed.error)
      const b = parsed.data

      const cur = await rawPool.query<{ status: OffboardingStatus }>(
        `SELECT status FROM "${schema}".offboarding_cases WHERE id = $1 LIMIT 1`, [id],
      )
      if (!cur.rows[0]) return reply.status(404).send({ error: 'Dossier introuvable' })
      if (b.status && !canTransition(cur.rows[0].status, b.status)) {
        return reply.status(409).send({
          error: `Transition de statut interdite : ${cur.rows[0].status} → ${b.status}`, statusCode: 409,
        })
      }

      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      if (b.status !== undefined)       { sets.push(`status = $${i++}`); params.push(b.status) }
      if (b.reason !== undefined)       { sets.push(`reason = $${i++}`); params.push(b.reason) }
      if (b.noticeServed !== undefined) { sets.push(`notice_served = $${i++}`); params.push(b.noticeServed) }
      if (b.checklist !== undefined)    { sets.push(`checklist = $${i++}`); params.push(JSON.stringify(b.checklist)) }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ à mettre à jour' })
      sets.push(`updated_at = now()`)
      params.push(id)
      const res = await rawPool.query(
        `UPDATE "${schema}".offboarding_cases SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params,
      )
      audit(schema, request.user.sub, 'offboarding.updated', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // POST /offboarding/:id/settlement — calculer le solde de tout compte
  fastify.post('/:id/settlement', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['offboarding'], summary: 'Calculer le solde de tout compte' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = settlementSchema.safeParse(request.body ?? {})
      if (!parsed.success) return badRequest(reply, parsed.error)

      const r = await rawPool.query<{
        departure_type: DepartureType; departure_date: string; notice_served: boolean;
        base_salary: string; hire_date: string | null; status: OffboardingStatus;
      }>(
        `SELECT o.departure_type, o.departure_date, o.notice_served, o.status,
                e.base_salary, e.hire_date
         FROM "${schema}".offboarding_cases o
         JOIN "${schema}".employees e ON e.id = o.employee_id WHERE o.id = $1 LIMIT 1`,
        [id],
      )
      const row = r.rows[0]
      if (!row) return reply.status(404).send({ error: 'Dossier introuvable' })

      const seniorityMonths = row.hire_date
        ? seniorityMonthsBetween(row.hire_date, row.departure_date) : 0
      const settlement = computeSettlement({
        monthlyGross: parseInt(row.base_salary, 10) || 0,
        seniorityMonths,
        departureType: row.departure_type,
        congesDaysOutstanding: parsed.data.congesDaysOutstanding ?? 0,
        noticeServed: row.notice_served,
      })

      // Le solde calculé est historisé (transmissible au module Paie) et le
      // dossier passe en 'settled' si la transition est autorisée.
      const nextStatus: OffboardingStatus = canTransition(row.status, 'settled') ? 'settled' : row.status
      await rawPool.query(
        `UPDATE "${schema}".offboarding_cases SET settlement = $1, status = $2, updated_at = now() WHERE id = $3`,
        [JSON.stringify(settlement), nextStatus, id],
      )
      audit(schema, request.user.sub, 'offboarding.settlement', id, { total: settlement.total }, request.ip ?? null)
      return reply.send({ data: settlement })
    },
  })

  // DELETE /offboarding/:id — admin / hr_manager
  fastify.delete('/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['offboarding'], summary: 'Supprimer un dossier de sortie (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".offboarding_cases WHERE id = $1 RETURNING id`, [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Dossier introuvable' })
      audit(schema, request.user.sub, 'offboarding.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })
}

export default offboardingRoutes
