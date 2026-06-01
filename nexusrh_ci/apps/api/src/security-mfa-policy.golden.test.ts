/**
 * GOLDEN — Politique de sécurité paramétrable : MFA configurable, durée de vie
 * du mot de passe, blacklist anti-réutilisation, vérification de fuite.
 *
 * Couvre le câblage login + change-password + garde plugin (pwdResetRequired)
 * autour des services security-policy / breach-check (eux-mêmes couverts à 100%
 * par leurs tests unitaires). Conforme OWASP A07 (auth failures) + A01 (garde).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('./services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('./services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

// Breach-check contrôlable par test (null = pas d'internet par défaut).
const { breachMock } = vi.hoisted(() => ({ breachMock: vi.fn() }))
vi.mock('./services/breach-check.service.js', () => ({ isPasswordBreached: breachMock }))

vi.mock('./config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from './plugins/auth.js'
import authRoutes from './modules/auth/auth.routes.js'

const TENANT = 'tenant_sotra'
let app: FastifyInstance

function tenantRow(over: Record<string, unknown> = {}) {
  return {
    id: 't1', schema_name: TENANT, name: 'Sotra', slug: 'sotra',
    primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
    has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CI',
    mfa_required: false, ...over,
  }
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); breachMock.mockReset(); breachMock.mockResolvedValue(null) })

function decode(token: string): Record<string, unknown> {
  return app.jwt.verify(token) as Record<string, unknown>
}

// ── super_admin ───────────────────────────────────────────────────────────────
describe('super_admin — MFA paramétrable (déblocage création tenant)', () => {
  async function loginSuperAdmin(settings: Record<string, unknown>, userOver: Record<string, unknown> = {}) {
    const passwordHash = await bcrypt.hash('SuperAdmin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [settings] })                     // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ id: 'sa1', email: 'superadmin@nexusrh-ci.com',
        password_hash: passwordHash, role: 'super_admin', first_name: 'S', last_name: 'A',
        mfa_enabled: false, is_active: true, password_changed_at: '2026-05-25T00:00:00Z', ...userOver }] }) // platform_users
      .mockResolvedValueOnce({ rows: [] })                            // UPDATE
      .mockResolvedValueOnce({ rows: [] })                            // audit
    return app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'superadmin@nexusrh-ci.com', password: 'SuperAdmin1234!' } })
  }

  it('MFA désactivé (défaut) → token PLEIN, pas de mfaPending → accès plateforme OK', async () => {
    const res = await loginSuperAdmin({ mfa_required_super_admin: false, breach_check_enabled: false, password_max_age_days: 0 })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.mfaSetupRequired).toBe(false)
    expect(body.must_change_password).toBe(false)
    expect(body.redirectTo).toBe('/platform/dashboard')
    expect(decode(body.token).mfaPending).toBeUndefined()
    expect(decode(body.token).pwdResetRequired).toBeUndefined()
  })

  it('MFA obligatoire activé + MFA non configuré → token RESTREINT (mfaPending)', async () => {
    const res = await loginSuperAdmin({ mfa_required_super_admin: true, breach_check_enabled: false, password_max_age_days: 0 })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.mfaSetupRequired).toBe(true)
    expect(decode(body.token).mfaPending).toBe(true)
  })

  it('mot de passe expiré → token RESTREINT (pwdResetRequired) + redirect /change-password', async () => {
    const res = await loginSuperAdmin(
      { mfa_required_super_admin: false, breach_check_enabled: false, password_max_age_days: 30 },
      { password_changed_at: '2024-01-01T00:00:00Z' },
    )
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.passwordExpired).toBe(true)
    expect(body.must_change_password).toBe(true)
    expect(body.redirectTo).toBe('/change-password')
    expect(decode(body.token).pwdResetRequired).toBe(true)
  })

  it('mot de passe dans une fuite → token RESTREINT (pwdResetRequired)', async () => {
    breachMock.mockResolvedValue(true)
    const res = await loginSuperAdmin({ mfa_required_super_admin: false, breach_check_enabled: true, password_max_age_days: 0 })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.passwordBreached).toBe(true)
    expect(body.must_change_password).toBe(true)
    expect(decode(body.token).pwdResetRequired).toBe(true)
  })
})

// ── tenant ──────────────────────────────────────────────────────────────────
describe('employés tenant — MFA paramétrable (global + surcharge tenant)', () => {
  async function loginTenant(settings: Record<string, unknown>, tenant: Record<string, unknown>) {
    const passwordHash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [settings] })          // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })                  // platform_users vide
      .mockResolvedValueOnce({ rows: [tenantRow(tenant)] }) // tenants
      .mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'admin@sotra.ci', password_hash: passwordHash,
        role: 'admin', first_name: 'A', last_name: 'D', mfa_enabled: false, is_active: true,
        last_login_at: '2024-01-01', password_changed_at: '2026-05-25T00:00:00Z' }] }) // users
      .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] })    // employees
      .mockResolvedValueOnce({ rows: [] })                  // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] })                  // audit
    return app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
  }

  it('politique globale MFA tenant activée → token RESTREINT (mfaPending)', async () => {
    const res = await loginTenant(
      { mfa_required_tenant_users: true, breach_check_enabled: false, password_max_age_days: 0 },
      { mfa_required: false },
    )
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.mfaSetupRequired).toBe(true)
    expect(decode(body.token).mfaPending).toBe(true)
  })

  it('surcharge tenant durcissante (global off, tenant on) → mfaPending', async () => {
    const res = await loginTenant(
      { mfa_required_tenant_users: false, breach_check_enabled: false, password_max_age_days: 0 },
      { mfa_required: true },
    )
    expect(res.statusCode).toBe(200)
    expect(decode(JSON.parse(res.body).token).mfaPending).toBe(true)
  })

  it('aucune politique MFA → token plein', async () => {
    const res = await loginTenant(
      { mfa_required_tenant_users: false, breach_check_enabled: false, password_max_age_days: 0 },
      { mfa_required: false },
    )
    expect(res.statusCode).toBe(200)
    expect(decode(JSON.parse(res.body).token).mfaPending).toBeUndefined()
  })
})

// ── garde plugin pwdResetRequired (OWASP A01) ───────────────────────────────────
describe('garde pwdResetRequired — token restreint au changement de mot de passe', () => {
  function restrictedToken() {
    return app.jwt.sign({
      sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
      email: 'superadmin@nexusrh-ci.com', firstName: 'S', lastName: 'A', employeeId: null,
      pwdResetRequired: true,
    } as never)
  }

  it('refuse une route non autorisée (POST /auth/refresh → 403)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${restrictedToken()}` } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('expiré ou compromis')
  })

  it('autorise /auth/me (consultation profil)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${restrictedToken()}` } })
    expect(res.statusCode).toBe(200)
  })

  it('autorise /auth/change-password → débloque le compte (200)', async () => {
    const oldHash = await bcrypt.hash('CurrentPass1', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${restrictedToken()}` },
      payload: { oldPassword: 'CurrentPass1', newPassword: 'BrandNewPass9' } })
    expect(res.statusCode).toBe(200)
  })
})

// ── change-password : blacklist + fuite (OWASP A07) ────────────────────────────
describe('change-password — historique anti-réutilisation + refus mot de passe fuité', () => {
  function token() {
    return app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: TENANT, role: 'admin',
      email: 'admin@sotra.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
  }

  it('réutilisation d\'un ancien mot de passe → 400 + audit reuse_blocked', async () => {
    const currentHash = await bcrypt.hash('CurrentPass1', 4)
    const oldHash     = await bcrypt.hash('ReusedPass2', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 5, breach_check_enabled: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: currentHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] })     // SELECT password_history
      .mockResolvedValueOnce({ rows: [] })                              // audit
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token()}` },
      payload: { oldPassword: 'CurrentPass1', newPassword: 'ReusedPass2' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('déjà utilisé')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.password.reuse_blocked')
  })

  it('nouveau mot de passe présent dans une fuite → 400 + audit breach_blocked', async () => {
    breachMock.mockResolvedValue(true)
    const currentHash = await bcrypt.hash('CurrentPass1', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: true }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: currentHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] })                              // audit
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token()}` },
      payload: { oldPassword: 'CurrentPass1', newPassword: 'LeakedPass99' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('fuite')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.password.breach_blocked')
  })

  it('changement valide (historique + fuite OK) → 200 + UPDATE password_changed_at + INSERT historique', async () => {
    breachMock.mockResolvedValue(false)
    const currentHash = await bcrypt.hash('CurrentPass1', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 5, breach_check_enabled: true }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: currentHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] })                              // SELECT password_history (vide)
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE
      .mockResolvedValueOnce({ rows: [] })                              // INSERT history
      .mockResolvedValueOnce({ rows: [] })                              // DELETE trim history
      .mockResolvedValueOnce({ rows: [] })                              // audit
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token()}` },
      payload: { oldPassword: 'CurrentPass1', newPassword: 'FreshUnique8' } })
    expect(res.statusCode).toBe(200)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('password_changed_at = now()'))
    expect(updateCall).toBeDefined()
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('password_history'))
    expect(insertCall).toBeDefined()
  })
})
