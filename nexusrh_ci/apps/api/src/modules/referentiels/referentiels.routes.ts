import type { FastifyInstance } from 'fastify'
import {
  searchReferentiel, getHierarchyTree,
  getArticleById, getArticlesByPayrollCode,
  seedReferentiel, reindexFromDb, getReferentielStats,
} from './referentiels.service.js'
import { ensureIndex } from '../../services/elasticsearch.js'

export async function referentielsRoutes(app: FastifyInstance): Promise<void> {
  await ensureIndex().catch(err => app.log.warn('[ES] index non dispo:', err.message))

  // ── Recherche full-text ──────────────────────────────────────────────────────
  app.get('/search', {
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q:          { type: 'string', minLength: 1, maxLength: 200 },
          source:     { type: 'string', enum: ['code_travail_ci', 'convention_collective'] },
          convention: { type: 'string', maxLength: 50 },
          livre:      { type: 'string', maxLength: 100 },
          from:       { type: 'integer', minimum: 0, default: 0 },
          size:       { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        },
      },
    },
    preHandler: [app.authenticate, app.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly')],
  }, async (req, reply) => {
    try {
      return reply.send(await searchReferentiel(req.query as any))
    } catch (err: any) {
      app.log.error('[referentiels search]', err.message)
      return reply.status(503).send({ error: 'Service de recherche temporairement indisponible' })
    }
  })

  // ── Arborescence / Sommaire ──────────────────────────────────────────────────
  app.get('/tree', {
    preHandler: [app.authenticate],
  }, async (_req, reply) => {
    try {
      return reply.send(await getHierarchyTree())
    } catch { return reply.status(503).send({ error: 'Service indisponible' }) }
  })

  // ── Article par ID ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/articles/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', maxLength: 50 } } } },
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const article = await getArticleById(req.params.id).catch(() => null)
    if (!article) return reply.status(404).send({ error: 'Article non trouvé' })
    return reply.send(article)
  })

  // ── Liaison bulletin ↔ loi (icône ℹ sur chaque ligne de paie) ─────────────
  app.get<{ Params: { code: string } }>('/payroll/:code', {
    schema: { params: { type: 'object', properties: { code: { type: 'string', maxLength: 10 } } } },
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    try {
      return reply.send(await getArticlesByPayrollCode(req.params.code))
    } catch { return reply.status(503).send({ error: 'Service indisponible' }) }
  })

  // ── Stats admin ──────────────────────────────────────────────────────────────
  app.get('/stats', {
    preHandler: [app.authenticate, app.authorize('admin', 'hr_manager')],
  }, async (_req, reply) => {
    return reply.send(await getReferentielStats())
  })

  // ── Seed : data file → PostgreSQL → Elasticsearch (admin uniquement) ─────────
  app.post('/seed', {
    preHandler: [app.authenticate, app.authorize('admin', 'super_admin')],
  }, async (_req, reply) => {
    try {
      await ensureIndex()
      return reply.send({ success: true, ...(await seedReferentiel()) })
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })

  // ── Réindexation ES depuis PG (admin uniquement, sans re-seed) ──────────────
  app.post('/reindex', {
    preHandler: [app.authenticate, app.authorize('admin', 'super_admin')],
  }, async (_req, reply) => {
    try {
      const indexed = await reindexFromDb()
      return reply.send({ success: true, indexed })
    } catch (err: any) {
      return reply.status(500).send({ error: err.message })
    }
  })
}
