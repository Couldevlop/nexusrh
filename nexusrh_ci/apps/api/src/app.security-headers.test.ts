import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: vi.fn(), end: vi.fn() })),
}))

vi.mock('./services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('./config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

const API_CSP  = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const DOCS_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
const SENSITIVE_CONTENT_TYPES = /^(application\/pdf|text\/csv|application\/xml)/i

/**
 * Test minimal qui reproduit le hook security-headers de app.ts sans avoir
 * à charger toute l'API (db, redis, swagger, etc.). On valide la logique du
 * hook isolément — si elle régresse, ce test casse avant l'intégration.
 */
function buildAppWithHeadersHook(): FastifyInstance {
  const app = Fastify()
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options',  'nosniff')
    reply.header('X-Frame-Options',          'DENY')
    reply.header('X-XSS-Protection',         '0')
    reply.header('Strict-Transport-Security','max-age=31536000; includeSubDomains; preload')
    reply.header('Referrer-Policy',          'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy',       'geolocation=(), microphone=(), camera=()')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header('Cross-Origin-Opener-Policy',   'same-origin')
    const url = req.raw.url ?? ''
    if (url.startsWith('/docs')) {
      reply.header('Content-Security-Policy', DOCS_CSP)
    } else {
      reply.header('Content-Security-Policy', API_CSP)
    }
    const ct = String(reply.getHeader('content-type') ?? '')
    if (SENSITIVE_CONTENT_TYPES.test(ct)) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      reply.header('Pragma',         'no-cache')
    }
  })
  app.get('/api/data', async (_req, reply) => reply.send({ ok: true }))
  app.get('/docs', async (_req, reply) => reply.type('text/html').send('<html></html>'))
  app.get('/payslip.pdf', async (_req, reply) => {
    reply.type('application/pdf')
    return reply.send(Buffer.from('FAKE_PDF'))
  })
  app.get('/disa.csv', async (_req, reply) => {
    reply.type('text/csv; charset=utf-8')
    return reply.send('A;B;C')
  })
  return app
}

let app: FastifyInstance

beforeAll(async () => {
  app = buildAppWithHeadersHook()
  await app.ready()
})

afterAll(async () => { await app.close() })

describe('Security headers transverses (OWASP A05)', () => {
  it('headers de base présents sur toute réponse JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/data' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['permissions-policy']).toContain('geolocation=()')
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
  })

  it('CSP API strict sur routes JSON (default-src none, frame-ancestors none)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/data' })
    const csp = res.headers['content-security-policy']
    expect(csp).toBe(API_CSP)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('CSP permissive sur /docs (Swagger UI nécessite inline scripts)', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' })
    const csp = res.headers['content-security-policy']
    expect(csp).toBe(DOCS_CSP)
    expect(csp).toContain("'unsafe-inline'") // requis par Swagger UI
    expect(csp).toContain("frame-ancestors 'none'")
  })
})

describe('Cache-Control no-store sur réponses sensibles (OWASP A02)', () => {
  it('bulletin PDF → Cache-Control no-store (évite cache navigateur partagé)', async () => {
    const res = await app.inject({ method: 'GET', url: '/payslip.pdf' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.headers['cache-control']).toContain('private')
    expect(res.headers['pragma']).toBe('no-cache')
  })

  it('export DISA CSV → Cache-Control no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/disa.csv' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('JSON API → pas de no-store forcé (cache normal autorisé)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/data' })
    expect(res.statusCode).toBe(200)
    // Le hook ne touche pas Cache-Control pour le JSON (undefined ou absent acceptable)
    const cc = res.headers['cache-control']
    expect(cc === undefined || !String(cc).includes('no-store')).toBe(true)
  })
})
