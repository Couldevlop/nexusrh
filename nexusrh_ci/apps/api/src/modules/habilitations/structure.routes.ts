/**
 * Habilitations RH — API d'administration de la structure (prefix /habilitations).
 *
 * Groupes, sous-groupes plafonnés, modèles de fiche, règles de cumul sensible,
 * habilitation du premier responsable, aperçu « Ce que voit X », rapport de
 * reprise et interrupteur d'activation du contrôle par la grille.
 *
 * Deux invariants tiennent tout le module :
 *  1. Toute permission écrite est validée contre le catalogue (`isPermission`) :
 *     une case inventée ne doit jamais entrer en base, sinon un plafond
 *     deviendrait illisible pour le moteur.
 *  2. L'aperçu appelle `loadHabContext` — le MÊME moteur que `authorize()` —
 *     jamais une copie du calcul : un plafond retiré se voit immédiatement.
 *
 * SÉCURITÉ : OWASP A01 (toutes les routes `authorize('admin')` : l'admin du
 * tenant est le seul à distribuer des droits ; aucune case de la grille n'ouvre
 * ces routes), A03 (Zod + identifiants UUID validés + permissions bornées au
 * catalogue), A09 (chaque écriture est auditée, avant/après pour un plafond ;
 * seules des clés de permission sont journalisées, jamais de donnée personnelle).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest, badRequestFromZod } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { isPermission } from './catalog.js'
import { loadHabContext, isUuid, type HabContext } from '../../services/habilitation.service.js'
import { SENSITIVE_FIELDS } from '../../services/sensitive-mask.js'

/** Codes PostgreSQL utiles : unicité violée, clé étrangère absente. */
const PG_UNIQUE = '23505'
const PG_FK = '23503'
const pgCode = (err: unknown): string | undefined => (err as { code?: string }).code

const nameSchema = z.string().trim().min(2).max(150)
const permissionsSchema = z.array(z.string().min(1).max(60)).max(200)

const groupSchema = z.object({ name: nameSchema }).strict()
const subgroupSchema = z.object({
  groupId: z.string(),
  name: nameSchema,
  kind: z.enum(['siege', 'entity']),
  legalEntityId: z.string().nullable().optional(),
  ceiling: permissionsSchema.optional(),
}).strict()
const ceilingSchema = z.object({ ceiling: permissionsSchema }).strict()
const templateSchema = z.object({
  key: z.string().trim().min(2).max(60).regex(/^[a-z0-9_]+$/, 'Clé : minuscules, chiffres, underscore'),
  label: nameSchema,
  permissions: permissionsSchema,
}).strict()
const templatePatchSchema = z.object({
  label: nameSchema.optional(),
  permissions: permissionsSchema.optional(),
}).strict()
// Une règle de cumul n'est jamais réécrite : seule sa désactivation est offerte
// (les règles par défaut sont réinsérées à chaque migration, cf. db/habilitations.ts).
const sodPatchSchema = z.object({ active: z.boolean() })
const bootstrapSchema = z.object({
  userId: z.string(),
  subgroupId: z.string(),
  permissions: permissionsSchema,
}).strict()
const enforcementSchema = z.object({ enabled: z.boolean() }).strict()

/** 400 nommant la première case hors catalogue, pour que l'écran la montre. */
function rejectUnknownPermissions(reply: FastifyReply, perms: readonly string[]): boolean {
  const unknown = perms.find((p) => !isPermission(p))
  if (unknown === undefined) return false
  badRequest(reply, `Permission inconnue : ${unknown}`)
  return true
}

function audit(
  schema: string, userId: string | undefined, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId ?? null, action, entity: 'habilitation', entityId, changes, ip })
}

interface StructureRow {
  group_id: string
  group_name: string
  subgroup_id: string | null
  subgroup_name: string | null
  kind: 'siege' | 'entity' | null
  legal_entity_id: string | null
  legal_entity_name: string | null
  ceiling: string[] | null
}
interface MemberRow {
  user_id: string
  subgroup_id: string | null
  permissions: string[] | null
  source: string
  revoked_at: string | null
  email: string
  first_name: string
  last_name: string
  role: string
}

/** Interrupteur d'activation du tenant (absent / non migré => non activé). */
async function readEnforced(schema: string): Promise<boolean> {
  try {
    const res = await pool.query<{ enforced: boolean | null }>(
      `SELECT habilitations_enforced AS enforced FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
      [schema],
    )
    return res.rows[0]?.enforced === true
  } catch (err) {
    if (pgCode(err) === '42P01' || pgCode(err) === '42703') return false
    throw err
  }
}

const habilitationStructureRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', ensureTenantSchemaHook)

  // ── Lecture de la structure ────────────────────────────────────────────────
  fastify.get('/structure', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Groupes, sous-groupes, plafonds et membres' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const [enforced, rows, members, siege] = await Promise.all([
        readEnforced(schema),
        pool.query<StructureRow>(
          `SELECT g.id::text AS group_id, g.name AS group_name,
                  sg.id::text AS subgroup_id, sg.name AS subgroup_name, sg.kind,
                  sg.legal_entity_id::text AS legal_entity_id, le.name AS legal_entity_name,
                  sg.ceiling
             FROM "${schema}".hab_groups g
             LEFT JOIN "${schema}".hab_subgroups sg ON sg.group_id = g.id
             LEFT JOIN "${schema}".legal_entities le ON le.id = sg.legal_entity_id
            ORDER BY g.name, (sg.kind = 'siege') DESC, sg.name`,
        ),
        pool.query<MemberRow>(
          `SELECT a.user_id::text AS user_id, a.subgroup_id::text AS subgroup_id, a.permissions,
                  a.source, a.revoked_at, u.email, u.first_name, u.last_name, u.role
             FROM "${schema}".hab_assignments a
             JOIN "${schema}".users u ON u.id = a.user_id
            ORDER BY u.last_name, u.first_name`,
        ),
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${schema}".employees WHERE legal_entity_id IS NULL`,
        ),
      ])

      const byGroup = new Map<string, { id: string; name: string; subgroups: unknown[] }>()
      for (const r of rows.rows) {
        let g = byGroup.get(r.group_id)
        if (!g) {
          g = { id: r.group_id, name: r.group_name, subgroups: [] }
          byGroup.set(r.group_id, g)
        }
        if (!r.subgroup_id) continue
        g.subgroups.push({
          id: r.subgroup_id,
          name: r.subgroup_name,
          kind: r.kind,
          legalEntityId: r.legal_entity_id,
          legalEntityName: r.legal_entity_name,
          ceiling: r.ceiling ?? [],
          members: members.rows
            .filter((m) => m.subgroup_id === r.subgroup_id)
            .map((m) => ({
              userId: m.user_id,
              email: m.email,
              firstName: m.first_name,
              lastName: m.last_name,
              role: m.role,
              source: m.source,
              revokedAt: m.revoked_at,
              permissions: m.permissions ?? [],
            })),
        })
      }
      return reply.send({
        data: {
          enforced,
          siegeEmployeeCount: siege.rows[0]?.n ?? 0,
          groups: [...byGroup.values()],
        },
      })
    },
  })

  // ── Groupes et sous-groupes ────────────────────────────────────────────────
  fastify.post('/groups', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Créer un groupe' },
    handler: async (request, reply) => {
      const parsed = groupSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const schema = request.user.schemaName
      try {
        const res = await pool.query<{ id: string; name: string }>(
          `INSERT INTO "${schema}".hab_groups (name) VALUES ($1) RETURNING id::text AS id, name`,
          [parsed.data.name],
        )
        const row = res.rows[0]
        audit(schema, request.user.sub, 'habilitation.group.created', row?.id ?? null, { name: parsed.data.name }, request.ip)
        return reply.status(201).send({ data: row })
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE) return reply.status(409).send({ error: 'Un groupe porte déjà ce nom' })
        throw err
      }
    },
  })

  fastify.post('/subgroups', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Créer un sous-groupe plafonné' },
    handler: async (request, reply) => {
      const parsed = subgroupSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const b = parsed.data
      if (!isUuid(b.groupId)) return badRequest(reply, 'Identifiant de groupe invalide')
      // La forme du sous-groupe et son entité légale ne peuvent pas se
      // contredire : un siège n'a jamais de filiale, une filiale en a toujours
      // une (sinon son périmètre SQL serait incalculable).
      if (b.kind === 'siege' && b.legalEntityId) {
        return badRequest(reply, 'Un sous-groupe siège ne porte pas de filiale')
      }
      if (b.kind === 'entity' && !b.legalEntityId) {
        return badRequest(reply, 'Un sous-groupe de filiale exige une filiale')
      }
      if (b.legalEntityId && !isUuid(b.legalEntityId)) return badRequest(reply, 'Identifiant de filiale invalide')
      const ceiling = b.ceiling ?? []
      if (rejectUnknownPermissions(reply, ceiling)) return
      const schema = request.user.schemaName
      try {
        const res = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".hab_subgroups (group_id, name, kind, legal_entity_id, ceiling)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5::text[]) RETURNING id::text AS id`,
          [b.groupId, b.name, b.kind, b.legalEntityId ?? null, ceiling],
        )
        const id = res.rows[0]?.id ?? null
        audit(schema, request.user.sub, 'habilitation.subgroup.created', id, { name: b.name, kind: b.kind, ceiling }, request.ip)
        return reply.status(201).send({ data: { id, name: b.name, kind: b.kind, legalEntityId: b.legalEntityId ?? null, ceiling } })
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE) {
          return reply.status(409).send({ error: 'Cette filiale (ou le siège) a déjà son sous-groupe' })
        }
        if (pgCode(err) === PG_FK) return reply.status(404).send({ error: 'Groupe introuvable' })
        throw err
      }
    },
  })

  fastify.patch('/subgroups/:id/ceiling', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Modifier le plafond d\'un sous-groupe' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      const parsed = ceilingSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const ceiling = parsed.data.ceiling
      if (rejectUnknownPermissions(reply, ceiling)) return
      const schema = request.user.schemaName
      const before = await pool.query<{ id: string; name: string; ceiling: string[] | null }>(
        `SELECT id::text AS id, name, ceiling FROM "${schema}".hab_subgroups WHERE id = $1::uuid`,
        [id],
      )
      const prev = before.rows[0]
      if (!prev) return reply.status(404).send({ error: 'Sous-groupe introuvable' })
      const res = await pool.query<{ id: string; ceiling: string[] }>(
        `UPDATE "${schema}".hab_subgroups SET ceiling = $1::text[] WHERE id = $2::uuid RETURNING id::text AS id, ceiling`,
        [ceiling, id],
      )
      // Avant/après : seules des clés de permission, jamais de donnée personnelle.
      audit(schema, request.user.sub, 'habilitation.ceiling.updated', id, {
        subgroup: prev.name, before: prev.ceiling ?? [], after: ceiling,
      }, request.ip)
      return reply.send({ data: res.rows[0] ?? { id, ceiling } })
    },
  })

  // ── Modèles de fiche ───────────────────────────────────────────────────────
  fastify.get('/templates', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Modèles de fiche' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT id::text AS id, key, label, permissions FROM "${schema}".hab_templates ORDER BY label`,
      )
      return reply.send({ data: res.rows })
    },
  })

  fastify.post('/templates', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Créer un modèle de fiche' },
    handler: async (request, reply) => {
      const parsed = templateSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const b = parsed.data
      if (rejectUnknownPermissions(reply, b.permissions)) return
      const schema = request.user.schemaName
      try {
        const res = await pool.query<{ id: string }>(
          `INSERT INTO "${schema}".hab_templates (key, label, permissions)
           VALUES ($1, $2, $3::text[]) RETURNING id::text AS id`,
          [b.key, b.label, b.permissions],
        )
        const id = res.rows[0]?.id ?? null
        audit(schema, request.user.sub, 'habilitation.template.created', id, { key: b.key, permissions: b.permissions }, request.ip)
        return reply.status(201).send({ data: { id, ...b } })
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE) return reply.status(409).send({ error: 'Un modèle porte déjà cette clé' })
        throw err
      }
    },
  })

  // La clé est l'identifiant stable d'un modèle (UNIQUE en base) : elle sert de
  // paramètre de chemin, le plan ne fixant pas la forme de cette route.
  fastify.patch('/templates/:key', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Modifier un modèle de fiche' },
    handler: async (request, reply) => {
      const { key } = request.params as { key: string }
      if (!/^[a-z0-9_]{2,60}$/.test(key)) return badRequest(reply, 'Clé de modèle invalide')
      const parsed = templatePatchSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const b = parsed.data
      if (b.label === undefined && b.permissions === undefined) return badRequest(reply, 'Aucune modification')
      if (b.permissions && rejectUnknownPermissions(reply, b.permissions)) return
      const schema = request.user.schemaName
      const res = await pool.query<{ id: string }>(
        `UPDATE "${schema}".hab_templates
            SET label = COALESCE($1, label),
                permissions = COALESCE($2::text[], permissions)
          WHERE key = $3 RETURNING id::text AS id, key, label, permissions`,
        [b.label ?? null, b.permissions ?? null, key],
      )
      const row = res.rows[0]
      if (!row) return reply.status(404).send({ error: 'Modèle introuvable' })
      audit(schema, request.user.sub, 'habilitation.template.updated', row.id, { key, ...b }, request.ip)
      return reply.send({ data: row })
    },
  })

  // ── Règles de cumul sensible (séparation des tâches) ───────────────────────
  fastify.get('/sod-rules', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Règles de cumul sensible' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const res = await pool.query(
        `SELECT id::text AS id, label, left_perm, right_perm, active
           FROM "${schema}".hab_sod_rules ORDER BY label`,
      )
      return reply.send({ data: res.rows })
    },
  })

  fastify.patch('/sod-rules/:id', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Activer ou désactiver une règle de cumul' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      // `active` seul est retenu : un corps portant d'autres champs est accepté
      // mais ignoré — les deux permissions d'une règle ne sont jamais réécrites.
      const parsed = sodPatchSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const schema = request.user.schemaName
      const res = await pool.query<{ id: string; active: boolean }>(
        `UPDATE "${schema}".hab_sod_rules SET active = $1 WHERE id = $2::uuid
         RETURNING id::text AS id, label, left_perm, right_perm, active`,
        [parsed.data.active, id],
      )
      const row = res.rows[0]
      if (!row) return reply.status(404).send({ error: 'Règle introuvable' })
      audit(schema, request.user.sub, 'habilitation.sod_rule.updated', row.id, { active: parsed.data.active }, request.ip)
      return reply.send({ data: row })
    },
  })

  // ── Premier responsable (avant toute fiche) ────────────────────────────────
  fastify.post('/bootstrap-user', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Habiliter le premier responsable' },
    handler: async (request, reply) => {
      const parsed = bootstrapSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const b = parsed.data
      if (!isUuid(b.userId) || !isUuid(b.subgroupId)) return badRequest(reply, 'Identifiant invalide')
      if (rejectUnknownPermissions(reply, b.permissions)) return
      const schema = request.user.schemaName
      // Cette porte ne s'ouvre qu'une fois : dès qu'une fiche (ou un précédent
      // bootstrap) a distribué des droits, la seule voie est le circuit de fiche.
      const already = await pool.query(
        `SELECT 1 FROM "${schema}".hab_assignments
          WHERE source IN ('fiche', 'bootstrap') AND revoked_at IS NULL LIMIT 1`,
      )
      if (already.rows.length > 0) {
        return reply.status(409).send({ error: 'Un responsable est déjà habilité — passez par une fiche d\'habilitation' })
      }
      const sg = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM "${schema}".hab_subgroups WHERE id = $1::uuid`,
        [b.subgroupId],
      )
      if (!sg.rows[0]) return reply.status(404).send({ error: 'Sous-groupe introuvable' })
      // Un seul jeu de droits par utilisateur (index unique sur user_id) : on
      // remplace une éventuelle ligne de reprise au lieu d'échouer.
      const res = await pool.query<{ id: string }>(
        `INSERT INTO "${schema}".hab_assignments (user_id, subgroup_id, permissions, source)
         VALUES ($1::uuid, $2::uuid, $3::text[], 'bootstrap')
         ON CONFLICT (user_id) DO UPDATE
           SET subgroup_id = EXCLUDED.subgroup_id,
               permissions = EXCLUDED.permissions,
               source = 'bootstrap', fiche_id = NULL, revoked_at = NULL
         RETURNING id::text AS id`,
        [b.userId, b.subgroupId, b.permissions],
      )
      audit(schema, request.user.sub, 'habilitation.bootstrap_user', b.userId, {
        subgroupId: b.subgroupId, permissions: b.permissions,
      }, request.ip)
      return reply.status(201).send({ data: { id: res.rows[0]?.id ?? null, userId: b.userId, permissions: b.permissions } })
    },
  })

  // ── « Ce que voit X » ──────────────────────────────────────────────────────
  fastify.get('/preview/:userId', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Aperçu des droits et du périmètre d\'un utilisateur' },
    handler: async (request, reply) => {
      const { userId } = request.params as { userId: string }
      if (!isUuid(userId)) return badRequest(reply, 'Identifiant invalide')
      const schema = request.user.schemaName
      const enforced = await readEnforced(schema)
      // MÊME moteur que authorize() : aucune réimplémentation du calcul.
      const ctx: HabContext | null = await loadHabContext(schema, userId)
      if (ctx === null) {
        return reply.send({
          data: {
            userId, enforced, hasAssignment: false, kind: null, subgroupId: null,
            permissions: [], allEntities: false, sensitive: false, manageHabilitations: false,
            // Pas d'affectation : accès hérité du rôle, rien n'est masqué.
            maskedFields: [], scope: { allEntities: true, includesNoEntity: true, entityIds: [], entities: [] },
          },
        })
      }
      const entities = await pool.query<{ id: string; name: string; is_head_office: boolean | null }>(
        `SELECT id::text AS id, name, is_head_office FROM "${schema}".legal_entities ORDER BY name`,
      ).catch(() => ({ rows: [] as { id: string; name: string; is_head_office: boolean | null }[] }))

      let entityIds: string[] = []
      let includesNoEntity = false
      if (ctx.kind === 'entity' && ctx.legalEntityId) entityIds = [ctx.legalEntityId]
      else if (ctx.kind === 'siege' && ctx.allEntities) {
        entityIds = entities.rows.map((e) => e.id)
        includesNoEntity = true
      } else if (ctx.kind === 'siege') {
        entityIds = ctx.headOfficeEntityIds
        includesNoEntity = true
      }
      const named = entityIds.map((id) => ({ id, name: entities.rows.find((e) => e.id === id)?.name ?? null }))
      return reply.send({
        data: {
          userId, enforced,
          hasAssignment: true,
          kind: ctx.kind,
          subgroupId: ctx.subgroupId,
          permissions: [...ctx.permissions].sort(),
          allEntities: ctx.allEntities,
          sensitive: ctx.sensitive,
          manageHabilitations: ctx.manageHabilitations,
          // Sans la case « données sensibles », l'utilisateur voit ces champs vides.
          maskedFields: ctx.sensitive ? [] : SENSITIVE_FIELDS,
          scope: { allEntities: ctx.kind === 'siege' && ctx.allEntities, includesNoEntity, entityIds, entities: named },
        },
      })
    },
  })

  // ── Rapport de reprise et activation ──────────────────────────────────────
  fastify.get('/takeover-report', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Rapport de reprise avant activation' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const enforced = await readEnforced(schema)
      const bySource = await pool.query<{ source: string; n: number; empty: number }>(
        `SELECT a.source, count(*)::int AS n,
                count(*) FILTER (WHERE coalesce(cardinality(a.permissions), 0) = 0)::int AS empty
           FROM "${schema}".hab_assignments a
          WHERE a.revoked_at IS NULL
          GROUP BY a.source ORDER BY a.source`,
      )
      const orphans = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${schema}".users u
          WHERE u.is_active = true
            AND u.role IN ('hr_manager', 'hr_officer', 'raf_site')
            AND NOT EXISTS (SELECT 1 FROM "${schema}".hab_assignments a WHERE a.user_id = u.id)`,
      )
      const subgroups = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${schema}".hab_subgroups`,
      )
      return reply.send({
        data: {
          enforced,
          assignments: bySource.rows.map((r) => ({ source: r.source, count: r.n, withoutPermissions: r.empty })),
          usersWithoutAssignment: orphans.rows[0]?.n ?? 0,
          subgroupCount: subgroups.rows[0]?.n ?? 0,
        },
      })
    },
  })

  fastify.post('/enforcement', {
    preHandler: [fastify.authorize('admin')],
    schema: { tags: ['habilitations'], summary: 'Activer ou suspendre le contrôle par la grille' },
    handler: async (request, reply) => {
      const parsed = enforcementSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const schema = request.user.schemaName
      const res = await pool.query<{ id: string }>(
        `UPDATE platform.tenants SET habilitations_enforced = $1 WHERE schema_name = $2 RETURNING id::text AS id`,
        [parsed.data.enabled, schema],
      )
      if (!res.rows[0]) return reply.status(404).send({ error: 'Client introuvable' })
      // Décision structurante : toujours auditée, même quand elle suspend le contrôle.
      audit(schema, request.user.sub, 'habilitation.enforcement.changed', null, { enabled: parsed.data.enabled }, request.ip)
      return reply.send({ data: { enforced: parsed.data.enabled } })
    },
  })
}

export default habilitationStructureRoutes
