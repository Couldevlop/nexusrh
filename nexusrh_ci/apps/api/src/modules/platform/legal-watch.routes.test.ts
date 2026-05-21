import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, poolConnectMock, analyzeDiffMock } = vi.hoisted(() => ({
  queryMock:       vi.fn(),
  poolConnectMock: vi.fn(),
  analyzeDiffMock: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    query:   queryMock,
    connect: poolConnectMock,
    end:     vi.fn(),
  })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../services/legal-diff.service.js', () => ({
  analyzeLegalDiff: analyzeDiffMock,
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import legalWatchRoutes from './legal-watch.routes.js'

const UUID_A = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: null, schemaName: 'platform', role,
    email: `${role}@nexusrh.com`, firstName: 'Test', lastName: 'User', employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(legalWatchRoutes, { prefix: '/platform/legal-watch' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  poolConnectMock.mockReset()
  analyzeDiffMock.mockReset()
})

describe('POST /platform/legal-watch/analyze — Zod strict + RBAC + masking IA (OWASP A03 + A10)', () => {
  it('un admin (non super_admin) ne peut PAS analyser (403)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse champs inconnus (.strict)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', proposed_text: 'x'.repeat(50), evil_flag: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse source code format libre (regex)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'INVALID source!', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse country_code hors format ISO alpha-3 (400)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', country_code: 'civ', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse article_id fantôme (vérification existence, A04)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // article inexistant
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', article_id: 'ghost-article-id', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('ghost-article-id')
  })

  it('masque les erreurs Anthropic internes en 500 générique (OWASP A10)', async () => {
    analyzeDiffMock.mockRejectedValueOnce(new Error('Anthropic API: rate_limit_exceeded at sk-ant-XXXX endpoint timeout'))
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/analyze',
      headers: { authorization: `Bearer ${token}` },
      payload: { source: 'code_travail', proposed_text: 'x'.repeat(50) },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('sk-ant')
    expect(res.body).not.toContain('rate_limit_exceeded')
  })
})

describe('GET /platform/legal-watch/proposals/:id — UUID strict (OWASP A03)', () => {
  it('refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/proposals/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte UUID valide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'pending' }] })
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: `/platform/legal-watch/proposals/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /platform/legal-watch/proposals/:id/approve|reject — UUID + RBAC', () => {
  it('approve refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/proposals/not-uuid/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('reject refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: '/platform/legal-watch/proposals/not-uuid/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('approve refuse review notes au-dessus de 2000 chars', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: 'x'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('admin (non super_admin) ne peut PAS reject (403)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: `/platform/legal-watch/proposals/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /platform/legal-watch/sources-catalog — country whitelist (OWASP A03)', () => {
  it('refuse country format libre (400)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/sources-catalog?country=civ',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse country hors catalogue (404)', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/sources-catalog?country=ZZZ',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('sans country : retourne le catalogue complet', async () => {
    const token = tokenFor(app, 'super_admin')
    const res = await app.inject({
      method: 'GET', url: '/platform/legal-watch/sources-catalog',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBeGreaterThan(0)
  })
})
