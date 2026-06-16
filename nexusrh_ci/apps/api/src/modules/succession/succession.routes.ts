/**
 * Plans de succession & viviers de talents — routes Fastify (prefix /succession).
 *
 * Couvre l'exigence DAO : plans de succession, mapping des successeurs sur les
 * postes, pools de talents par poste.
 *
 * SÉCURITÉ : OWASP A01 (RBAC RH ; suppression admin/hr_manager), A03 (Zod
 * safeParse), A09 (audit_log).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  CRITICALITY_LEVELS,
  PLAN_STATUSES,
  READINESS_LEVELS,
  summarizeCoverage,
} from './succession.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'readonly'] as const
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const createPlanSchema = z.object({
  positionTitle: z.string().min(1).max(200),
  incumbentEmployeeId: z.string().uuid().nullable().optional(),
  criticality: z.enum(CRITICALITY_LEVELS).optional(),
  notes: z.string().max(2000).optional(),
})
const updatePlanSchema = z.object({
  positionTitle: z.string().min(1).max(200).optional(),
  incumbentEmployeeId: z.string().uuid().nullable().optional(),
  criticality: z.enum(CRITICALITY_LEVELS).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  notes: z.string().max(2000).optional(),
})
const candidateSchema = z.object({
  employeeId: z.string().uuid(),
  readiness: z.enum(READINESS_LEVELS).optional(),
  notes: z.string().max(2000).optional(),
})
const candidateUpdateSchema = z.object({
  readiness: z.enum(READINESS_LEVELS).optional(),
  notes: z.string().max(2000).optional(),
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

const successionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /succession/plans — liste + synthèse de couverture
  fastify.get('/plans', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['succession'], summary: 'Plans de succession' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const plans = await rawPool.query(
        `SELECT p.*, e.first_name AS incumbent_first_name, e.last_name AS incumbent_last_name
         FROM "${schema}".succession_plans p
         LEFT JOIN "${schema}".employees e ON e.id = p.incumbent_employee_id
         ORDER BY p.created_at DESC`,
      )
      const cands = await rawPool.query<{ plan_id: string; readiness: string }>(
        `SELECT plan_id, readiness FROM "${schema}".succession_candidates`,
      )
      const byPlan = new Map<string, string[]>()
      for (const c of cands.rows) {
        const arr = byPlan.get(c.plan_id) ?? []
        arr.push(c.readiness)
        byPlan.set(c.plan_id, arr)
      }
      const data = plans.rows.map((p) => ({
        ...(p as Record<string, unknown>),
        coverage: summarizeCoverage(byPlan.get((p as { id: string }).id) ?? []),
      }))
      return reply.send({ data })
    },
  })

  // GET /succession/plans/:id — détail + candidats
  fastify.get('/plans/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['succession'], summary: 'Détail d\'un plan de succession' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const p = await rawPool.query(
        `SELECT * FROM "${schema}".succession_plans WHERE id = $1 LIMIT 1`, [id],
      )
      if (!p.rows[0]) return reply.status(404).send({ error: 'Plan introuvable' })
      const c = await rawPool.query(
        `SELECT sc.*, e.first_name, e.last_name, e.job_title
         FROM "${schema}".succession_candidates sc
         JOIN "${schema}".employees e ON e.id = sc.employee_id
         WHERE sc.plan_id = $1 ORDER BY sc.created_at`, [id],
      )
      return reply.send({ data: { ...(p.rows[0] as Record<string, unknown>), candidates: c.rows } })
    },
  })

  // POST /succession/plans
  fastify.post('/plans', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['succession'], summary: 'Créer un plan de succession' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = createPlanSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".succession_plans
           (position_title, incumbent_employee_id, criticality, notes, created_by, status)
         VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
        [b.positionTitle, b.incumbentEmployeeId ?? null, b.criticality ?? 'medium', b.notes ?? null, request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'succession.plan_created', 'succession_plan', row.id, { positionTitle: b.positionTitle }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  // PATCH /succession/plans/:id
  fastify.patch('/plans/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['succession'], summary: 'Mettre à jour un plan' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = updatePlanSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      if (b.positionTitle !== undefined)       { sets.push(`position_title = $${i++}`); params.push(b.positionTitle) }
      if (b.incumbentEmployeeId !== undefined) { sets.push(`incumbent_employee_id = $${i++}`); params.push(b.incumbentEmployeeId) }
      if (b.criticality !== undefined)         { sets.push(`criticality = $${i++}`); params.push(b.criticality) }
      if (b.status !== undefined)              { sets.push(`status = $${i++}`); params.push(b.status) }
      if (b.notes !== undefined)               { sets.push(`notes = $${i++}`); params.push(b.notes) }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push(`updated_at = now()`)
      params.push(id)
      const res = await rawPool.query(
        `UPDATE "${schema}".succession_plans SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params,
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Plan introuvable' })
      audit(schema, request.user.sub, 'succession.plan_updated', 'succession_plan', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /succession/plans/:id
  fastify.delete('/plans/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['succession'], summary: 'Supprimer un plan (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".succession_plans WHERE id = $1 RETURNING id`, [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Plan introuvable' })
      await rawPool.query(`DELETE FROM "${schema}".succession_candidates WHERE plan_id = $1`, [id]).catch(() => undefined)
      audit(schema, request.user.sub, 'succession.plan_deleted', 'succession_plan', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // POST /succession/plans/:id/candidates — ajouter un successeur
  fastify.post('/plans/:id/candidates', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['succession'], summary: 'Ajouter un successeur au vivier' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = candidateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const ins = await rawPool.query<{ id: string }>(
        `INSERT INTO "${schema}".succession_candidates (plan_id, employee_id, readiness, notes)
         VALUES ($1,$2,$3,$4) ON CONFLICT (plan_id, employee_id) DO NOTHING RETURNING id`,
        [id, b.employeeId, b.readiness ?? 'medium_term', b.notes ?? null],
      )
      if (!ins.rows[0]) return reply.status(409).send({ error: 'Ce salarié est déjà dans le vivier', statusCode: 409 })
      audit(schema, request.user.sub, 'succession.candidate_added', 'succession_candidate', ins.rows[0].id, { planId: id, employeeId: b.employeeId }, request.ip ?? null)
      return reply.status(201).send({ data: { id: ins.rows[0].id } })
    },
  })

  // PATCH /succession/candidates/:id
  fastify.patch('/candidates/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['succession'], summary: 'Mettre à jour un successeur' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = candidateUpdateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      if (b.readiness !== undefined) { sets.push(`readiness = $${i++}`); params.push(b.readiness) }
      if (b.notes !== undefined)     { sets.push(`notes = $${i++}`); params.push(b.notes) }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      params.push(id)
      const res = await rawPool.query(
        `UPDATE "${schema}".succession_candidates SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params,
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Successeur introuvable' })
      audit(schema, request.user.sub, 'succession.candidate_updated', 'succession_candidate', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /succession/candidates/:id
  fastify.delete('/candidates/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['succession'], summary: 'Retirer un successeur du vivier' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".succession_candidates WHERE id = $1 RETURNING id`, [id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Successeur introuvable' })
      audit(schema, request.user.sub, 'succession.candidate_removed', 'succession_candidate', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })
}

export default successionRoutes
