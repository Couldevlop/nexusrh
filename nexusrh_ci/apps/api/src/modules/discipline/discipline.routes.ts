/**
 * Gestion disciplinaire / sanctions — routes Fastify (prefix /discipline).
 *
 * Donnée de NIVEAU 4 (hautement sensible). Conformément au cahier des charges
 * (« accès strictement limité aux profils autorisés : RH, direction concernée »).
 *
 * SÉCURITÉ
 *  - OWASP A01 : accès restreint à admin / hr_manager / hr_officer. Jamais
 *    manager / employee / readonly (contrairement aux autres modules RH).
 *    Suppression réservée à admin / hr_manager.
 *  - OWASP A03 : validation Zod stricte + transitions de statut contrôlées.
 *  - OWASP A09 : chaque création/modification/suppression journalisée (audit_log).
 *  - Isolation tenant : schemaName du token (validé par le plugin auth).
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  DISCIPLINE_TYPES,
  DISCIPLINE_STATUSES,
  canTransition,
  type DisciplineStatus,
} from './discipline.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const createSchema = z.object({
  employeeId: z.string().uuid('employeeId doit être un UUID'),
  type: z.enum(DISCIPLINE_TYPES),
  reason: z.string().min(1, 'Motif requis').max(2000),
  description: z.string().max(5000).optional(),
  actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format date attendu YYYY-MM-DD'),
  documentUrl: z.string().max(1000).optional(),
})

const updateSchema = z.object({
  status: z.enum(DISCIPLINE_STATUSES).optional(),
  reason: z.string().min(1).max(2000).optional(),
  description: z.string().max(5000).optional(),
  documentUrl: z.string().max(1000).optional(),
})

function audit(
  schema: string,
  userId: string | undefined,
  action: string,
  id: string | null,
  changes: Record<string, unknown>,
  ip: string | null,
): void {
  rawPool
    .query(
      `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, $2, 'disciplinary_action', $3, $4, $5)`,
      [userId ?? null, action, id, JSON.stringify(changes), ip],
    )
    .catch(() => { /* tenant sans audit_log : non bloquant */ })
}

const disciplineRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /discipline — liste (filtres employeeId, status, type)
  fastify.get('/', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['discipline'], summary: 'Liste des sanctions disciplinaires' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, status, type } = request.query as Record<string, string>
      let sql = `SELECT d.*, e.first_name, e.last_name, e.employee_number
                 FROM "${schema}".disciplinary_actions d
                 JOIN "${schema}".employees e ON e.id = d.employee_id
                 WHERE 1=1`
      const params: unknown[] = []
      let i = 1
      if (employeeId) { sql += ` AND d.employee_id = $${i++}`; params.push(employeeId) }
      if (status)     { sql += ` AND d.status = $${i++}`; params.push(status) }
      if (type)       { sql += ` AND d.type = $${i++}`; params.push(type) }
      sql += ` ORDER BY d.action_date DESC, d.created_at DESC`
      const res = await rawPool.query(sql, params)
      return reply.send({ data: res.rows })
    },
  })

  // GET /discipline/:id
  fastify.get('/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['discipline'], summary: 'Détail d\'une sanction' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `SELECT d.*, e.first_name, e.last_name FROM "${schema}".disciplinary_actions d
         JOIN "${schema}".employees e ON e.id = d.employee_id WHERE d.id = $1 LIMIT 1`,
        [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Sanction introuvable' })
      return reply.send({ data: res.rows[0] })
    },
  })

  // POST /discipline — créer
  fastify.post('/', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['discipline'], summary: 'Enregistrer une sanction' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".disciplinary_actions
           (employee_id, type, reason, description, action_date, document_url, issued_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING *`,
        [body.employeeId, body.type, body.reason, body.description ?? null,
         body.actionDate, body.documentUrl ?? null, request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'discipline.created', row.id,
        { type: body.type, employeeId: body.employeeId }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  // PATCH /discipline/:id — mettre à jour (statut contrôlé)
  fastify.patch('/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['discipline'], summary: 'Mettre à jour une sanction' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = updateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      const cur = await rawPool.query<{ status: DisciplineStatus }>(
        `SELECT status FROM "${schema}".disciplinary_actions WHERE id = $1 LIMIT 1`, [id],
      )
      if (!cur.rows[0]) return reply.status(404).send({ error: 'Sanction introuvable' })

      // OWASP A03 — transition de statut contrôlée par le domaine.
      if (body.status && !canTransition(cur.rows[0].status, body.status)) {
        return reply.status(409).send({
          error: `Transition de statut interdite : ${cur.rows[0].status} → ${body.status}`,
          statusCode: 409,
        })
      }

      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      for (const [col, val] of [
        ['status', body.status], ['reason', body.reason],
        ['description', body.description], ['document_url', body.documentUrl],
      ] as const) {
        if (val !== undefined) { sets.push(`${col} = $${i++}`); params.push(val) }
      }
      if (sets.length === 0) return reply.status(400).send({ error: 'Aucun champ à mettre à jour' })
      sets.push(`updated_at = now()`)
      params.push(id)
      const res = await rawPool.query(
        `UPDATE "${schema}".disciplinary_actions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        params,
      )
      audit(schema, request.user.sub, 'discipline.updated', id, body as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /discipline/:id — suppression définitive (admin / hr_manager only)
  fastify.delete('/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['discipline'], summary: 'Supprimer une sanction (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".disciplinary_actions WHERE id = $1 RETURNING id`, [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Sanction introuvable' })
      audit(schema, request.user.sub, 'discipline.deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })
}

export default disciplineRoutes
