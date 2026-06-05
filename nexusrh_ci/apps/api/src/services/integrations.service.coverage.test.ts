/**
 * Service Connectivité — couverture exhaustive : livraison webhook (succès,
 * échec HTTP, retry/exception, signature HMAC, en-têtes), émission d'événements
 * (best-effort non bloquant), test de connecteur (auth bearer/basic/api_key,
 * SSRF bloqué, erreur réseau), résolution de clé API (statut, schéma, expiration).
 *
 * Tous les appels réseau sont mockés : globalThis.fetch + ssrf-guard + dns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { assertMock } = vi.hoisted(() => ({ assertMock: vi.fn() }))
vi.mock('./ssrf-guard.js', () => ({
  assertSafeOutboundUrl: assertMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))
vi.mock('../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() })) }))
vi.mock('../config.js', () => ({ config: { database: { url: 'postgresql://test' } } }))

import {
  deliverWebhook, emitIntegrationEvent, testConnector, resolveApiKey, signPayload,
} from './integrations.service.js'
import { createHmac } from 'crypto'

const fetchSpy = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  assertMock.mockResolvedValue(new URL('https://ok.example.com'))
  fetchSpy.mockReset()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
})
afterEach(() => { vi.useRealTimers() })

function fakeRes(status: number, text = 'ok') {
  return { status, text: vi.fn().mockResolvedValue(text) }
}
function poolStub() {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  return { pool: { query } as never, query }
}

describe('deliverWebhook', () => {
  const wh = { id: 'w1', target_url: 'https://hook.example.com/x', secret_enc: 'enc', headers: { 'X-Custom': 'v' } }
  const dec = (_e: string): string => 'topsecret'

  it('livraison réussie (2xx) : journalise ok=true + signe en HMAC', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200, 'pong'))
    const { pool, query } = poolStub()
    await deliverWebhook(pool, 'tenant_test', wh, 'employee.created', { a: 1 }, dec)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe(wh.target_url)
    expect(opts.method).toBe('POST')
    expect(opts.redirect).toBe('error')
    // En-têtes NexusRH non écrasables + en-tête custom présent
    expect(opts.headers['X-Custom']).toBe('v')
    expect(opts.headers['X-NexusRH-Event']).toBe('employee.created')
    // Signature HMAC = sha256 du corps avec le secret déchiffré
    const body = opts.body as string
    expect(opts.headers['X-NexusRH-Signature']).toBe(`sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`)
    // INSERT delivery + UPDATE webhook
    const insert = query.mock.calls.find(c => String(c[0]).includes('webhook_deliveries'))
    expect(insert?.[1]).toEqual(['w1', 'employee.created', 200, true, 2, 'pong'])
    expect(query.mock.calls.some(c => String(c[0]).includes('integration_webhooks SET last_delivery_at'))).toBe(true)
  })

  it('échec HTTP 500 : retry jusqu\'à maxAttempts (2 fetch) puis ok=false', async () => {
    fetchSpy.mockResolvedValue(fakeRes(500, 'boom'))
    const { pool, query } = poolStub()
    await deliverWebhook(pool, 'tenant_test', wh, 'absence.approved', {}, dec)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const insert = query.mock.calls.find(c => String(c[0]).includes('webhook_deliveries'))
    expect(insert?.[1]).toMatchObject({ 2: 500, 3: false })
  })

  it('exception fetch : capture le message, ok=false, status null', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED tunnel'))
    const { pool, query } = poolStub()
    await deliverWebhook(pool, 'tenant_test', wh, 'employee.created', {}, dec)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const insert = query.mock.calls.find(c => String(c[0]).includes('webhook_deliveries'))
    expect(insert?.[1][2]).toBeNull()      // status
    expect(insert?.[1][3]).toBe(false)     // ok
    expect(String(insert?.[1][5])).toContain('ECONNREFUSED')
  })

  it('SSRF bloqué : assertSafeOutboundUrl lève → aucun fetch, ok=false', async () => {
    assertMock.mockRejectedValue(new Error('Adresse IP privée'))
    const { pool, query } = poolStub()
    await deliverWebhook(pool, 'tenant_test', wh, 'employee.created', {}, dec)
    expect(fetchSpy).not.toHaveBeenCalled()
    const insert = query.mock.calls.find(c => String(c[0]).includes('webhook_deliveries'))
    expect(insert?.[1][3]).toBe(false)
  })

  it('secret indéchiffrable (null) : signe avec secret vide sans planter', async () => {
    fetchSpy.mockResolvedValue(fakeRes(204, ''))
    const { pool } = poolStub()
    await deliverWebhook(pool, 'tenant_test', wh, 'employee.created', {}, () => null)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(opts.headers['X-NexusRH-Signature']).toBe(`sha256=${signPayload('', opts.body)}`)
  })

  it('webhook sans en-têtes custom (null) : ne plante pas', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200))
    const { pool } = poolStub()
    await deliverWebhook(pool, 'tenant_test', { ...wh, headers: null }, 'employee.created', {}, dec)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Content-Type']).toBe('application/json')
  })
})

describe('emitIntegrationEvent (best-effort, non bloquant)', () => {
  it('schéma invalide : sort silencieusement sans requête', () => {
    const { pool, query } = poolStub()
    emitIntegrationEvent(pool, 'public; DROP', 'employee.created', {}, () => 's')
    expect(query).not.toHaveBeenCalled()
  })

  it('diffuse vers chaque webhook abonné (fire-and-forget)', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200))
    const query = vi.fn()
    query.mockResolvedValueOnce({ rows: [
      { id: 'w1', target_url: 'https://a.example.com', secret_enc: 'e1', headers: null },
      { id: 'w2', target_url: 'https://b.example.com', secret_enc: 'e2', headers: null },
    ] })
    query.mockResolvedValue({ rows: [] })
    emitIntegrationEvent({ query } as never, 'tenant_test', 'employee.created', { x: 1 }, () => 's')
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('erreur de requête SELECT : avalée (jamais bloquant)', async () => {
    const query = vi.fn().mockRejectedValue(new Error('db down'))
    expect(() => emitIntegrationEvent({ query } as never, 'tenant_test', 'employee.created', {}, () => 's')).not.toThrow()
    await new Promise(r => setImmediate(r))
  })

  it('pool.query qui jette de façon synchrone : try/catch synchrone', () => {
    const query = vi.fn(() => { throw new Error('sync throw') })
    expect(() => emitIntegrationEvent({ query } as never, 'tenant_test', 'employee.created', {}, () => 's')).not.toThrow()
  })

  it('résultat sans rows : ne livre rien', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    emitIntegrationEvent({ query } as never, 'tenant_test', 'employee.created', {}, () => 's')
    await new Promise(r => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('testConnector', () => {
  it('auth bearer : ajoute Authorization Bearer, retourne ok si < 500', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200))
    const res = await testConnector('https://api.example.com', 'bearer', 'tok123', null, { 'X-H': '1' })
    expect(res).toEqual({ ok: true, status: 200, message: 'HTTP 200' })
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBe('Bearer tok123')
    expect(opts.headers['X-H']).toBe('1')
  })
  it('auth basic : encode en base64', async () => {
    fetchSpy.mockResolvedValue(fakeRes(401))
    const res = await testConnector('https://api.example.com', 'basic', 'user:pass', null, null)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`)
    expect(res.ok).toBe(true) // 401 < 500
  })
  it('auth api_key avec en-tête personnalisé', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200))
    await testConnector('https://api.example.com', 'api_key', 'secret', 'X-Token', null)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['X-Token']).toBe('secret')
  })
  it('auth api_key sans nom d\'en-tête : défaut X-API-Key', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200))
    await testConnector('https://api.example.com', 'api_key', 'secret', null, null)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['X-API-Key']).toBe('secret')
  })
  it('auth none : aucun en-tête d\'autorisation', async () => {
    fetchSpy.mockResolvedValue(fakeRes(200))
    await testConnector('https://api.example.com', 'none', null, null, null)
    const [, opts] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(opts.headers['Authorization']).toBeUndefined()
  })
  it('réponse 503 : ok=false (>= 500)', async () => {
    fetchSpy.mockResolvedValue(fakeRes(503))
    expect((await testConnector('https://api.example.com', 'none', null, null, null)).ok).toBe(false)
  })
  it('SSRF bloqué : retourne message d\'erreur sans fetch', async () => {
    assertMock.mockRejectedValue(new Error('Hôte interne interdit'))
    const res = await testConnector('http://169.254.169.254', 'none', null, null, null)
    expect(res).toEqual({ ok: false, status: null, message: 'Hôte interne interdit' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('erreur réseau : ok=false, status null, message tronqué', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'))
    const res = await testConnector('https://api.example.com', 'none', null, null, null)
    expect(res).toMatchObject({ ok: false, status: null, message: 'timeout' })
  })
})

describe('resolveApiKey — branches restantes', () => {
  function poolWith(...impls: Array<{ rows: unknown[] }>) {
    const q = vi.fn()
    for (const r of impls) q.mockResolvedValueOnce(r)
    q.mockResolvedValue({ rows: [] })
    return { query: q } as never
  }
  it('clé sans point → null', async () => {
    expect(await resolveApiKey(poolWith(), 'nxk_acme')).toBeNull()
  })
  it('slug invalide (caractères interdits) → null', async () => {
    expect(await resolveApiKey(poolWith(), 'nxk_AC ME.abc')).toBeNull()
  })
  it('tenant suspendu → null', async () => {
    expect(await resolveApiKey(poolWith({ rows: [{ id: 't1', schema_name: 'tenant_acme', status: 'suspended' }] }), 'nxk_acme.abc')).toBeNull()
  })
  it('schema_name invalide → null', async () => {
    expect(await resolveApiKey(poolWith({ rows: [{ id: 't1', schema_name: 'bad schema!', status: 'active' }] }), 'nxk_acme.abc')).toBeNull()
  })
  it('statut trial accepté + scopes null → tableau vide', async () => {
    const ctx = await resolveApiKey(
      poolWith(
        { rows: [{ id: 't1', schema_name: 'tenant_acme', status: 'trial' }] },
        { rows: [{ id: 'k1', scopes: null }] },
      ), 'nxk_acme.abc')
    expect(ctx).toMatchObject({ keyId: 'k1', scopes: [] })
  })
  it('exception DB → null (ne lève jamais)', async () => {
    const q = vi.fn().mockRejectedValue(new Error('db error'))
    expect(await resolveApiKey({ query: q } as never, 'nxk_acme.abc')).toBeNull()
  })
})
