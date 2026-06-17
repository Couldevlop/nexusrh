/**
 * Mobilités — routes Fastify (prefix /mobility).
 *
 * Couvre l'exigence DAO : passerelles de mobilité selon les compétences,
 * comparaison salarié vs poste souhaité (écarts), actions correctives, workflow
 * de validation (Manager → DRH → décision).
 *
 * SÉCURITÉ : OWASP A01 (RBAC ; décision approuvé/rejeté réservée admin/hr_manager),
 * A03 (Zod safeParse + niveaux Bloom 1–6), A09 (audit_log).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import {
  MOBILITY_STATUSES, canTransition, isDecision, gapAnalysis,
  type MobilityStatus, type RequiredItem,
} from './mobility.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'] as const
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DECIDE_ROLES = ['admin', 'hr_manager'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bloom = z.number().int().min(1).max(6)

const assessSchema = z.object({ competencyId: z.string().uuid(), level: bloom })
const requestSchema = z.object({
  employeeId: z.string().uuid(),
  targetJobProfileId: z.string().uuid(),
  reason: z.string().max(2000).optional().nullable(),
})
const requestUpdateSchema = z.object({
  status: z.enum(MOBILITY_STATUSES).optional(),
  notes: z.string().max(2000).optional().nullable(),
  correctiveActions: z.string().max(2000).optional().nullable(),
})

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }
function audit(
  schema: string, userId: string | undefined, action: string, entity: string,
  id: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId ?? null, action, entity, id, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

async function requiredOf(schema: string, jobProfileId: string): Promise<RequiredItem[]> {
  const r = await rawPool.query<{ competency_id: string; label: string; required_level: number }>(
    `SELECT jpc.competency_id, cf.label, jpc.required_level
     FROM "${schema}".job_profile_competencies jpc
     JOIN "${schema}".competency_framework cf ON cf.id = jpc.competency_id
     WHERE jpc.job_profile_id = $1`, [jobProfileId],
  )
  return r.rows.map((x) => ({ competencyId: x.competency_id, label: x.label, requiredLevel: x.required_level }))
}
async function assessedMap(schema: string, employeeId: string): Promise<Map<string, number>> {
  const r = await rawPool.query<{ competency_id: string; level: number }>(
    `SELECT competency_id, level FROM "${schema}".employee_competencies WHERE employee_id = $1`, [employeeId],
  )
  const m = new Map<string, number>()
  for (const row of r.rows) m.set(row.competency_id, row.level)
  return m
}

const mobilityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // ── Compétences évaluées d'un salarié ─────────────────────────────────────
  fastify.get('/employees/:employeeId/competencies', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['mobility'], summary: 'Compétences évaluées d\'un salarié' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      if (!UUID_RE.test(employeeId)) return badRequest(reply, 'employeeId invalide')
      const res = await rawPool.query(
        `SELECT ec.id, ec.competency_id, ec.level, cf.label, cf.category, cf.bloom_level
         FROM "${schema}".employee_competencies ec
         JOIN "${schema}".competency_framework cf ON cf.id = ec.competency_id
         WHERE ec.employee_id = $1 ORDER BY cf.label`, [employeeId],
      )
      return reply.send({ data: res.rows })
    },
  })

  fastify.put('/employees/:employeeId/competencies', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['mobility'], summary: 'Évaluer une compétence d\'un salarié' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      if (!UUID_RE.test(employeeId)) return badRequest(reply, 'employeeId invalide')
      const parsed = assessSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      await rawPool.query(
        `INSERT INTO "${schema}".employee_competencies (employee_id, competency_id, level)
         VALUES ($1,$2,$3) ON CONFLICT (employee_id, competency_id)
           DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
        [employeeId, b.competencyId, b.level],
      )
      audit(schema, request.user.sub, 'mobility.competency_assessed', 'employee_competency', employeeId, { competencyId: b.competencyId, level: b.level }, request.ip ?? null)
      return reply.send({ success: true })
    },
  })

  fastify.delete('/employees/:employeeId/competencies/:competencyId', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['mobility'], summary: 'Retirer une compétence évaluée' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId, competencyId } = request.params as { employeeId: string; competencyId: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".employee_competencies WHERE employee_id = $1 AND competency_id = $2 RETURNING id`,
        [employeeId, competencyId],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Évaluation introuvable' })
      return reply.send({ data: { id: res.rows[0].id } })
    },
  })

  // GET /mobility/employees/:employeeId/gap?jobProfileId= — écart vs un poste
  fastify.get('/employees/:employeeId/gap', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['mobility'], summary: 'Écart de compétences salarié vs poste' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { employeeId } = request.params as { employeeId: string }
      const { jobProfileId } = request.query as { jobProfileId?: string }
      if (!UUID_RE.test(employeeId) || !jobProfileId || !UUID_RE.test(jobProfileId)) {
        return badRequest(reply, 'employeeId et jobProfileId (UUID) requis')
      }
      const [req, asm] = await Promise.all([requiredOf(schema, jobProfileId), assessedMap(schema, employeeId)])
      return reply.send({ data: gapAnalysis(req, asm) })
    },
  })

  // ── Passerelles de mobilité ───────────────────────────────────────────────
  fastify.get('/requests', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['mobility'], summary: 'Passerelles de mobilité' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT m.*, e.first_name, e.last_name, jp.title AS target_title
         FROM "${schema}".mobility_requests m
         JOIN "${schema}".employees e ON e.id = m.employee_id
         JOIN "${schema}".job_profiles jp ON jp.id = m.target_job_profile_id
         ORDER BY m.created_at DESC`,
      )
      return reply.send({ data: res.rows })
    },
  })

  fastify.get('/requests/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['mobility'], summary: 'Détail d\'une passerelle + écart de compétences' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const m = await rawPool.query<{ employee_id: string; target_job_profile_id: string }>(
        `SELECT m.*, e.first_name, e.last_name, jp.title AS target_title
         FROM "${schema}".mobility_requests m
         JOIN "${schema}".employees e ON e.id = m.employee_id
         JOIN "${schema}".job_profiles jp ON jp.id = m.target_job_profile_id
         WHERE m.id = $1 LIMIT 1`, [id],
      )
      const row = m.rows[0]
      if (!row) return reply.status(404).send({ error: 'Passerelle introuvable' })
      const [req, asm] = await Promise.all([
        requiredOf(schema, row.target_job_profile_id), assessedMap(schema, row.employee_id),
      ])
      return reply.send({ data: { ...(row as Record<string, unknown>), gap: gapAnalysis(req, asm) } })
    },
  })

  fastify.post('/requests', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['mobility'], summary: 'Proposer une passerelle de mobilité' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = requestSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".mobility_requests (employee_id, target_job_profile_id, reason, requested_by, status)
         VALUES ($1,$2,$3,$4,'proposed') RETURNING *`,
        [b.employeeId, b.targetJobProfileId, b.reason ?? null, request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'mobility.requested', 'mobility_request', row.id, { employeeId: b.employeeId, targetJobProfileId: b.targetJobProfileId }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  fastify.patch('/requests/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['mobility'], summary: 'Faire avancer / décider une passerelle' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = requestUpdateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data

      if (b.status) {
        const cur = await rawPool.query<{ status: MobilityStatus }>(
          `SELECT status FROM "${schema}".mobility_requests WHERE id = $1 LIMIT 1`, [id],
        )
        if (!cur.rows[0]) return reply.status(404).send({ error: 'Passerelle introuvable' })
        if (!canTransition(cur.rows[0].status, b.status)) {
          return reply.status(409).send({ error: `Transition interdite : ${cur.rows[0].status} → ${b.status}`, statusCode: 409 })
        }
        // OWASP A01 — la DÉCISION (approuvé/rejeté) est réservée admin/hr_manager (DRH).
        if (isDecision(b.status) && !(DECIDE_ROLES as readonly string[]).includes(request.user.role)) {
          return reply.status(403).send({ error: 'Décision réservée à la DRH (admin/hr_manager)' })
        }
      }

      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      if (b.notes !== undefined)              { sets.push(`notes = $${i++}`); params.push(b.notes) }
      if (b.correctiveActions !== undefined)  { sets.push(`corrective_actions = $${i++}`); params.push(b.correctiveActions) }
      if (b.status !== undefined) {
        sets.push(`status = $${i++}`); params.push(b.status)
        if (isDecision(b.status)) {
          sets.push(`decided_by = $${i++}`); params.push(request.user.sub)
          sets.push(`decided_at = now()`)
        }
      }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push('updated_at = now()')
      params.push(id)
      const res = await rawPool.query(`UPDATE "${schema}".mobility_requests SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Passerelle introuvable' })
      audit(schema, request.user.sub, 'mobility.updated', 'mobility_request', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  fastify.delete('/requests/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['mobility'], summary: 'Supprimer une passerelle (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(`DELETE FROM "${schema}".mobility_requests WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Passerelle introuvable' })
      audit(schema, request.user.sub, 'mobility.deleted', 'mobility_request', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })
}

export default mobilityRoutes
