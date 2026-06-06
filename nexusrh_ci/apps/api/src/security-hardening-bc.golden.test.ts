/**
 * Golden test — durcissements sécurité (lots B + C).
 *
 * B (OWASP A09 + A01) — PATCH /settings/users/:id :
 *   - refuse l'attribution du rôle 'super_admin' (anti-escalade plateforme)
 *   - trace audit_log 'user.role_changed' sur changement de rôle
 *
 * C1 (OWASP A04 idempotence) — POST /payroll/periods/:month/close :
 *   - refuse (409) une 2ᵉ initiation si la période est déjà pending_validation
 *
 * C2 (OWASP A07) — MFA obligatoire super_admin :
 *   - un token "mfaPending" (super_admin sans MFA) est bloqué (403) hors du
 *     parcours d'activation MFA, mais autorisé sur /auth/me et /auth/mfa/*
 *
 * Isolation : pg routé par SQL, redis/config/migrations mockés.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
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
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))
vi.mock('./utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from './plugins/auth.js'
import settingsRoutes from './modules/settings/settings.routes.js'
import payrollRoutes from './modules/payroll/payroll.routes.js'

const SCHEMA = 'tenant_sotra'
const USER_ID = '22222222-2222-2222-2222-222222222222'

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.register(payrollRoutes,  { prefix: '/payroll' })
  // Routes factices pour valider le gating mfaPending du plugin auth.
  app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }))
  app.get('/auth/me',   { preHandler: [app.authenticate] }, async () => ({ ok: true }))
  app.get('/auth/mfa/setup', { preHandler: [app.authenticate] }, async () => ({ ok: true }))
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

function token(role: string, opts: Partial<{ schemaName: string; mfaPending: boolean }> = {}) {
  return app.jwt.sign({
    sub: `u-${role}`, tenantId: 't1', schemaName: opts.schemaName ?? SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
    ...(opts.mfaPending ? { mfaPending: true } : {}),
  })
}

// ════════════════════════════════════════════════════════════════════════════════
describe('B — PATCH /settings/users/:id (anti-escalade + audit A09)', () => {
  it('refuse role=super_admin (400, anti-escalade plateforme)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${USER_ID}`,
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { role: 'super_admin' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Rôle invalide')
  })

  it('changement de rôle valide → 200 + audit user.role_changed', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.audit_log')) return { rows: [] }
      if (/^\s*UPDATE/i.test(q) && q.includes('.users')) return { rows: [{ id: USER_ID, email: 'x@sotra.ci', role: 'hr_manager', is_active: true }] }
      if (q.includes('SELECT role, is_active')) return { rows: [{ role: 'employee', is_active: true }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'PATCH', url: `/settings/users/${USER_ID}`,
      headers: { authorization: `Bearer ${token('admin')}` },
      payload: { role: 'hr_manager' },
    })
    expect(res.statusCode).toBe(200)
    const audit = queryMock.mock.calls.find(
      (c) => String(c[0]).includes('.audit_log') && (c[1] as unknown[])?.[1] === 'user.role_changed',
    )
    expect(audit, 'audit_log user.role_changed attendu').toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('C1 — Idempotence clôture paie', () => {
  it('refuse une 2ᵉ initiation si déjà pending_validation (409)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [{ id: 't', has_subsidiaries: false, at_rate: '0.020', default_country_code: 'CIV' }] }
      if (q.includes('.pay_periods')) return { rows: [{ id: 'period-1', status: 'pending_validation' }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/periods/2024-12/close',
      headers: { authorization: `Bearer ${token('hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà initiée')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('C2 — MFA obligatoire super_admin (token mfaPending)', () => {
  it('token mfaPending BLOQUÉ (403) sur une route normale', async () => {
    const res = await app.inject({
      method: 'GET', url: '/protected',
      headers: { authorization: `Bearer ${token('super_admin', { schemaName: 'platform', mfaPending: true })}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('MFA obligatoire')
  })

  it('token mfaPending AUTORISÉ sur /auth/me et /auth/mfa/*', async () => {
    const t = token('super_admin', { schemaName: 'platform', mfaPending: true })
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${t}` } })
    expect(me.statusCode).toBe(200)
    const mfa = await app.inject({ method: 'GET', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${t}` } })
    expect(mfa.statusCode).toBe(200)
  })

  it('un super_admin AVEC MFA (token normal) n\'est pas bloqué', async () => {
    const res = await app.inject({
      method: 'GET', url: '/protected',
      headers: { authorization: `Bearer ${token('super_admin', { schemaName: 'platform' })}` },
    })
    expect(res.statusCode).toBe(200)
  })
})
