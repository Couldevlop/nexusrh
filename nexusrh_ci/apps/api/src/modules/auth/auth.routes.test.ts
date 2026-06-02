import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:      vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe:  vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted:  vi.fn().mockResolvedValue(false),
  redisLockoutStore:   {},  // store de verrouillage (fail-open : {}.get indéfini → non bloquant)
}))

// auth-mfa.routes.ts (importé indirectement via buildMfaChallenge) tire
// services/email.ts qui exige config.smtp — mock pour éviter le crash.
vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:    vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:      vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:      vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail:  vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

// Neutralise l'appel réseau HaveIBeenPwned dans les tests (non bloquant = null).
// La logique de fuite est couverte à 100% par breach-check.service.test.ts.
vi.mock('../../services/breach-check.service.js', () => ({
  isPasswordBreached: vi.fn().mockResolvedValue(null),
}))

import authPlugin from '../../plugins/auth.js'
import authRoutes from './auth.routes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('POST /auth/login — Zod stricte (OWASP A03)', () => {
  it('refuse body sans email (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'secret' } })
    expect(res.statusCode).toBe(400)
  })

  it('refuse email mal formé (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'not-an-email', password: 'secret' } })
    expect(res.statusCode).toBe(400)
  })

  it('refuse champs inconnus (.strict)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@b.com', password: 'secret', isAdmin: true },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /auth/login — credential check (OWASP A02 + A09)', () => {
  it('email inconnu → 401 + audit auth.login.failed (timing-safe dummy bcrypt joué)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ breach_check_enabled: false }] }) // getSecurityPolicy
    queryMock.mockResolvedValueOnce({ rows: [] })  // platform_users vide
    queryMock.mockResolvedValueOnce({ rows: [] })  // tenants vide
    queryMock.mockResolvedValueOnce({ rows: [] })  // audit_log

    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'ghost@nowhere.ci', password: 'whatever123' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('Email ou mot de passe incorrect')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.login.failed')
  })

  it('login tenant OK → 200 + audit auth.login.success', async () => {
    const passwordHash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ breach_check_enabled: false, password_max_age_days: 0 }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })  // platform_users vide
      .mockResolvedValueOnce({ rows: [{ id: 't1', schema_name: 'tenant_sotra', name: 'Sotra', slug: 'sotra',
        primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
        has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CI', mfa_required: false }] }) // tenants
      .mockResolvedValueOnce({ rows: [{
        id: 'u1', email: 'admin@sotra.ci', password_hash: passwordHash, role: 'admin',
        first_name: 'A', last_name: 'D', mfa_enabled: false, is_active: true, last_login_at: '2024-01-01',
        password_changed_at: '2024-01-01',
      }] })  // users dans tenant_sotra
      .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] })  // employees lookup
      .mockResolvedValueOnce({ rows: [] })  // UPDATE last_login_at
      .mockResolvedValueOnce({ rows: [] })  // audit_log

    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.token).toBeDefined()
    expect(body.user.role).toBe('admin')
    expect(body.tenantConfig.slug).toBe('sotra')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.login.success')
  })

  it('login platform super_admin → 200 + audit scope:platform', async () => {
    const passwordHash = await bcrypt.hash('SuperAdmin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ breach_check_enabled: false, password_max_age_days: 0,
        mfa_required_super_admin: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{
        id: 'sa1', email: 'superadmin@nexusrh-ci.com', password_hash: passwordHash, role: 'super_admin',
        first_name: 'Super', last_name: 'Admin', mfa_enabled: false, is_active: true,
        password_changed_at: '2024-01-01',
      }] })
      .mockResolvedValueOnce({ rows: [] })  // UPDATE platform_users
      .mockResolvedValueOnce({ rows: [] })  // audit_log

    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'superadmin@nexusrh-ci.com', password: 'SuperAdmin1234!' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.user.role).toBe('super_admin')
    expect(body.redirectTo).toBe('/platform/dashboard')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.login.success')
    const changes = JSON.parse(auditCall?.[1]?.[2] as string)
    expect(changes.scope).toBe('platform')
  })

  it('DB error → 503 sans leak détails (OWASP A10)', async () => {
    // getSecurityPolicy avale ses propres erreurs (défauts) → on le fait réussir,
    // puis on rejette sur la requête platform_users pour déclencher le 503.
    queryMock.mockResolvedValueOnce({ rows: [{ breach_check_enabled: false }] }) // getSecurityPolicy
    queryMock.mockRejectedValueOnce(new Error('FATAL: database "nexusrhci" does not exist'))
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'a@b.ci', password: 'whatever' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toContain('FATAL')
    expect(res.body).not.toContain('nexusrhci')
  })
})

describe('POST /auth/change-password — Zod + audit (OWASP A03 + A09)', () => {
  function tokenFor(role: string, schemaName = 'tenant_sotra') {
    return app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName, role,
      email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
    })
  }

  it('refuse body sans oldPassword (400)', async () => {
    const token = tokenFor('admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse newPassword < 8 chars (400)', async () => {
    const token = tokenFor('admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'Old', newPassword: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('ancien mot de passe incorrect → 400 + audit password.change_failed', async () => {
    const wrongOldHash = await bcrypt.hash('CorrectOldPassword', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: wrongOldHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor('admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'WrongGuess', newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(400)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.password.change_failed')
  })

  it('change-password OK → 200 + audit auth.password.changed', async () => {
    const correctOldHash = await bcrypt.hash('CorrectOld', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: correctOldHash }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (password_hash + password_changed_at)
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor('admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.password.changed')
  })

  it('refuse un schemaName non-conforme à l\'authentification (401, defense in depth A03)', async () => {
    // Le garde central (plugin auth) rejette désormais tout token au schemaName
    // non conforme AVANT d'atteindre le handler — fail-closed au choke point.
    const token = tokenFor('admin', 'tenant_x; DROP TABLE users--')
    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toContain('schéma non conforme')
  })
})

describe('POST /auth/logout — audit + blacklist (OWASP A09)', () => {
  it('logout trace audit auth.logout', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    const res = await app.inject({
      method: 'POST', url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.logout')
  })
})
