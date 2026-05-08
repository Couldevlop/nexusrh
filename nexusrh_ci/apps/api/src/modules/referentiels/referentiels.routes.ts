import type { FastifyInstance } from 'fastify'
import {
  searchReferentiel, getHierarchyTree,
  getArticleById, getArticlesByPayrollCode, seedReferentiel,
} from './referentiels.service.js'
import { ensureIndex } from '../../services/elasticsearch.js'

export async function referentielsRoutes(app: FastifyInstance): Promise<void> {
  await ensureIndex().catch(err => app.log.warn('[ES] index non dispo:', err.message))

  app.get('/referentiels/search', {
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q:          { type: 'string', minLength: 1, maxLength: 200 },
          source:     { type: 'string', enum: ['code_travail_ci', 'convention_collective'] },
          convention: { type: 'string', maxLength: 50 },
          from:       { type: 'integer', minimum: 0, default: 0 },
          size:       { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
    preHandler: [app.authenticate, app.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly')],
  }, async (req, reply) => {
    const params = req.query as any
    try {
      return reply.send(await searchReferentiel(params))
    } catch (err: any) {
      app.log.error('[referentiels search]', err.message)
      return reply.status(503).send({ error: 'Service de recherche temporairement indisponible' })
    }
  })

  app.get('/referentiels/tree', {
    preHandler: [app.authenticate],
  }, async (_req, reply) => {
    try {
      return reply.send(await getHierarchyTree())
    } catch { return reply.status(503).send({ error: 'Service indisponible' }) }
  })

  app.get<{ Params: { id: string } }>('/referentiels/articles/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 50 } } } },
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const article = await getArticleById(req.params.id).catch(() => null)
    if (!article) return reply.status(404).send({ error: 'Article non trouvé' })
    return reply.send(article)
  })

  // Liaison bulletin ↔ loi : icône (i) sur chaque ligne de paie
  app.get<{ Params: { code: string } }>('/referentiels/payroll/:code', {
    schema: { params: { type: 'object', properties: { code: { type: 'string', maxLength: 10 } } } },
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    try {
      return reply.send(await getArticlesByPayrollCode(req.params.code))
    } catch { return reply.status(503).send({ error: 'Service indisponible' }) }
  })

  // Seed — admin uniquement
  app.post('/referentiels/seed', {
    preHandler: [app.authenticate, app.authorize('admin', 'super_admin')],
  }, async (_req, reply) => {
    try {
      await ensureIndex()
      return reply.send({ success: true, ...(await seedReferentiel()) })
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })
}
