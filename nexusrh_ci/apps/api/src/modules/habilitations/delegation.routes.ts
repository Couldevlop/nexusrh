/**
 * Habilitations RH — délégation temporaire du droit de rédiger des fiches.
 *
 * Le besoin : un DRH part en congé et le circuit d'habilitation doit continuer
 * à tourner. La délégation transmet SON pouvoir de rédaction, pour une durée
 * bornée, sur SON périmètre — jamais au-delà.
 *
 * Trois bornes, toutes refusées côté serveur (l'écran ne fait que les afficher) :
 *  1. **Durée.** `endsAt` est obligatoire, dans le futur, à 90 jours au plus.
 *     Une délégation sans fin est une habilitation permanente que personne ne
 *     relit ; c'est exactement ce que la grille sert à éviter.
 *  2. **Périmètre.** Le délégataire doit déjà être affecté à un sous-groupe du
 *     périmètre du délégant. Déléguer à quelqu'un d'ailleurs reviendrait à
 *     élargir les droits du délégant par la bande.
 *  3. **Chaîne.** Un délégataire ne délègue pas à son tour : la trace
 *     resterait lisible, mais plus personne ne saurait qui répond du droit.
 *
 * L'EXPIRATION NE DÉPEND D'AUCUN JOB : `activeDelegation` filtre sur
 * `now() BETWEEN starts_at AND ends_at AND revoked_at IS NULL` à chaque appel.
 * Le job quotidien du worker ne fait que TRACER l'échéance — s'il ne tournait
 * pas, les droits tomberaient quand même à la bonne seconde.
 *
 * SÉCURITÉ : OWASP A01 (porteur de `manage_habilitations` ou admin du tenant
 * seulement ; la révocation est bornée au délégant, l'admin excepté), A03 (Zod,
 * UUID validés, nom de schéma interpolé après validation du jeton), A09 (chaque
 * création et chaque révocation sont auditées ; aucune donnée personnelle n'est
 * journalisée, seulement des identifiants et la date de fin).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { auditTenant } from '../../utils/audit-log.js'
import { badRequest, badRequestFromZod } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { assertValidSchemaName } from '../../utils/schema-name.js'
import { loadHabContext, isUuid } from '../../services/habilitation.service.js'
import type { Delegation } from './fiche.service.js'

/** Plafond de durée d'une délégation, en jours. */
export const MAX_DELEGATION_DAYS = 90

/** Codes PostgreSQL « table absente » / « colonne absente » : tenant non migré. */
const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

interface Db {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>
}

const createSchema = z.object({
  delegateId: z.string(),
  endsAt: z.string().min(1),
}).strict()

function forbidden(reply: FastifyReply, msg: string) {
  return reply.status(403).send({ error: msg })
}

function audit(
  schema: string, userId: string | undefined, action: string,
  entityId: string | null, changes: Record<string, unknown>, ip: string | null,
): void {
  auditTenant(schema, { userId: userId ?? null, action, entity: 'habilitation', entityId, changes, ip })
}

/**
 * Délégation en cours pour `userId`, ou `null`.
 *
 * La fenêtre de validité et la révocation sont filtrées DANS le SQL : aucun
 * calcul de date côté Node, donc aucune dérive d'horloge entre l'API et la
 * base. Un tenant provisionné avant ce module (table absente) répond `null` —
 * l'absence de délégation n'est pas une panne.
 */
export async function activeDelegation(
  schema: string, userId: string, db: Db = pool,
): Promise<Delegation | null> {
  assertValidSchemaName(schema)
  if (!isUuid(userId)) return null
  try {
    const res = await db.query<{
      id: string; delegator_id: string; subgroup_id: string | null; ends_at: string
    }>(
      `SELECT d.id::text AS id, d.delegator_id::text AS delegator_id,
              d.subgroup_id::text AS subgroup_id, d.ends_at
         FROM "${schema}".hab_delegations d
        WHERE d.delegate_id = $1
          AND d.revoked_at IS NULL
          AND now() BETWEEN d.starts_at AND d.ends_at
        ORDER BY d.ends_at DESC
        LIMIT 1`,
      [userId],
    )
    const row = res.rows[0]
    if (!row) return null
    return {
      id: row.id,
      delegatorId: row.delegator_id,
      subgroupId: row.subgroup_id,
      endsAt: new Date(row.ends_at).toISOString(),
    }
  } catch (err) {
    if (isMissingSchemaObject(err)) return null
    throw err
  }
}

/** Sous-groupe d'affectation du délégataire visé, et groupe de ce sous-groupe. */
async function delegateScope(
  schema: string, userId: string,
): Promise<{ subgroupId: string; groupId: string } | null> {
  const res = await pool.query<{ subgroup_id: string; group_id: string }>(
    `SELECT a.subgroup_id::text AS subgroup_id, sg.group_id::text AS group_id
       FROM "${schema}".hab_assignments a
       JOIN "${schema}".hab_subgroups sg ON sg.id = a.subgroup_id
      WHERE a.user_id = $1 AND a.revoked_at IS NULL
      LIMIT 1`,
    [userId],
  )
  const row = res.rows[0]
  return row ? { subgroupId: row.subgroup_id, groupId: row.group_id } : null
}

/** Groupe du sous-groupe du délégant (pour comparer les périmètres). */
async function groupOfSubgroup(schema: string, subgroupId: string): Promise<string | null> {
  const res = await pool.query<{ group_id: string }>(
    `SELECT sg.group_id::text AS group_id
       FROM "${schema}".hab_subgroups sg
      WHERE sg.id = $1
      LIMIT 1`,
    [subgroupId],
  )
  return res.rows[0]?.group_id ?? null
}

const delegationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Les délégations qui me concernent — celles que j'ai données ET celle que
   * j'ai reçue. Route ouverte à tout utilisateur authentifié : un délégataire
   * n'a aucune case de la grille, et il doit pourtant voir sa procuration.
   */
  fastify.get('/delegations', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Mes délégations (données et reçues)' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      try {
        const res = await pool.query(
          `SELECT d.id::text AS id, d.delegator_id::text AS delegator_id,
                  d.delegate_id::text AS delegate_id, d.subgroup_id::text AS subgroup_id,
                  d.starts_at, d.ends_at, d.revoked_at,
                  (d.revoked_at IS NULL AND now() BETWEEN d.starts_at AND d.ends_at) AS active
             FROM "${schema}".hab_delegations d
            WHERE d.delegator_id = $1 OR d.delegate_id = $1
            ORDER BY d.ends_at DESC
            LIMIT 200`,
          [request.user.sub],
        )
        return reply.send({ data: res.rows })
      } catch (err) {
        if (isMissingSchemaObject(err)) return reply.send({ data: [] })
        throw err
      }
    },
  })

  fastify.post('/delegations', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Déléguer la rédaction de fiches' },
    handler: async (request, reply) => {
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const { delegateId, endsAt } = parsed.data
      const schema = request.user.schemaName
      const me = request.user.sub

      if (!isUuid(delegateId)) return badRequest(reply, 'Identifiant invalide')
      if (delegateId === me) return badRequest(reply, 'Impossible de se déléguer à soi-même')

      const end = new Date(endsAt)
      if (Number.isNaN(end.getTime())) return badRequest(reply, 'Date de fin invalide')
      const now = Date.now()
      if (end.getTime() <= now) return badRequest(reply, 'La date de fin doit être dans le futur')
      const maxMs = MAX_DELEGATION_DAYS * 24 * 3600 * 1000
      if (end.getTime() - now > maxMs) {
        return badRequest(reply, `Une délégation dure ${MAX_DELEGATION_DAYS} jours au plus`)
      }

      // Qui peut déléguer : l'admin du tenant, ou un porteur de la case
      // « gérer les habilitations ». Une délégation reçue ne suffit PAS —
      // sinon la chaîne de responsabilité deviendrait illisible.
      const ctx = request.user.role === 'admin' ? null : await loadHabContext(schema, me)
      const isAdmin = request.user.role === 'admin'
      if (!isAdmin && !ctx?.manageHabilitations) {
        const received = await activeDelegation(schema, me)
        if (received) {
          return forbidden(reply, 'Un délégataire ne peut pas déléguer à son tour')
        }
        return forbidden(reply, 'Droit « gérer les habilitations » requis')
      }

      // Périmètre : le délégataire doit déjà être affecté dans le périmètre du
      // délégant. Une filiale ne délègue que dans son propre sous-groupe ; le
      // siège délègue dans n'importe quel sous-groupe de son groupe.
      const target = await delegateScope(schema, delegateId)
      if (!target) return forbidden(reply, 'Le délégataire n\'a aucune habilitation à ce jour')

      let subgroupId: string | null = null
      if (!isAdmin && ctx) {
        if (ctx.kind === 'entity') {
          if (target.subgroupId !== ctx.subgroupId) {
            return forbidden(reply, 'Le délégataire est hors de votre périmètre')
          }
          subgroupId = ctx.subgroupId
        } else {
          const myGroup = await groupOfSubgroup(schema, ctx.subgroupId)
          if (myGroup && target.groupId !== myGroup) {
            return forbidden(reply, 'Le délégataire est hors de votre périmètre')
          }
        }
      }

      const res = await pool.query<{ id: string; ends_at: string }>(
        `INSERT INTO "${schema}".hab_delegations (delegator_id, delegate_id, subgroup_id, ends_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text AS id, ends_at`,
        [me, delegateId, subgroupId, end.toISOString()],
      )
      const row = res.rows[0]
      audit(schema, me, 'habilitation.delegation.created', row?.id ?? null, {
        delegateId, subgroupId, endsAt: end.toISOString(),
      }, request.ip)
      return reply.status(201).send({ data: row })
    },
  })

  /**
   * Révocation immédiate. Bornée au délégant (l'admin peut révoquer toute
   * délégation de son tenant) : un délégataire ne se décharge pas lui-même
   * d'une procuration dont le délégant répond.
   */
  fastify.delete('/delegations/:id', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Révoquer une délégation' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      const schema = request.user.schemaName
      const isAdmin = request.user.role === 'admin'
      const res = await pool.query<{ id: string }>(
        `UPDATE "${schema}".hab_delegations
            SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
            AND ($2::boolean OR delegator_id = $3)
          RETURNING id::text AS id`,
        [id, isAdmin, request.user.sub],
      )
      if (res.rows.length === 0) return reply.status(404).send({ error: 'Délégation introuvable' })
      audit(schema, request.user.sub, 'habilitation.delegation.revoked', id, {}, request.ip)
      return reply.send({ data: { id } })
    },
  })
}

export default delegationRoutes
