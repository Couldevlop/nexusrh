/**
 * Hook `preHandler` de migration paresseuse du schéma tenant — UNIQUE.
 *
 * Vingt-deux modules déclaraient chacun ce hook, mot pour mot :
 *
 *     fastify.addHook('preHandler', async (request) => {
 *       const schema = request.user?.schemaName
 *       if (schema) await ensureTenantSchema(schema)
 *     })
 *
 * C'est un cas d'école de duplication à conséquence : le hook doit s'exécuter
 * APRÈS `authenticate` (sinon `request.user` n'est pas encore résolu et la
 * migration ne se fait jamais — bug déjà rencontré sur ce dépôt). Avec vingt-deux
 * copies, cette contrainte d'ordonnancement devait être respectée vingt-deux
 * fois, sans que rien ne la rappelle au moment d'ajouter un module.
 *
 * `request.user?.schemaName` est absent tant que l'authentification n'a pas eu
 * lieu : le `if (schema)` rend le hook inoffensif sur les routes publiques, et
 * `ensureTenantSchema` est idempotent (mémoïsé par schéma).
 */
import type { FastifyRequest } from 'fastify'
import { ensureTenantSchema } from './schema-migrations.js'

export async function ensureTenantSchemaHook(request: FastifyRequest): Promise<void> {
  const schema = (request.user as { schemaName?: string } | undefined)?.schemaName
  if (schema) await ensureTenantSchema(schema)
}
