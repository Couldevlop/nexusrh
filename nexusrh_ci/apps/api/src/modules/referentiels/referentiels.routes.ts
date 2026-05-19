import type { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { config } from '../../config.js'
import {
  searchReferentiel, getHierarchyTree,
  getArticleById, getArticlesByPayrollCode,
  seedReferentiel, reindexFromDb, getReferentielStats,
} from './referentiels.service.js'
import { ensureIndex } from '../../services/elasticsearch.js'

const pool = new Pool({ connectionString: config.database.url })

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
          source:     { type: 'string', maxLength: 40 },     // élargi multi-pays
          countryCode:{ type: 'string', minLength: 3, maxLength: 3 },
          convention: { type: 'string', maxLength: 50 },
          livre:      { type: 'string', maxLength: 100 },
          from:       { type: 'integer', minimum: 0, default: 0 },
          size:       { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        },
      },
    },
    preHandler: [app.authenticate, app.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'raf_site')],
  }, async (req, reply) => {
    try {
      return reply.send(await searchReferentiel(req.query as any))
    } catch (err: any) {
      app.log.error('[referentiels search]', err.message)
      return reply.status(503).send({ error: 'Service de recherche temporairement indisponible' })
    }
  })

  // ── Contexte pays du user connecté ──────────────────────────────────────────
  // Retourne le pays applicable au profil :
  //   - super_admin / pas de tenant : null (tous)
  //   - tenant.has_subsidiaries=false : default_country_code (CIV)
  //   - tenant multi-pays : pays de la legal_entity de l'employé connecté
  app.get('/my-country', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const user = req.user
    if (!user.tenantId) {
      return reply.send({ countryCode: null, hasSubsidiaries: false, scope: 'platform' })
    }
    try {
      const t = await pool.query<{
        has_subsidiaries: boolean; default_country_code: string
      }>(
        `SELECT has_subsidiaries, default_country_code
         FROM platform.tenants WHERE id = $1 LIMIT 1`,
        [user.tenantId],
      )
      const tenant = t.rows[0]
      if (!tenant) return reply.send({ countryCode: null, hasSubsidiaries: false, scope: 'unknown' })
      if (!tenant.has_subsidiaries) {
        return reply.send({
          countryCode: tenant.default_country_code,
          hasSubsidiaries: false,
          scope: 'single_country',
        })
      }
      // Tenant multi-pays : tenter de récupérer le pays de la legal_entity
      // de l'employé connecté. Si non rattaché, renvoyer tenant.default.
      const emp = await pool.query<{ country_code: string | null }>(
        `SELECT le.country_code
           FROM "${user.schemaName}".employees e
           LEFT JOIN "${user.schemaName}".legal_entities le ON le.id = e.legal_entity_id
          WHERE e.email = $1 OR e.user_id = $2
          LIMIT 1`,
        [user.email, user.sub],
      ).catch(() => ({ rows: [] as Array<{ country_code: string | null }> }))
      return reply.send({
        countryCode: emp.rows[0]?.country_code ?? tenant.default_country_code,
        hasSubsidiaries: true,
        scope: 'multi_country',
        defaultCountryCode: tenant.default_country_code,
      })
    } catch (err: any) {
      app.log.warn('[referentiels my-country]', err.message)
      return reply.send({ countryCode: 'CIV', hasSubsidiaries: false, scope: 'fallback' })
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
