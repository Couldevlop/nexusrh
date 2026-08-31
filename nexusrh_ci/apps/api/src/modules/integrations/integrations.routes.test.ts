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
vi.mock('@nexusrhci/shared/ssrf-guard', () => ({
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

// ── A09-3 (audit OWASP 2026-07-18) ───────────────────────────────────────────
// Les en-têtes de webhook portent typiquement `Authorization: Bearer <token>`
// du système destinataire. Ils doivent être chiffrés au repos, absents des
// réponses API, et réduits aux noms de clés dans l'audit.
describe('A09-3 — en-têtes de webhook : chiffrés au repos, jamais exposés', () => {
  const SECRET_HEADERS = { Authorization: 'Bearer super-token-destinataire', 'X-Tenant': 'acme' }

  it('POST /webhooks : headers chiffrés dans headers_enc, jamais en clair en base', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'w1' }] })
    const r = await app.inject({ method: 'POST', url: '/integrations/webhooks',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { name: 'Slack', target_url: 'https://hooks.example.com/x', events: ['employee.created'], headers: SECRET_HEADERS } })
    expect(r.statusCode).toBe(201)

    const insert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('integration_webhooks'))
    expect(insert).toBeDefined()
    expect(String(insert![0])).toContain('headers_enc')
    // Le secret ne doit apparaître dans AUCUN paramètre de la requête SQL.
    const serialized = JSON.stringify(insert![1])
    expect(serialized).not.toContain('super-token-destinataire')
    expect(serialized).not.toContain('Bearer')
    // …et la valeur stockée doit être un cryptogramme AES-GCM (iv:tag:données).
    const encParam = (insert![1] as unknown[]).find(v => typeof v === 'string' && /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(v))
    expect(encParam).toBeDefined()
  })

  it('POST /webhooks : l\'audit ne consigne que les NOMS de clés d\'en-têtes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'w1' }] })
    await app.inject({ method: 'POST', url: '/integrations/webhooks',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { name: 'Slack', target_url: 'https://hooks.example.com/x', events: ['employee.created'], headers: SECRET_HEADERS } })
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(audit).toBeDefined()
    const changes = JSON.stringify(audit![1])
    expect(changes).not.toContain('super-token-destinataire')
    expect(changes).toContain('header_keys')
    expect(changes).toContain('Authorization') // le NOM reste tracé
  })

  it('PATCH /webhooks/:id : headers chiffrés + audit réduit aux noms de clés', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: '11111111-1111-1111-1111-111111111111' }] }) // UPDATE RETURNING
    const r = await app.inject({ method: 'PATCH', url: '/integrations/webhooks/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${tok('admin')}` },
      payload: { headers: SECRET_HEADERS } })
    expect(r.statusCode).toBe(200)

    const update = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE') && String(c[0]).includes('integration_webhooks'))
    expect(String(update![0])).toContain('headers_enc')
    // La colonne héritée en clair est purgée par la même requête.
    expect(String(update![0])).toContain(`headers = '{}'::jsonb`)
    expect(JSON.stringify(update![1])).not.toContain('super-token-destinataire')

    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    const changes = JSON.stringify(audit![1])
    expect(changes).not.toContain('super-token-destinataire')
    expect(changes).toContain('header_keys')
  })

  it('GET /webhooks : renvoie header_keys, jamais les valeurs', async () => {
    // Ligne « moderne » (chiffrée) + ligne héritée (clair, pré-migration).
    const { encrypt } = await import('@nexusrhci/shared/crypto')
    queryMock.mockResolvedValueOnce({ rows: [
      { id: 'w1', name: 'Moderne', target_url: 'https://a.example.com', events: [], is_active: true,
        headers: null, headers_enc: encrypt(JSON.stringify(SECRET_HEADERS)),
        last_delivery_at: null, last_status: null, created_at: new Date() },
      { id: 'w2', name: 'Hérité', target_url: 'https://b.example.com', events: [], is_active: true,
        headers: { 'X-Legacy-Key': 'valeur-heritee-en-clair' }, headers_enc: null,
        last_delivery_at: null, last_status: null, created_at: new Date() },
    ] })
    const r = await app.inject({ method: 'GET', url: '/integrations/webhooks',
      headers: { authorization: `Bearer ${tok('admin')}` } })
    expect(r.statusCode).toBe(200)
    const body = r.body
    expect(body).not.toContain('super-token-destinataire')
    expect(body).not.toContain('valeur-heritee-en-clair')

    const rows = JSON.parse(body).data as Array<{ header_keys: string[]; headers?: unknown; headers_enc?: unknown }>
    expect(rows[0]!.header_keys).toEqual(['Authorization', 'X-Tenant'])
    expect(rows[1]!.header_keys).toEqual(['X-Legacy-Key']) // rétro-compatibilité
    // Ni la valeur chiffrée ni l'ancien clair ne sortent de l'API.
    expect(rows[0]).not.toHaveProperty('headers')
    expect(rows[0]).not.toHaveProperty('headers_enc')
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
