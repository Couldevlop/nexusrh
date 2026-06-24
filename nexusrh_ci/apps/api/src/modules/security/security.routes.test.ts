import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../utils/crypto.js', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decryptIfPresent: (s: string | null | undefined) => (s ? s.replace(/^enc\(|\)$/g, '') : null),
}))
// Évite toute résolution DNS réelle (le vrai guard fait un lookup).
vi.mock('../../services/ssrf-guard.js', () => ({
  assertSafeOutboundUrl: vi.fn(async (raw: string) => new URL(raw)),
  SsrfBlockedError: class extends Error {},
}))

import authPlugin from '../../plugins/auth.js'
import securityRoutes from './security.routes.js'

const SCHEMA = 'tenant_sotra'
function token(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

let app: FastifyInstance
const fetchMock = vi.fn()
beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock)
  app = Fastify()
  await app.register(authPlugin)
  await app.register(securityRoutes, { prefix: '/security' })
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllGlobals() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }); fetchMock.mockReset() })

describe('OWASP A01 — réservé admin du tenant', () => {
  it('hr_manager ne peut pas lire la config SSO (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/security/sso-config', headers: { authorization: `Bearer ${token(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('admin lit la config SSO (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/security/sso-config', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
  })
})

describe('OWASP A02 — secrets jamais renvoyés en clair', () => {
  it('GET /sso-config expose secretSet mais pas le secret', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, provider: 'oidc', client_id: 'cid', client_secret_enc: 'enc(shh)', domains: ['sotra.ci'], default_role: 'employee', group_mappings: [] }] })
    const res = await app.inject({ method: 'GET', url: '/security/sso-config', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    const body = JSON.parse(res.body) as { data: Record<string, unknown> }
    expect(body.data.secretSet).toBe(true)
    expect(body.data).not.toHaveProperty('client_secret_enc')
    expect(JSON.stringify(body.data)).not.toContain('shh')
    // Réponse en camelCase cohérente (sinon le front plantait sur la config par défaut)
    expect(body.data).toHaveProperty('defaultRole', 'employee')
    expect(body.data).toHaveProperty('clientId', 'cid')
    expect(body.data).toHaveProperty('groupMappings')
    expect(body.data).not.toHaveProperty('default_role')
    expect(body.data).not.toHaveProperty('group_mappings')
    expect(body.data).not.toHaveProperty('id') // pas de colonnes DB brutes exposées
  })
})

describe('OWASP A03 — validation bornée', () => {
  it('PUT /sso-config rejette un provider inconnu (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/security/sso-config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, provider: 'telnet', defaultRole: 'employee' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('PUT /sso-config valide → upsert + audit (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) // upsert + audit
    const res = await app.inject({
      method: 'PUT', url: '/security/sso-config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'shh', domains: ['SOTRA.CI'], defaultRole: 'employee', jitProvisioning: true, groupMappings: [{ group: 'RH', role: 'hr_manager' }] },
    })
    expect(res.statusCode).toBe(200)
    const upsert = queryMock.mock.calls.find((c) => String(c[0]).includes('sso_config'))
    expect(upsert?.[1]).toContain('enc(shh)')        // secret chiffré
    expect(upsert?.[1]?.find((p: unknown) => Array.isArray(p) && (p as string[]).includes('sotra.ci'))).toBeTruthy() // domaine normalisé
  })
  it('PUT /siem-config rejette un format inconnu (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/security/siem-config',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
      payload: { enabled: true, transport: 'webhook', format: 'xml' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('SIEM — test & forward (A10 SSRF + A09 audit)', () => {
  it('test sans collecteur configuré → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, endpoint: null }] })
    const res = await app.inject({ method: 'POST', url: '/security/siem-config/test', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
  it('test envoie un événement signé et renvoie le statut HTTP', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, transport: 'webhook', endpoint: 'https://siem.example.com/in', format: 'json', secret_enc: 'enc(k)', categories: ['auth'] }] })
    fetchMock.mockResolvedValueOnce({ status: 202 })
    const res = await app.inject({ method: 'POST', url: '/security/siem-config/test', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ ok: true, status: 202 })
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers['X-NexusRH-Signature']).toMatch(/^sha256=/)
  })
  it('forward désactivé → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, enabled: false, endpoint: 'https://siem.example.com/in' }] })
    const res = await app.inject({ method: 'POST', url: '/security/siem/forward', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
})

describe('Événements de sécurité (audit annoté)', () => {
  it('GET /events annote catégorie + indicateur de transmission SIEM', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ enabled: true, categories: ['auth'] }] }) // siem_config
      .mockResolvedValueOnce({ rows: [
        { id: 'e1', action: 'auth.login_failed', entity: 'user', user_id: 'u1', ip_address: '1.2.3.4', created_at: new Date('2024-12-01') },
        { id: 'e2', action: 'tenant.modules_updated', entity: 'tenant', user_id: 'u2', ip_address: null, created_at: new Date('2024-12-02') },
      ] })
    const res = await app.inject({ method: 'GET', url: '/security/events', headers: { authorization: `Bearer ${token(app, 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: Array<{ category: string; forwarded: boolean }> }
    expect(body.data[0]).toMatchObject({ category: 'auth', forwarded: true })
    expect(body.data[1]).toMatchObject({ category: 'config', forwarded: false })
  })
})
