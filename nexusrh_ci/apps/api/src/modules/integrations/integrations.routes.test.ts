/**
 * Routes Connectivité — RBAC admin (CRUD) + authentification par clé API
 * (API publique /integrations/v1/*, scope-gated).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.hoisted(() => { process.env['ENCRYPTION_KEY'] = 'a'.repeat(64) })
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn(), isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: { env: 'test', jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' }, database: { url: 'postgresql://test' }, redis: { url: 'redis://x' } },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/ssrf-guard.js', () => ({
  isSafeOutboundUrl: vi.fn().mockResolvedValue({ ok: true }),
  assertSafeOutboundUrl: vi.fn().mockResolvedValue(new URL('https://ok.example.com')),
}))
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }))
vi.mock('../../services/integrations.service.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>
  return {
    ...actual,
    resolveApiKey: resolveMock,
    emitIntegrationEvent: vi.fn(),
    deliverWebhook: vi.fn().mockResolvedValue(undefined),
    testConnector: vi.fn().mockResolvedValue({ ok: true, status: 200, message: 'HTTP 200' }),
  }
})

import authPlugin from '../../plugins/auth.js'
import integrationsRoutes from './integrations.routes.js'

let app: FastifyInstance
const tok = (role: string) => app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_test', role, email: 'a@t.ci', firstName: 'A', lastName: 'B', employeeId: null })

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(integrationsRoutes, { prefix: '/integrations' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }); resolveMock.mockReset() })

describe('Admin RBAC (/integrations)', () => {
  it('GET /webhooks sans token → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/integrations/webhooks' })).statusCode).toBe(401)
  })
  it('GET /webhooks employee → 403', async () => {
    const r = await app.inject({ method: 'GET', url: '/integrations/webhooks', headers: { authorization: `Bearer ${tok('employee')}` } })
    expect(r.statusCode).toBe(403)
  })
  it('GET /webhooks admin → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/integrations/webhooks', headers: { authorization: `Bearer ${tok('admin')}` } })
    expect(r.statusCode).toBe(200)
  })
  it('POST /webhooks admin valide → 201 + secret affiché une fois', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'w1' }] }) // INSERT RETURNING id
    const r = await app.inject({ method: 'POST', url: '/integrations/webhooks',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { name: 'Slack', target_url: 'https://hooks.example.com/x', events: ['employee.created'] } })
    expect(r.statusCode).toBe(201)
    expect(JSON.parse(r.body).secret).toMatch(/^whsec_/)
  })
  it('POST /webhooks event hors catalogue → 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/integrations/webhooks',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { name: 'x', target_url: 'https://h.example.com', events: ['inexistant.event'] } })
    expect(r.statusCode).toBe(400)
  })
  it('POST /api-keys admin valide → 201 + clé affichée une fois', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'k1' }] })
    const r = await app.inject({ method: 'POST', url: '/integrations/api-keys',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { name: 'PowerBI', scopes: ['employees:read'] } })
    expect(r.statusCode).toBe(201)
    expect(JSON.parse(r.body).apiKey).toMatch(/^nxk_/)
  })
  it('POST /connectors admin → 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    const r = await app.inject({ method: 'POST', url: '/integrations/connectors',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { name: 'Compta', base_url: 'https://api.example.com', auth_type: 'bearer', auth_secret: 'tok' } })
    expect(r.statusCode).toBe(201)
  })
})

describe('API publique (clé API, scope-gated)', () => {
  it('sans clé → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/integrations/v1/employees' })).statusCode).toBe(401)
  })
  it('clé invalide → 401', async () => {
    resolveMock.mockResolvedValue(null)
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/employees', headers: { authorization: 'Bearer nxk_bad.key' } })
    expect(r.statusCode).toBe(401)
  })
  it('scope insuffisant → 403', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['payroll:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/employees', headers: { 'x-api-key': 'nxk_test.k' } })
    expect(r.statusCode).toBe(403)
  })
  it('clé valide + scope → 200', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['employees:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/employees', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(r.body).data)).toBe(true)
  })
})
