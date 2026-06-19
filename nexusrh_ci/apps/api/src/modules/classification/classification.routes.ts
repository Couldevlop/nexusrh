/**
 * Classification des données à 4 niveaux — routes Fastify (prefix /classification).
 *
 * Couvre l'exigence DAO : classification native à 4 niveaux (Public / Interne /
 * Confidentiel / Restreint) avec règles d'accès, d'export et de traçabilité par
 * niveau, et cartographie des catégories de données RH.
 *
 * SÉCURITÉ : OWASP A01 (config des règles réservée admin ; lecture RH),
 * A03 (Zod safeParse + rôles/niveaux bornés), A09 (audit_log).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool as rawPool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { isValidLevel, roleCanAccess, roleCanExport, accessRequiresAudit, type LevelRule } from './classification.service.js'

const READ_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly', 'dg'] as const
const CATEGORY_ROLES = ['admin', 'hr_manager'] as const
const TENANT_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg', 'raf_site']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const levelRuleSchema = z.object({
  allowedRoles: z.array(z.enum(TENANT_ROLES as [string, ...string[]])).max(TENANT_ROLES.length),
  exportAllowed: z.boolean(),
  encryptionRequired: z.boolean(),
  auditRequired: z.boolean(),
}).strict()
const categorySchema = z.object({
  categoryKey: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'Clé : minuscules, chiffres, underscore'),
  label: z.string().min(1).max(150),
  level: z.number().int().min(1).max(4),
  examples: z.string().max(1000).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
})
const categoryUpdateSchema = z.object({
  label: z.string().min(1).max(150).optional(),
  level: z.number().int().min(1).max(4).optional(),
  examples: z.string().max(1000).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
})

function badRequest(reply: FastifyReply, msg = 'Validation échouée') { return reply.status(400).send({ error: msg }) }
function audit(
  schema: string, userId: string | undefined, action: string, id: string | null,
  changes: Record<string, unknown>, ip: string | null,
): void {
  rawPool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'data_classification', $3, $4, $5)`,
    [userId ?? null, action, id, JSON.stringify(changes), ip],
  ).catch(() => { /* non bloquant */ })
}

interface LevelRow { level: number; label: string; allowed_roles: string[]; export_allowed: boolean; encryption_required: boolean; audit_required: boolean }
const toRule = (r: LevelRow): LevelRule => ({
  level: r.level, allowedRoles: r.allowed_roles ?? [], exportAllowed: r.export_allowed,
  encryptionRequired: r.encryption_required, auditRequired: r.audit_required,
})

const classificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request) => {
    const schema = request.user?.schemaName
    if (schema) await ensureTenantSchema(schema)
  })

  // GET /classification/levels — 4 niveaux + règles
  fastify.get('/levels', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['classification'], summary: 'Niveaux de classification + règles' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(`SELECT * FROM "${schema}".classification_levels ORDER BY level`)
      return reply.send({ data: res.rows })
    },
  })

  // PUT /classification/levels/:level — règles d'un niveau (admin uniquement — politique de sécurité)
  fastify.put('/levels/:level', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['classification'], summary: 'Mettre à jour les règles d\'un niveau' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const level = Number((request.params as { level: string }).level)
      if (!isValidLevel(level)) return badRequest(reply, 'Niveau invalide (1–4)')
      const parsed = levelRuleSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `UPDATE "${schema}".classification_levels
         SET allowed_roles = $1, export_allowed = $2, encryption_required = $3, audit_required = $4, updated_at = now()
         WHERE level = $5 RETURNING *`,
        [b.allowedRoles, b.exportAllowed, b.encryptionRequired, b.auditRequired, level],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Niveau introuvable' })
      // entity_id est de type uuid : on ne peut pas y mettre le numéro de niveau.
      // Le niveau concerné est journalisé dans le payload `changes` (A09).
      audit(schema, request.user.sub, 'classification.level_updated', null, { level, ...b }, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // GET /classification/categories — cartographie catégorie → niveau
  fastify.get('/categories', {
    preHandler: [fastify.authorize(...READ_ROLES)],
    schema: { tags: ['classification'], summary: 'Catégories de données classées' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await rawPool.query(`SELECT * FROM "${schema}".data_classification_categories ORDER BY level, label`)
      return reply.send({ data: res.rows })
    },
  })

  // POST /classification/categories
  fastify.post('/categories', {
    preHandler: [fastify.authorize(...CATEGORY_ROLES)],
    schema: { tags: ['classification'], summary: 'Ajouter une catégorie de données' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const parsed = categorySchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const res = await rawPool.query(
        `INSERT INTO "${schema}".data_classification_categories (category_key, label, level, examples, notes)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (category_key) DO NOTHING RETURNING *`,
        [b.categoryKey, b.label, b.level, b.examples ?? null, b.notes ?? null],
      )
      if (!res.rows[0]) return reply.status(409).send({ error: 'Catégorie déjà existante', statusCode: 409 })
      audit(schema, request.user.sub, 'classification.category_created', (res.rows[0] as { id: string }).id, { categoryKey: b.categoryKey, level: b.level }, request.ip ?? null)
      return reply.status(201).send({ data: res.rows[0] })
    },
  })

  // PATCH /classification/categories/:id
  fastify.patch('/categories/:id', {
    preHandler: [fastify.authorize(...CATEGORY_ROLES)],
    schema: { tags: ['classification'], summary: 'Reclasser / modifier une catégorie' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return badRequest(reply, 'id invalide')
      const parsed = categoryUpdateSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const b = parsed.data
      const map: Array<[string, unknown]> = [['label', b.label], ['level', b.level], ['examples', b.examples], ['notes', b.notes]]
      const sets: string[] = []
      const params: unknown[] = []
      let i = 1
      for (const [col, val] of map) { if (val !== undefined) { sets.push(`${col} = $${i++}`); params.push(val) } }
      if (sets.length === 0) return badRequest(reply, 'Aucun champ à mettre à jour')
      sets.push('updated_at = now()')
      params.push(id)
      const res = await rawPool.query(`UPDATE "${schema}".data_classification_categories SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
      if (!res.rows[0]) return reply.status(404).send({ error: 'Catégorie introuvable' })
      audit(schema, request.user.sub, 'classification.category_updated', id, b as Record<string, unknown>, request.ip ?? null)
      return reply.send({ data: res.rows[0] })
    },
  })

  // DELETE /classification/categories/:id
  fastify.delete('/categories/:id', {
    preHandler: [fastify.authorize(...CATEGORY_ROLES)],
    schema: { tags: ['classification'], summary: 'Supprimer une catégorie' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const { id } = request.params as { id: string }
      const res = await rawPool.query(`DELETE FROM "${schema}".data_classification_categories WHERE id = $1 RETURNING id`, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Catégorie introuvable' })
      audit(schema, request.user.sub, 'classification.category_deleted', id, {}, request.ip ?? null)
      return reply.send({ data: { id } })
    },
  })

  // GET /classification/check — décision d'accès/export pour l'utilisateur courant
  // (réutilisable par d'autres modules pour appliquer la politique ; A09 : accès
  // de niveau sensible journalisé).
  fastify.get('/check', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['classification'], summary: 'Vérifier l\'accès à une catégorie / niveau' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const role = request.user.role
      const { categoryKey, level } = request.query as { categoryKey?: string; level?: string }

      let lvl: number | null = level ? Number(level) : null
      let resolvedCategory: string | null = categoryKey ?? null
      if (categoryKey) {
        const c = await rawPool.query<{ level: number }>(
          `SELECT level FROM "${schema}".data_classification_categories WHERE category_key = $1 LIMIT 1`, [categoryKey],
        )
        if (!c.rows[0]) return reply.status(404).send({ error: 'Catégorie inconnue' })
        lvl = c.rows[0].level
      }
      if (!lvl || !isValidLevel(lvl)) return badRequest(reply, 'level (1–4) ou categoryKey requis')

      const r = await rawPool.query<LevelRow>(`SELECT * FROM "${schema}".classification_levels WHERE level = $1 LIMIT 1`, [lvl])
      const rule = r.rows[0] ? toRule(r.rows[0]) : undefined
      const canAccess = roleCanAccess(rule, role)
      const canExport = roleCanExport(rule, role)
      if (canAccess && accessRequiresAudit(rule)) {
        // entity_id est de type uuid : la clé de catégorie (texte) ne peut pas y être
        // stockée. On journalise niveau + catégorie dans le payload `changes` (A09).
        audit(schema, request.user.sub, 'classification.sensitive_access', null, { level: lvl, category: resolvedCategory }, request.ip ?? null)
      }
      return reply.send({ data: { level: lvl, category: resolvedCategory, canAccess, canExport } })
    },
  })
}

export default classificationRoutes
