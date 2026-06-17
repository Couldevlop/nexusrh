/**
 * Calibrage (sessions 9-box) — routes Fastify (prefix /calibration).
 *
 * Couvre l'exigence DAO : tableau compilé des notes (performance/potentiel),
 * profils 9 cadrans AVANT et APRÈS les sessions de calibrage, suivi des
 * recommandations (qualités, insuffisances, mesures correctives) par salarié.
 *
 * SÉCURITÉ : OWASP A01 (RBAC RH ; suppression admin/hr_manager), A03 (Zod
 * safeParse + scores bornés 1–3), A09 (audit_log).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  SESSION_STATUSES, SCALE_MIN, SCALE_MAX, canTransition, nineBox, summarizeSession,
  type SessionStatus,
} from './calibration.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly'] as const
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const score = z.number().int().min(SCALE_MIN).max(SCALE_MAX)

const sessionSchema = z.object({
  title: z.string().min(1).max(200),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  scope: z.string().max(150).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
})
const sessionUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  scope: z.string().max(150).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  status: z.enum(SESSION_STATUSES).optional(),
})
const entrySchema = z.object({
  employeeId: z.string().uuid(),
  performanceBefore: score.optional(),
  potentialBefore: score.optional(),
})
const entryUpdateSchema = z.object({
  performanceBefore: score.optional().nullable(),
  potentialBefore: score.optional().nullable(),
  performanceAfter: score.optional().nullable(),
  potentialAfter: score.optional().nullable(),
  qualities: z.string().max(2000).optional().nullable(),
  gaps: z.string().max(2000).optional().nullable(),
  correctiveActions: z.string().max(2000).optional().nullable(),
})

function badRequest(reply: FastifyReply, msg = 'Validation échouée') {
  return reply.status(400).send({ error: msg })
}
function audit(
  schema: string, userId: string | undefined, action: string, entity: string,
  id: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool
    .query(
      `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, action, entity, id, JSON.stringify(changes), ip],
    )
    .catch(() => { /* non bloquant */ })
}

interface EntryRow {
  id: string; employee_id: string; first_name: string; last_name: string; job_title: string | null
  performance_before: number | null; potential_before: number | null
  performance_after: number | null; potential_after: number | null
  qualities: string | null; gaps: string | null; corrective_actions: string | null
}

const calibrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /calibration/sessions
  fastify.get('/sessions', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['calibration'], summary: 'Sessions de calibrage' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT s.*, (SELECT COUNT(*) FROM "${schema}".calibration_entries e WHERE e.session_id = s.id) AS entry_count
         FROM "${schema}".calibration_sessions s ORDER BY s.session_date DESC NULLS LAST, s.created_at DESC`,
      )
      return reply.send({ data: res.rows })
    },
  })

  // GET /calibration/sessions/:id — détail + entrées (cases 9-box calculées)
  fastify.get('/sessions/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['calibration'], summary: 'Détail d\'une session + tableau 9-box' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const s = await rawPool.query(`SELECT * FROM "${schema}".calibration_sessions WHERE id = $1 LIMIT 1`, [id])
      if (!s.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
      const e = await rawPool.query<EntryRow>(
        `SELECT ce.*, emp.first_name, emp.last_name, emp.job_title
         FROM "${schema}".calibration_entries ce
         JOIN "${schema}".employees emp ON emp.id = ce.employee_id
         WHERE ce.session_id = $1 ORDER BY emp.last_name, emp.first_name`, [id],
      )
      const entries = e.rows.map((r) => ({
        ...r,
        boxBefore: nineBox(r.performance_before, r.potential_before),
        boxAfter: nineBox(r.performance_after, r.potential_after),
      }))
      return reply.send({ data: { ...(s.rows[0] as Record<string, unknown>), entries, summary: summarizeSession(e.rows) } })
    },
  })

  // POST /calibration/sessions
  fastify.post('/sessions', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['calibration'], summary: 'Créer une session de calibrage' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = sessionSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".calibration_sessions (title, session_date, scope, notes, created_by, status)
         VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *`,
        [b.title, b.sessionDate ?? null, b.scope ?? null, b.notes ?? null, request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'calibration.session_created', 'calibration_session', row.id, { title: b.title }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  // PATCH /calibration/sessions/:id
  fastify.patch('/sessions/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['calibration'], summary: 'Mettre à jour une session' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = sessionUpdateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      if (b.status) {
        const cur = await rawPool.query<{ status: SessionStatus }>(`SELECT status FROM "${schema}".calibration_sessions WHERE id = $1 LIMIT 1`, [id])
        if (!cur.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
        if (!canTransition(cur.rows[0].status, b.status)) {
          return reply.status(409).send({ error: `Transition interdite : ${cur.rows[0].status} → ${b.status}`, statusCode: 409 })
        }
      }
      const map: Array<[string, unknown]> = [['title', b.title], ['scope', b.scope], ['notes', b.notes], ['status', b.status]]
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      for (const [col, val] of map) { if (val !== undefined) { sets.push(`${col} = $${i++}`); params.push(val) } }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push('updated_at = now()')
      params.push(id)
      const res = await rawPool.query(`UPDATE "${schema}".calibration_sessions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
      audit(schema, request.user.sub, 'calibration.session_updated', 'calibration_session', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /calibration/sessions/:id
  fastify.delete('/sessions/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['calibration'], summary: 'Supprimer une session (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(`DELETE FROM "${schema}".calibration_sessions WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Session introuvable' })
      await rawPool.query(`DELETE FROM "${schema}".calibration_entries WHERE session_id = $1`, [id]).catch(() => undefined)
      audit(schema, request.user.sub, 'calibration.session_deleted', 'calibration_session', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // POST /calibration/sessions/:id/entries — inscrire un collaborateur
  fastify.post('/sessions/:id/entries', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['calibration'], summary: 'Ajouter un collaborateur à la session' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = entrySchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const ins = await rawPool.query<{ id: string }>(
        `INSERT INTO "${schema}".calibration_entries (session_id, employee_id, performance_before, potential_before)
         VALUES ($1,$2,$3,$4) ON CONFLICT (session_id, employee_id) DO NOTHING RETURNING id`,
        [id, b.employeeId, b.performanceBefore ?? null, b.potentialBefore ?? null],
      )
      if (!ins.rows[0]) return reply.status(409).send({ error: 'Ce collaborateur est déjà dans la session', statusCode: 409 })
      audit(schema, request.user.sub, 'calibration.entry_added', 'calibration_entry', ins.rows[0].id, { sessionId: id, employeeId: b.employeeId }, request.ip ?? null)
      return reply.status(201).send({ data: { id: ins.rows[0].id } })
    },
  })

  // PATCH /calibration/entries/:id — scores avant/après + recommandations
  fastify.patch('/entries/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['calibration'], summary: 'Mettre à jour une entrée (scores + recommandations)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = entryUpdateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const map: Array<[string, unknown]> = [
        ['performance_before', b.performanceBefore], ['potential_before', b.potentialBefore],
        ['performance_after', b.performanceAfter], ['potential_after', b.potentialAfter],
        ['qualities', b.qualities], ['gaps', b.gaps], ['corrective_actions', b.correctiveActions],
      ]
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      for (const [col, val] of map) { if (val !== undefined) { sets.push(`${col} = $${i++}`); params.push(val) } }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push('updated_at = now()')
      params.push(id)
      const res = await rawPool.query(`UPDATE "${schema}".calibration_entries SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Entrée introuvable' })
      audit(schema, request.user.sub, 'calibration.entry_updated', 'calibration_entry', id, { fields: sets }, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /calibration/entries/:id
  fastify.delete('/entries/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['calibration'], summary: 'Retirer un collaborateur de la session' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(`DELETE FROM "${schema}".calibration_entries WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Entrée introuvable' })
      audit(schema, request.user.sub, 'calibration.entry_removed', 'calibration_entry', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })
}

export default calibrationRoutes
