/**
 * Tests des routes /referentiels — filtre multi-pays
 *
 * Couvre :
 *  - GET /search avec countryCode propage le filtre
 *  - GET /my-country renvoie le bon scope (platform / single / multi)
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
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

// Mock du service pour isoler les routes de la couche ES/PG bas-niveau
const searchMock = vi.fn()
vi.mock('./referentiels.service.js', () => ({
  searchReferentiel:        (...args: unknown[]) => searchMock(...args),
  getHierarchyTree:         vi.fn().mockResolvedValue([]),
  getArticleById:           vi.fn().mockResolvedValue(null),
  getArticlesByPayrollCode: vi.fn().mockResolvedValue([]),
  seedReferentiel:          vi.fn().mockResolvedValue({ persisted: 0, indexed: 0 }),
  reindexFromDb:            vi.fn().mockResolvedValue(0),
  getReferentielStats:      vi.fn().mockResolvedValue({ pg_count: 0, es_count: 0 }),
}))

vi.mock('../../services/elasticsearch.js', () => ({
  ensureIndex: vi.fn().mockResolvedValue(undefined),
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
})

describe('GET /referentiels/search — filtre countryCode', () => {
  it('propage countryCode au service (BEN)', async () => {
    searchMock.mockResolvedValueOnce({ total: 0, hits: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/referentiels/search?q=conge&countryCode=BEN',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'conge', countryCode: 'BEN' }),
    )
  })

  it('refuse un countryCode mal formé (4 caractères)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET',
      url: '/referentiels/search?q=conge&countryCode=BENI',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un raf_site peut consulter le référentiel (rôle ajouté à la whitelist)', async () => {
    searchMock.mockResolvedValueOnce({ total: 0, hits: [] })
    const token = tokenFor(app, 'raf_site')
    const res = await app.inject({
      method: 'GET',
      url: '/referentiels/search?q=conge',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('GET /referentiels/my-country', () => {
  it('super_admin → scope=platform, countryCode=null', async () => {
    const token = app.jwt.sign({
      sub: 'sa', tenantId: null, schemaName: 'platform', role: 'super_admin',
      email: 'sa@nexusrh-ci.com', firstName: 'S', lastName: 'A', employeeId: null,
    })
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      countryCode: null, hasSubsidiaries: false, scope: 'platform',
    })
  })

  it('tenant mono-pays → scope=single_country, countryCode=default', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ has_subsidiaries: false, default_country_code: 'CIV' }],
    })
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      countryCode: 'CIV', hasSubsidiaries: false, scope: 'single_country',
    })
  })

  it('tenant multi-pays → scope=multi_country, retourne le pays de la filiale', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true, default_country_code: 'CIV' }] })
      .mockResolvedValueOnce({ rows: [{ country_code: 'BEN' }] })
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scope).toBe('multi_country')
    expect(body.countryCode).toBe('BEN')
    expect(body.defaultCountryCode).toBe('CIV')
  })

  it('tenant multi-pays + employé sans filiale rattachée → fallback default', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ has_subsidiaries: true, default_country_code: 'CIV' }] })
      .mockResolvedValueOnce({ rows: [{ country_code: null }] })
    const token = tokenFor(app, 'manager')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).countryCode).toBe('CIV')
  })

  it('tenant inconnu → scope=unknown', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/referentiels/my-country',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).scope).toBe('unknown')
  })
})
