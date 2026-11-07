/**
 * Fiche d'habilitation — routes Fastify (prefix /habilitations).
 *
 * Ces routes ne sont PAS protégées par `authorize(...)` : les acteurs du
 * circuit sont des personnes désignées par la fiche (le N+1, le N+2), pas des
 * rôles. Un manager sans la moindre case de la grille doit pouvoir valider la
 * fiche dont il est le validateur, et personne d'autre. Le contrôle est donc
 * posé fiche par fiche dans le service (acteur attendu à l'étape), et les
 * routes se contentent d'authentifier, de refuser un jeton de plateforme et de
 * charger le contexte d'habilitation du demandeur.
 *
 * SÉCURITÉ : OWASP A01 (acteur attendu, aucune auto-habilitation, application
 * réservée à l'admin), A03 (Zod + UUID validés), A09 (le service audite).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { z } from 'zod'
import { badRequest, badRequestFromZod } from '../../utils/http-errors.js'
import { ensureTenantSchemaHook } from '../../utils/tenant-schema-hook.js'
import { loadHabContext, isUuid, type HabContext } from '../../services/habilitation.service.js'
import {
  createFiche, submitFiche, validateFiche, rejectFiche, editFiche, applyFiche,
  listFiches, getFicheWithEvents, FicheError,
} from './fiche.service.js'
import { renderFichePdf } from './fiche-pdf.js'

const createSchema = z.object({
  targetUserId: z.string(),
  subgroupId: z.string(),
  permissions: z.array(z.string().min(1).max(60)).max(200),
  motive: z.string().max(2000).optional().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  kind: z.enum(['grant', 'revoke']).optional(),
  templateKey: z.string().max(60).optional().nullable(),
}).strict()

const patchSchema = z.object({
  permissions: z.array(z.string().min(1).max(60)).max(200).optional(),
  motive: z.string().max(2000).optional().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
}).strict()

const validateSchema = z.object({ acceptSod: z.boolean().optional() }).strict()
const rejectSchema = z.object({ reason: z.string().min(1).max(2000) }).strict()

/** Traduit une erreur métier du circuit en réponse HTTP ; relance le reste. */
function sendFicheError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof FicheError) return reply.status(err.status).send({ error: err.message })
  throw err
}

const ficheRoutes: FastifyPluginAsync = async (fastify) => {
  // Même ordonnancement que structure.routes.ts : la migration paresseuse est
  // dans la chaîne de la route, après `authenticate`.

  /** Contexte d'habilitation du demandeur (null = accès hérité du rôle). */
  async function ctxOf(schema: string, userId: string): Promise<HabContext | null> {
    return loadHabContext(schema, userId)
  }

  fastify.get('/fiches', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Fiches dont je suis acteur' },
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      const rows = await listFiches(schema, request.user.sub, request.user.role)
      return reply.send({ data: rows })
    },
  })

  fastify.get('/fiches/:id', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Une fiche et son journal' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      try {
        const found = await getFicheWithEvents(request.user.schemaName, id, request.user.sub, request.user.role)
        // Hors circuit : 404 et non 403 — l'existence d'une fiche ne se devine pas.
        if (!found) return reply.status(404).send({ error: 'Fiche introuvable' })
        return reply.send({ data: found })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.post('/fiches', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Rédiger une fiche d\'habilitation' },
    handler: async (request, reply) => {
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      const b = parsed.data
      if (!isUuid(b.targetUserId) || !isUuid(b.subgroupId)) return badRequest(reply, 'Identifiant invalide')
      const schema = request.user.schemaName
      try {
        const fiche = await createFiche(schema, {
          actorId: request.user.sub, role: request.user.role,
          ctx: await ctxOf(schema, request.user.sub), ip: request.ip,
          // Délégation : branchée par la tâche 12 (table hab_delegations).
          delegation: null,
        }, b)
        return reply.status(201).send({ data: fiche })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.patch('/fiches/:id', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Modifier une fiche à son étape' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      const parsed = patchSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      if (Object.keys(parsed.data).length === 0) return badRequest(reply, 'Aucune modification')
      try {
        const fiche = await editFiche(
          request.user.schemaName, id, request.user.sub, request.user.role, parsed.data, undefined, request.ip,
        )
        return reply.send({ data: fiche })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.post('/fiches/:id/submit', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Soumettre la fiche au N+1' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      try {
        const fiche = await submitFiche(
          request.user.schemaName, id, request.user.sub, request.user.role, undefined, request.ip,
        )
        return reply.send({ data: fiche })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.post('/fiches/:id/validate', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Valider la fiche à mon étape' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      const parsed = validateSchema.safeParse(request.body ?? {})
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      try {
        const fiche = await validateFiche(
          request.user.schemaName, id, request.user.sub, request.user.role, parsed.data, undefined, request.ip,
        )
        return reply.send({ data: fiche })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.post('/fiches/:id/reject', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Refuser la fiche, motif obligatoire' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      const parsed = rejectSchema.safeParse(request.body)
      if (!parsed.success) return badRequestFromZod(reply, parsed.error)
      try {
        const fiche = await rejectFiche(
          request.user.schemaName, id, request.user.sub, request.user.role, parsed.data.reason, undefined, request.ip,
        )
        return reply.send({ data: fiche })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.get('/fiches/:id/pdf', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Fiche au format PDF' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      const schema = request.user.schemaName
      try {
        // Même porte que la lecture : hors circuit, la fiche n'existe pas.
        const found = await getFicheWithEvents(schema, id, request.user.sub, request.user.role)
        if (!found) return reply.status(404).send({ error: 'Fiche introuvable' })
        const { pdf, number } = await renderFichePdf(schema, id)
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `inline; filename="fiche-${number}.pdf"`)
          .header('Content-Security-Policy', "default-src 'none'")
          .send(Buffer.from(pdf))
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })

  fastify.post('/fiches/:id/apply', {
    preHandler: [fastify.authenticate, ensureTenantSchemaHook],
    schema: { tags: ['habilitations'], summary: 'Appliquer la fiche (admin)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!isUuid(id)) return badRequest(reply, 'Identifiant invalide')
      try {
        const fiche = await applyFiche(
          request.user.schemaName, id, request.user.sub, request.user.role, request.ip,
        )
        return reply.send({ data: fiche })
      } catch (err) {
        return sendFicheError(reply, err)
      }
    },
  })
}

export default ficheRoutes
