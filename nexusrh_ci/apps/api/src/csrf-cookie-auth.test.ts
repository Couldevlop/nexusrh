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

import authPlugin, { AUTH_COOKIE_NAME } from './plugins/auth.js'

/**
 * Tests des 2 nouvelles features auth :
 *   1. JWT lu depuis cookie httpOnly (alternative à Authorization: Bearer)
 *   2. CSRF guard sur mutations cookie-based (refuse si pas de X-CSRF-Token)
 *
 * On reproduit ici la config app.ts minimale (cookie + jwt + CSRF hook)
 * pour tester isolément sans charger tout l'API.
 */

let app: FastifyInstance

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify()
  await a.register(authPlugin)

  // CSRF hook : copie minimale de app.ts
  a.addHook('preHandler', async (request, reply) => {
    const method = request.method.toUpperCase()
    if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE') return
    const url = request.url
    if (url.startsWith('/auth/') || url.startsWith('/mobile-money/webhooks/')) return

    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies ?? {}
    const hasCookie = !!cookies[AUTH_COOKIE_NAME]
    const hasBearer = String(request.headers.authorization ?? '').toLowerCase().startsWith('bearer ')
    if (!hasCookie || hasBearer) return

    const csrfHeader = String(request.headers['x-csrf-token'] ?? '').trim()
    if (!csrfHeader) {
      return reply.status(403).send({ error: 'CSRF token requis (X-CSRF-Token)' })
    }
    try {
      const decoded = a.jwt.verify<{ sub: string; aud?: string }>(csrfHeader)
      if (decoded.aud !== 'csrf') {
        return reply.status(403).send({ error: 'CSRF token invalide (audience)' })
      }
      const jwtPayload = a.jwt.decode<{ sub: string }>(cookies[AUTH_COOKIE_NAME] ?? '')
      if (!jwtPayload || jwtPayload.sub !== decoded.sub) {
        return reply.status(403).send({ error: 'CSRF token / session mismatch' })
      }
    } catch {
      return reply.status(403).send({ error: 'CSRF token invalide' })
    }
  })

  a.get('/protected', { preHandler: [a.authenticate] }, async (req) => ({ user: req.user }))
  a.post('/mutation', { preHandler: [a.authenticate] }, async () => ({ ok: true }))
  return a
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => { await app.close() })

describe('JWT depuis cookie httpOnly (OWASP A02)', () => {
  it('GET protégé OK avec JWT en cookie (au lieu de header)', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const res = await app.inject({
      method: 'GET', url: '/protected',
      cookies: { [AUTH_COOKIE_NAME]: token },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).user.role).toBe('admin')
  })

  it('GET protégé OK avec Authorization: Bearer (backward-compat)', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const res = await app.inject({
      method: 'GET', url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('GET protégé refuse sans token (ni cookie ni header) — 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
  })
})

describe('CSRF guard sur mutations (OWASP A01)', () => {
  it('POST avec cookie SANS X-CSRF-Token → 403', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const res = await app.inject({
      method: 'POST', url: '/mutation',
      cookies: { [AUTH_COOKIE_NAME]: token },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('CSRF')
  })

  it('POST avec cookie + bon CSRF token → 200', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const csrf = app.jwt.sign(
      { sub: 'u1', aud: 'csrf' } as unknown as Parameters<typeof app.jwt.sign>[0],
      { expiresIn: '1h' },
    )
    const res = await app.inject({
      method: 'POST', url: '/mutation',
      cookies: { [AUTH_COOKIE_NAME]: token },
      headers: { 'x-csrf-token': csrf },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('POST avec cookie + CSRF token mauvais sub → 403 (anti-token-replay cross-user)', async () => {
    const tokenForA = app.jwt.sign({
      sub: 'userA', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    // CSRF émis pour userB → ne doit PAS pouvoir authentifier userA
    const csrfForB = app.jwt.sign(
      { sub: 'userB', aud: 'csrf' } as unknown as Parameters<typeof app.jwt.sign>[0],
      { expiresIn: '1h' },
    )
    const res = await app.inject({
      method: 'POST', url: '/mutation',
      cookies: { [AUTH_COOKIE_NAME]: tokenForA },
      headers: { 'x-csrf-token': csrfForB },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('mismatch')
  })

  it('POST avec cookie + CSRF token sans aud=csrf → 403', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    // Token JWT régulier réutilisé comme CSRF (pas de aud='csrf')
    const res = await app.inject({
      method: 'POST', url: '/mutation',
      cookies: { [AUTH_COOKIE_NAME]: token },
      headers: { 'x-csrf-token': token },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('audience')
  })

  it('POST avec Authorization: Bearer (PAS de cookie) → pas de CSRF requis (API client)', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const res = await app.inject({
      method: 'POST', url: '/mutation',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('GET avec cookie sans CSRF → OK (lecture, pas de CSRF requis)', async () => {
    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const res = await app.inject({
      method: 'GET', url: '/protected',
      cookies: { [AUTH_COOKIE_NAME]: token },
    })
    expect(res.statusCode).toBe(200)
  })
})
