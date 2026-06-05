/**
 * Routes Connectivité — couverture exhaustive : API publique (/v1/me, /v1/employees,
 * /v1/payslips), catalogues (events/scopes), CRUD webhooks/clés API/connecteurs
 * (PATCH, DELETE, test, deliveries), validations (id invalide, SSRF 422, 404,
 * corps invalide) et journalisation. Tout est mocké (aucun réseau / DB réelle).
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
const { safeMock } = vi.hoisted(() => ({ safeMock: vi.fn() }))
vi.mock('../../services/ssrf-guard.js', () => ({
  isSafeOutboundUrl: safeMock,
  assertSafeOutboundUrl: vi.fn().mockResolvedValue(new URL('https://ok.example.com')),
}))
const { resolveMock, deliverMock, testConnectorMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(), deliverMock: vi.fn(), testConnectorMock: vi.fn(),
}))
vi.mock('../../services/integrations.service.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>
  return {
    ...actual,
    resolveApiKey: resolveMock,
    emitIntegrationEvent: vi.fn(),
    deliverWebhook: deliverMock,
    testConnector: testConnectorMock,
  }
})

import authPlugin from '../../plugins/auth.js'
import integrationsRoutes from './integrations.routes.js'

let app: FastifyInstance
const UUID = '11111111-1111-1111-1111-111111111111'
const tok = (role: string) => app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_test', role, email: 'a@t.ci', firstName: 'A', lastName: 'B', employeeId: null })
const adminH = () => ({ authorization: `Bearer ${tok('admin')}` })

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(integrationsRoutes, { prefix: '/integrations' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  resolveMock.mockReset()
  deliverMock.mockReset().mockResolvedValue(undefined)
  testConnectorMock.mockReset().mockResolvedValue({ ok: true, status: 200, message: 'HTTP 200' })
  safeMock.mockReset().mockResolvedValue({ ok: true })
})

// ── API publique ──────────────────────────────────────────────────────────────
describe('API publique /integrations/v1', () => {
  it('GET /v1/me sans clé → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/integrations/v1/me' })).statusCode).toBe(401)
  })
  it('GET /v1/me clé valide → 200 + contexte', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['employees:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/me', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).data).toMatchObject({ tenantId: 't1', scopes: ['employees:read'] })
  })
  it('GET /v1/me via X-API-Key (header alternatif) → 200', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: [] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/me', headers: { 'x-api-key': 'nxk_test.k' } })
    expect(r.statusCode).toBe(200)
  })
  it('GET /v1/employees avec limit/offset → 200 (bornage)', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['employees:read'] })
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'e1' }] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/employees?limit=9999&offset=-5', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(200)
    const call = queryMock.mock.calls.find(c => String(c[0]).includes('FROM "tenant_test".employees'))
    expect(call?.[1]).toEqual([200, 0]) // limit clampé à 200, offset à 0
  })
  it('GET /v1/payslips sans filtre mois → 200', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['payroll:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/payslips', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(200)
    const call = queryMock.mock.calls.find(c => String(c[0]).includes('pay_slips'))
    expect(String(call?.[0])).not.toContain('WHERE month')
  })
  it('GET /v1/payslips avec mois valide → filtre WHERE month', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['payroll:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/payslips?month=2024-07&limit=99999', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(200)
    const call = queryMock.mock.calls.find(c => String(c[0]).includes('pay_slips'))
    expect(String(call?.[0])).toContain('WHERE month')
    expect(call?.[1]).toEqual([500, '2024-07']) // limit clampé à 500
  })
  it('GET /v1/payslips mois mal formé → ignoré (pas de WHERE)', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['payroll:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/payslips?month=invalide', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(200)
    const call = queryMock.mock.calls.find(c => String(c[0]).includes('pay_slips'))
    expect(String(call?.[0])).not.toContain('WHERE month')
  })
  it('GET /v1/payslips sans scope payroll:read → 403', async () => {
    resolveMock.mockResolvedValue({ schemaName: 'tenant_test', tenantId: 't1', keyId: 'k1', scopes: ['employees:read'] })
    const r = await app.inject({ method: 'GET', url: '/integrations/v1/payslips', headers: { authorization: 'Bearer nxk_test.k' } })
    expect(r.statusCode).toBe(403)
  })
})

// ── Catalogues ──────────────────────────────────────────────────────────────
describe('Catalogues', () => {
  it('GET /events admin → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/integrations/events', headers: adminH() })
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(r.body).data)).toBe(true)
  })
  it('GET /scopes admin → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/integrations/scopes', headers: adminH() })
    expect(r.statusCode).toBe(200)
  })
  it('GET /events employee → 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/integrations/events', headers: { authorization: `Bearer ${tok('employee')}` } })).statusCode).toBe(403)
  })
})

// ── Webhooks ───────────────────────────────────────────────────────────────
describe('Webhooks — POST validations', () => {
  it('POST /webhooks corps invalide → 400 + issues', async () => {
    const r = await app.inject({ method: 'POST', url: '/integrations/webhooks', headers: adminH(), payload: { target_url: 'https://h.example.com', events: ['employee.created'] } })
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.body).issues).toBeDefined()
  })
  it('POST /webhooks URL refusée SSRF → 422', async () => {
    safeMock.mockResolvedValue({ ok: false, reason: 'IP privée' })
    const r = await app.inject({ method: 'POST', url: '/integrations/webhooks', headers: adminH(), payload: { name: 'x', target_url: 'http://10.0.0.1/', events: ['employee.created'] } })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).error).toContain('SSRF')
  })
})

describe('Webhooks — PATCH', () => {
  it('id invalide → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/integrations/webhooks/not-uuid', headers: adminH(), payload: { name: 'x' } })).statusCode).toBe(400)
  })
  it('corps invalide → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/integrations/webhooks/${UUID}`, headers: adminH(), payload: { unknown_field: 1 } })).statusCode).toBe(400)
  })
  it('aucun champ → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/integrations/webhooks/${UUID}`, headers: adminH(), payload: {} })).statusCode).toBe(400)
  })
  it('URL SSRF → 422', async () => {
    safeMock.mockResolvedValue({ ok: false, reason: 'interne' })
    expect((await app.inject({ method: 'PATCH', url: `/integrations/webhooks/${UUID}`, headers: adminH(), payload: { target_url: 'http://10.0.0.1/' } })).statusCode).toBe(422)
  })
  it('webhook introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE RETURNING vide
    expect((await app.inject({ method: 'PATCH', url: `/integrations/webhooks/${UUID}`, headers: adminH(), payload: { name: 'new' } })).statusCode).toBe(404)
  })
  it('mise à jour complète (tous champs) → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'PATCH', url: `/integrations/webhooks/${UUID}`, headers: adminH(),
      payload: { name: 'n', target_url: 'https://h.example.com', events: ['employee.updated'], headers: { A: 'b' }, is_active: false } })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).data).toMatchObject({ id: UUID, updated: true })
  })
})

describe('Webhooks — DELETE / test / deliveries', () => {
  it('DELETE id invalide → 400', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/integrations/webhooks/bad', headers: adminH() })).statusCode).toBe(400)
  })
  it('DELETE introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'DELETE', url: `/integrations/webhooks/${UUID}`, headers: adminH() })).statusCode).toBe(404)
  })
  it('DELETE existant → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'DELETE', url: `/integrations/webhooks/${UUID}`, headers: adminH() })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).data.deleted).toBe(true)
  })
  it('POST /test id invalide → 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/integrations/webhooks/bad/test', headers: adminH() })).statusCode).toBe(400)
  })
  it('POST /test introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT webhook vide
    expect((await app.inject({ method: 'POST', url: `/integrations/webhooks/${UUID}/test`, headers: adminH() })).statusCode).toBe(404)
  })
  it('POST /test existant → 200 + dernière livraison', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID, target_url: 'https://h.example.com', secret_enc: 'e', headers: {} }] }) // SELECT webhook
    queryMock.mockResolvedValueOnce({ rows: [{ status: 200, ok: true, response_excerpt: 'pong' }] }) // SELECT delivery
    const r = await app.inject({ method: 'POST', url: `/integrations/webhooks/${UUID}/test`, headers: adminH() })
    expect(r.statusCode).toBe(200)
    expect(deliverMock).toHaveBeenCalled()
    expect(JSON.parse(r.body).data).toMatchObject({ ok: true })
  })
  it('POST /test sans historique de livraison → fallback ok:false', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID, target_url: 'https://h.example.com', secret_enc: 'e', headers: {} }] })
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas de delivery
    const r = await app.inject({ method: 'POST', url: `/integrations/webhooks/${UUID}/test`, headers: adminH() })
    expect(JSON.parse(r.body).data).toEqual({ ok: false })
  })
  it('GET /deliveries id invalide → 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/integrations/webhooks/bad/deliveries', headers: adminH() })).statusCode).toBe(400)
  })
  it('GET /deliveries → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'd1', event: 'ping.test' }] })
    const r = await app.inject({ method: 'GET', url: `/integrations/webhooks/${UUID}/deliveries`, headers: adminH() })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).data.length).toBe(1)
  })
})

// ── Clés API ─────────────────────────────────────────────────────────────────
describe('Clés API', () => {
  it('GET /api-keys → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/integrations/api-keys', headers: adminH() })
    expect(r.statusCode).toBe(200)
  })
  it('POST /api-keys corps invalide → 400 + issues', async () => {
    const r = await app.inject({ method: 'POST', url: '/integrations/api-keys', headers: adminH(), payload: { name: 'x', scopes: ['scope.inexistant'] } })
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.body).issues).toBeDefined()
  })
  it('POST /api-keys avec expires_at → 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'POST', url: '/integrations/api-keys', headers: adminH(), payload: { name: 'PBI', scopes: ['employees:read'], expires_at: '2030-01-01T00:00:00.000Z' } })
    expect(r.statusCode).toBe(201)
    expect(JSON.parse(r.body).apiKey).toMatch(/^nxk_/)
  })
  it('PATCH /api-keys id invalide → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/integrations/api-keys/bad', headers: adminH(), payload: { name: 'x' } })).statusCode).toBe(400)
  })
  it('PATCH /api-keys corps invalide → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/integrations/api-keys/${UUID}`, headers: adminH(), payload: { bad: 1 } })).statusCode).toBe(400)
  })
  it('PATCH /api-keys aucun champ → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/integrations/api-keys/${UUID}`, headers: adminH(), payload: {} })).statusCode).toBe(400)
  })
  it('PATCH /api-keys introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'PATCH', url: `/integrations/api-keys/${UUID}`, headers: adminH(), payload: { is_active: false } })).statusCode).toBe(404)
  })
  it('PATCH /api-keys (révocation is_active=false) → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'PATCH', url: `/integrations/api-keys/${UUID}`, headers: adminH(), payload: { name: 'renommée', is_active: false } })
    expect(r.statusCode).toBe(200)
  })
  it('DELETE /api-keys id invalide → 400', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/integrations/api-keys/bad', headers: adminH() })).statusCode).toBe(400)
  })
  it('DELETE /api-keys introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'DELETE', url: `/integrations/api-keys/${UUID}`, headers: adminH() })).statusCode).toBe(404)
  })
  it('DELETE /api-keys existante → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    expect((await app.inject({ method: 'DELETE', url: `/integrations/api-keys/${UUID}`, headers: adminH() })).statusCode).toBe(200)
  })
})

// ── Connecteurs ──────────────────────────────────────────────────────────────
describe('Connecteurs', () => {
  it('GET /connectors → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/integrations/connectors', headers: adminH() })).statusCode).toBe(200)
  })
  it('POST /connectors corps invalide → 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/integrations/connectors', headers: adminH(), payload: { name: 'x' } })
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.body).issues).toBeDefined()
  })
  it('POST /connectors URL SSRF → 422', async () => {
    safeMock.mockResolvedValue({ ok: false, reason: 'interne' })
    expect((await app.inject({ method: 'POST', url: '/integrations/connectors', headers: adminH(), payload: { name: 'x', base_url: 'http://10.0.0.1/' } })).statusCode).toBe(422)
  })
  it('POST /connectors sans auth_secret (auth none par défaut) → 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'POST', url: '/integrations/connectors', headers: adminH(), payload: { name: 'API', base_url: 'https://api.example.com' } })
    expect(r.statusCode).toBe(201)
  })
  it('PATCH /connectors id invalide → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/integrations/connectors/bad', headers: adminH(), payload: { name: 'x' } })).statusCode).toBe(400)
  })
  it('PATCH /connectors corps invalide → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/integrations/connectors/${UUID}`, headers: adminH(), payload: { bad: 1 } })).statusCode).toBe(400)
  })
  it('PATCH /connectors aucun champ → 400', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/integrations/connectors/${UUID}`, headers: adminH(), payload: {} })).statusCode).toBe(400)
  })
  it('PATCH /connectors URL SSRF → 422', async () => {
    safeMock.mockResolvedValue({ ok: false, reason: 'interne' })
    expect((await app.inject({ method: 'PATCH', url: `/integrations/connectors/${UUID}`, headers: adminH(), payload: { base_url: 'http://10.0.0.1/' } })).statusCode).toBe(422)
  })
  it('PATCH /connectors introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'PATCH', url: `/integrations/connectors/${UUID}`, headers: adminH(), payload: { name: 'n' } })).statusCode).toBe(404)
  })
  it('PATCH /connectors tous champs (avec auth_secret) → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'PATCH', url: `/integrations/connectors/${UUID}`, headers: adminH(),
      payload: { name: 'n', base_url: 'https://api.example.com', auth_type: 'bearer', auth_secret: 'tok', auth_header_name: 'X-K', default_headers: { A: 'b' }, is_active: true } })
    expect(r.statusCode).toBe(200)
  })
  it('PATCH /connectors auth_secret vide (efface le secret) → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    const r = await app.inject({ method: 'PATCH', url: `/integrations/connectors/${UUID}`, headers: adminH(), payload: { auth_secret: '' } })
    expect(r.statusCode).toBe(200)
  })
  it('DELETE /connectors id invalide → 400', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/integrations/connectors/bad', headers: adminH() })).statusCode).toBe(400)
  })
  it('DELETE /connectors introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'DELETE', url: `/integrations/connectors/${UUID}`, headers: adminH() })).statusCode).toBe(404)
  })
  it('DELETE /connectors existant → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID }] })
    expect((await app.inject({ method: 'DELETE', url: `/integrations/connectors/${UUID}`, headers: adminH() })).statusCode).toBe(200)
  })
  it('POST /connectors/:id/test id invalide → 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/integrations/connectors/bad/test', headers: adminH() })).statusCode).toBe(400)
  })
  it('POST /connectors/:id/test introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect((await app.inject({ method: 'POST', url: `/integrations/connectors/${UUID}/test`, headers: adminH() })).statusCode).toBe(404)
  })
  it('POST /connectors/:id/test existant → 200 + résultat', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ base_url: 'https://api.example.com', auth_type: 'bearer', auth_secret_enc: null, auth_header_name: null, default_headers: {} }] })
    const r = await app.inject({ method: 'POST', url: `/integrations/connectors/${UUID}/test`, headers: adminH() })
    expect(r.statusCode).toBe(200)
    expect(testConnectorMock).toHaveBeenCalled()
    expect(JSON.parse(r.body).data).toMatchObject({ ok: true, status: 200 })
  })
})
