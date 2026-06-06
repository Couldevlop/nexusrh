/**
 * Couverture complémentaire des routes /referentiels.
 *
 * Le test existant couvre /search (filtre pays) et /my-country (scopes).
 * Ce fichier couvre les routes et branches restantes :
 *  - ensureIndex échoue au boot → warn non bloquant
 *  - GET /search : erreur service → 503
 *  - GET /my-country : exception → fallback CIV ; multi-pays requête filiale rejetée
 *  - GET /tree : succès + 503
 *  - GET /articles/:id : 404 + succès
 *  - GET /payroll/:code : succès + 503
 *  - GET /stats : succès + RBAC (403 employee)
 *  - POST /seed : succès + 500 ; POST /reindex : succès + 500
 *  - audit log non bloquant (insert activity_log)
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const {
  queryMock, searchMock, treeMock, articleMock, payrollMock,
  seedMock, reindexMock, statsMock, ensureIndexMock,
} = vi.hoisted(() => ({
  queryMock:       vi.fn(),
  searchMock:      vi.fn(),
  treeMock:        vi.fn(),
  articleMock:     vi.fn(),
  payrollMock:     vi.fn(),
  seedMock:        vi.fn(),
  reindexMock:     vi.fn(),
  statsMock:       vi.fn(),
  ensureIndexMock: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

vi.mock('./referentiels.service.js', () => ({
  searchReferentiel:        (...a: unknown[]) => searchMock(...a),
  getHierarchyTree:         (...a: unknown[]) => treeMock(...a),
  getArticleById:           (...a: unknown[]) => articleMock(...a),
  getArticlesByPayrollCode: (...a: unknown[]) => payrollMock(...a),
  seedReferentiel:          (...a: unknown[]) => seedMock(...a),
  reindexFromDb:            (...a: unknown[]) => reindexMock(...a),
  getReferentielStats:      (...a: unknown[]) => statsMock(...a),
}))

vi.mock('../../services/elasticsearch.js', () => ({
  ensureIndex: (...a: unknown[]) => ensureIndexMock(...a),
  esClient: {},
  ES_INDEX: 'test',
}))

import authPlugin from '../../plugins/auth.js'
import { referentielsRoutes } from './referentiels.routes.js'

const SCHEMA = 'tenant_pme'

function tokenFor(app: FastifyInstance, role: string, sub = 'u-' + role) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@pme.ci`, firstName: 'X', lastName: 'Y', employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  // ensureIndex rejette au boot pour couvrir le .catch() de warn non bloquant.
  ensureIndexMock.mockRejectedValueOnce(new Error('ES indisponible au boot'))
  app = Fastify()
  await app.register(authPlugin)
  await app.register(async (instance) => {
    await referentielsRoutes(instance)
  }, { prefix: '/referentiels' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  searchMock.mockReset()
  treeMock.mockReset()
  articleMock.mockReset()
  payrollMock.mockReset()
  seedMock.mockReset()
  reindexMock.mockReset()
  statsMock.mockReset()
  ensureIndexMock.mockReset()
  ensureIndexMock.mockResolvedValue(undefined)
  queryMock.mockResolvedValue({ rows: [] })
})

describe('GET /referentiels/search — erreur service', () => {
  it('le service lève → 503 message générique', async () => {
    searchMock.mockRejectedValueOnce(new Error('ES timeout'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/search?q=conge',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toMatch(/indisponible/i)
  })
})

describe('GET /referentiels/my-country — branches restantes', () => {
  it('multi-pays + requête filiale en erreur → fallback default_country_code', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true, default_country_code: 'CIV' }] })
      .mockRejectedValueOnce(new Error('schema introuvable')) // requête filiale rejetée → .catch
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // .catch renvoie rows vide → countryCode = default
    expect(JSON.parse(res.body).countryCode).toBe('CIV')
  })

  it('exception sur la requête tenant → fallback scope=fallback', async () => {
    queryMock.mockRejectedValueOnce(new Error('pool down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scope).toBe('fallback')
    expect(body.countryCode).toBe('CIV')
  })
})

describe('GET /referentiels/tree', () => {
  it('succès → 200', async () => {
    treeMock.mockResolvedValueOnce([{ titre: 'Livre I' }])
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/tree',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
  })

  it('erreur service → 503', async () => {
    treeMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/tree',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(503)
  })
})

describe('GET /referentiels/articles/:id', () => {
  it('article introuvable → 404', async () => {
    articleMock.mockResolvedValueOnce(null)
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/articles/art-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('article trouvé → 200', async () => {
    articleMock.mockResolvedValueOnce({ article_id: 'art-1', titre_article: 'Congés' })
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/articles/art-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).article_id).toBe('art-1')
  })

  it('service lève → catch → 404', async () => {
    articleMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/articles/art-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /referentiels/payroll/:code', () => {
  it('succès → 200', async () => {
    payrollMock.mockResolvedValueOnce([{ article_id: 'art-2' }])
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/payroll/2000',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('erreur service → 503', async () => {
    payrollMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/payroll/2000',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(503)
  })
})

describe('GET /referentiels/stats — RBAC', () => {
  it('hr_manager → 200', async () => {
    statsMock.mockResolvedValueOnce({ pg_count: 10, es_count: 10 })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/stats',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).pg_count).toBe(10)
  })

  it('employee → 403', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/stats',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /referentiels/seed', () => {
  it('succès → 200 + audit log non bloquant', async () => {
    seedMock.mockResolvedValueOnce({ persisted: 5, indexed: 5 })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/referentiels/seed',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.success).toBe(true)
    expect(body.persisted).toBe(5)
    // l'audit log a tenté un INSERT activity_log
    expect(queryMock).toHaveBeenCalled()
  })

  it('échec du seed → 500 message masqué', async () => {
    seedMock.mockRejectedValueOnce(new Error('connection string leaked: postgres://secret'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/referentiels/seed',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('secret')
    expect(JSON.parse(res.body).error).toMatch(/Échec du seed/i)
  })

  it('audit log : INSERT activity_log en erreur reste non bloquant (200)', async () => {
    seedMock.mockResolvedValueOnce({ persisted: 1, indexed: 1 })
    queryMock.mockRejectedValueOnce(new Error('table activity_log absente'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/referentiels/seed',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('un employee ne peut PAS seed → 403', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST', url: '/referentiels/seed',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /referentiels/reindex', () => {
  it('succès → 200', async () => {
    reindexMock.mockResolvedValueOnce(42)
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/referentiels/reindex',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).indexed).toBe(42)
  })

  it('échec → 500 message masqué', async () => {
    reindexMock.mockRejectedValueOnce(new Error('ES bulk failed at node http://internal'))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/referentiels/reindex',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('internal')
    expect(JSON.parse(res.body).error).toMatch(/réindexation/i)
  })
})
