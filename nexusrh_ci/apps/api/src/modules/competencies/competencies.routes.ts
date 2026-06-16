/**
 * Référentiel postes & compétences (Bloom) — routes Fastify (prefix /competencies).
 *
 * Couvre l'exigence DAO : référentiel des postes (fiches de poste), référentiel
 * des compétences avec niveau de maîtrise selon la taxonomie de Bloom, et outil
 * comparatif des postes.
 *
 * SÉCURITÉ : OWASP A01 (RBAC RH ; suppression admin/hr_manager), A03 (Zod
 * safeParse + clamp Bloom 1–6), A09 (audit_log).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { BLOOM_MIN, BLOOM_MAX, clampBloom, compareRequirements, type RequirementItem } from './competencies.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'] as const
const WRITE_ROLES = ['admin', 'hr_manager', 'hr_officer'] as const
const DELETE_ROLES = ['admin', 'hr_manager'] as const

const competencySchema = z.object({
  label: z.string().min(1).max(200),
  category: z.string().max(100).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  bloomLevel: z.number().int().min(BLOOM_MIN).max(BLOOM_MAX).optional(),
})
const jobProfileSchema = z.object({
  title: z.string().min(1).max(200),
  mission: z.string().max(4000).optional().nullable(),
  activities: z.string().max(4000).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  level: z.string().max(50).optional().nullable(),
  departmentId: z.string().uuid().optional().nullable(),
})
const attachSchema = z.object({
  competencyId: z.string().uuid(),
  requiredLevel: z.number().int().min(BLOOM_MIN).max(BLOOM_MAX).optional(),
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

async function requirementsOf(schema: string, jobProfileId: string): Promise<RequirementItem[]> {
  const r = await rawPool.query<{ competency_id: string; label: string; required_level: number }>(
    `SELECT jpc.competency_id, cf.label, jpc.required_level
     FROM "${schema}".job_profile_competencies jpc
     JOIN "${schema}".competency_framework cf ON cf.id = jpc.competency_id
     WHERE jpc.job_profile_id = $1`,
    [jobProfileId],
  )
  return r.rows.map((x) => ({ competencyId: x.competency_id, label: x.label, requiredLevel: x.required_level }))
}

const competenciesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // ── Catalogue de compétences (référentiel Bloom) ──────────────────────────
  fastify.get('/catalog', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['competencies'], summary: 'Référentiel des compétences (Bloom)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(`SELECT * FROM "${schema}".competency_framework ORDER BY category NULLS LAST, label`)
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/catalog', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Créer une compétence' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = competencySchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".competency_framework (label, category, description, bloom_level, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.label, b.category ?? null, b.description ?? null, clampBloom(b.bloomLevel ?? 1), request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'competency.created', 'competency', row.id, { label: b.label }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  fastify.patch('/catalog/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Mettre à jour une compétence' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = competencySchema.partial().safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      if (b.label !== undefined)       { sets.push(`label = $${i++}`); params.push(b.label) }
      if (b.category !== undefined)    { sets.push(`category = $${i++}`); params.push(b.category) }
      if (b.description !== undefined) { sets.push(`description = $${i++}`); params.push(b.description) }
      if (b.bloomLevel !== undefined)  { sets.push(`bloom_level = $${i++}`); params.push(clampBloom(b.bloomLevel)) }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push('updated_at = now()')
      params.push(id)
      const res = await rawPool.query(`UPDATE "${schema}".competency_framework SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Compétence introuvable' })
      audit(schema, request.user.sub, 'competency.updated', 'competency', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  fastify.delete('/catalog/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Supprimer une compétence (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(`DELETE FROM "${schema}".competency_framework WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Compétence introuvable' })
      await rawPool.query(`DELETE FROM "${schema}".job_profile_competencies WHERE competency_id = $1`, [id]).catch(() => undefined)
      audit(schema, request.user.sub, 'competency.deleted', 'competency', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // ── Fiches de poste ───────────────────────────────────────────────────────
  fastify.get('/job-profiles', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['competencies'], summary: 'Référentiel des postes' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(
        `SELECT p.*, (SELECT COUNT(*) FROM "${schema}".job_profile_competencies jpc WHERE jpc.job_profile_id = p.id) AS competency_count
         FROM "${schema}".job_profiles p ORDER BY p.title`,
      )
      return reply.send({ data: res.rows })
    },
  })

  fastify.get('/job-profiles/:id', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['competencies'], summary: 'Détail d\'une fiche de poste + compétences requises' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const p = await rawPool.query(`SELECT * FROM "${schema}".job_profiles WHERE id = $1 LIMIT 1`, [id])
      if (!p.rows[0]) return reply.status(404).send({ error: 'Fiche de poste introuvable' })
      const c = await rawPool.query(
        `SELECT jpc.id, jpc.competency_id, jpc.required_level, cf.label, cf.category, cf.bloom_level
         FROM "${schema}".job_profile_competencies jpc
         JOIN "${schema}".competency_framework cf ON cf.id = jpc.competency_id
         WHERE jpc.job_profile_id = $1 ORDER BY cf.label`, [id],
      )
      return reply.send({ data: { ...(p.rows[0] as Record<string, unknown>), competencies: c.rows } })
    },
  })

  fastify.post('/job-profiles', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Créer une fiche de poste' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = jobProfileSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".job_profiles (title, mission, activities, category, level, department_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.title, b.mission ?? null, b.activities ?? null, b.category ?? null, b.level ?? null, b.departmentId ?? null, request.user.sub],
      )
      const row = res.rows[0] as { id: string }
      audit(schema, request.user.sub, 'job_profile.created', 'job_profile', row.id, { title: b.title }, request.ip ?? null)
      return reply.status(201).send({ data: row })
    },
  })

  fastify.patch('/job-profiles/:id', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Mettre à jour une fiche de poste' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = jobProfileSchema.partial().safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const map: Array<[string, unknown]> = [
        ['title', b.title], ['mission', b.mission], ['activities', b.activities],
        ['category', b.category], ['level', b.level], ['department_id', b.departmentId],
      ]
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      for (const [col, val] of map) {
        if (val !== undefined) { sets.push(`${col} = $${i++}`); params.push(val) }
      }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push('updated_at = now()')
      params.push(id)
      const res = await rawPool.query(`UPDATE "${schema}".job_profiles SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Fiche de poste introuvable' })
      audit(schema, request.user.sub, 'job_profile.updated', 'job_profile', id, { fields: sets }, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  fastify.delete('/job-profiles/:id', {
    preHandler: [fastify.authorize(...DELETE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Supprimer une fiche de poste (admin/RH)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(`DELETE FROM "${schema}".job_profiles WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Fiche de poste introuvable' })
      await rawPool.query(`DELETE FROM "${schema}".job_profile_competencies WHERE job_profile_id = $1`, [id]).catch(() => undefined)
      audit(schema, request.user.sub, 'job_profile.deleted', 'job_profile', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // ── Compétences requises par poste ────────────────────────────────────────
  fastify.post('/job-profiles/:id/competencies', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Attacher une compétence requise à un poste' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const parsed = attachSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const ins = await rawPool.query<{ id: string }>(
        `INSERT INTO "${schema}".job_profile_competencies (job_profile_id, competency_id, required_level)
         VALUES ($1,$2,$3) ON CONFLICT (job_profile_id, competency_id)
           DO UPDATE SET required_level = EXCLUDED.required_level RETURNING id`,
        [id, b.competencyId, clampBloom(b.requiredLevel ?? 1)],
      )
      audit(schema, request.user.sub, 'job_profile.competency_set', 'job_profile', id, { competencyId: b.competencyId }, request.ip ?? null)
      return reply.status(201).send({ data: { id: ins.rows[0]?.id } })
    },
  })

  fastify.delete('/job-profiles/:id/competencies/:linkId', {
    preHandler: [fastify.authorize(...WRITE_ROLES)],
    schema: { tags: ['competencies'], summary: 'Détacher une compétence d\'un poste' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id, linkId } = request.params as { id: string; linkId: string }
      const res = await rawPool.query(
        `DELETE FROM "${schema}".job_profile_competencies WHERE id = $1 AND job_profile_id = $2 RETURNING id`,
        [linkId, id],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Lien introuvable' })
      audit(schema, request.user.sub, 'job_profile.competency_removed', 'job_profile', id, { linkId }, request.ip ?? null)
      return reply.send({ data: { id: linkId } })
    },
  })

  // ── Outil comparatif de deux fiches de poste ──────────────────────────────
  fastify.get('/compare', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['competencies'], summary: 'Comparer les compétences requises de deux postes' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { a, b } = request.query as { a?: string; b?: string }
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!a || !b || !uuid.test(a) || !uuid.test(b)) {
        return reply.status(400).send({ error: 'Paramètres a et b (UUID de fiches de poste) requis' })
      }
      const [reqA, reqB] = await Promise.all([requirementsOf(schema, a), requirementsOf(schema, b)])
      return reply.send({ data: { rows: compareRequirements(reqA, reqB) } })
    },
  })
}

export default competenciesRoutes
