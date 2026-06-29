/**
 * COVERAGE — Branches non couvertes de auth.routes.ts.
 *
 * Complète auth.routes.test.ts, account-lockout-login.golden.test.ts et
 * agency-login.test.ts sans les modifier. Cible :
 *   - login super_admin : MFA actif (challenge 202), mfaPending (token restreint),
 *     mot de passe expiré / compromis (pwdResetRequired)
 *   - login tenant : MFA actif (challenge 202), mfaPending tenant, expiré/compromis
 *   - login cabinet : mfaPending + must_change_password
 *   - tenant hors-ligne (findSuspendedTenantLogin) → 503 offline
 *   - refresh : token normal, token cabinet scopé (ok / révoqué / session invalide),
 *     token cabinet non scopé (préservation contexte)
 *   - csrf-token, me (avec / sans tenant)
 *   - change-password : réutilisation bloquée, fuite bloquée, schema platform,
 *     utilisateur introuvable (404)
 *
 * Pièges respectés : CATCH-ALL login → 503 si mock pg épuisé (séquences comptées
 * précisément) ; schema-migrations & redis & email & breach-check mockés ;
 * account-lockout NON mocké (fail-open via redisLockoutStore = {}).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { authenticator } from 'otplib'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore:  {},
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema:   vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

// Breach check pilotable par test (null = non concluant ; true = compromis).
const { breachMock } = vi.hoisted(() => ({ breachMock: vi.fn() }))
vi.mock('../../services/breach-check.service.js', () => ({
  isPasswordBreached: breachMock,
}))

// Garde cabinet pilotable (refresh scopé).
const { agencyGuardMock } = vi.hoisted(() => ({ agencyGuardMock: vi.fn() }))
vi.mock('../../services/agency.service.js', () => ({
  assertAgencyCanActOnTenant: agencyGuardMock,
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import authRoutes from './auth.routes.js'

let app: FastifyInstance

// Politiques réutilisables (lignes platform.platform_settings brutes).
const POLICY_PERMISSIVE = { rows: [{ breach_check_enabled: false, password_max_age_days: 0,
  password_history_count: 0, mfa_required_super_admin: false, mfa_required_tenant_users: false }] }
const POLICY_MFA_SUPER  = { rows: [{ breach_check_enabled: false, password_max_age_days: 0,
  password_history_count: 0, mfa_required_super_admin: true, mfa_required_tenant_users: false }] }
const POLICY_MFA_TENANT = { rows: [{ breach_check_enabled: false, password_max_age_days: 0,
  password_history_count: 0, mfa_required_super_admin: false, mfa_required_tenant_users: true }] }
const POLICY_EXPIRE     = { rows: [{ breach_check_enabled: false, password_max_age_days: 30,
  password_history_count: 0, mfa_required_super_admin: false, mfa_required_tenant_users: false }] }
const POLICY_BREACH     = { rows: [{ breach_check_enabled: true, password_max_age_days: 0,
  password_history_count: 0, mfa_required_super_admin: false, mfa_required_tenant_users: false }] }

function tenantRow(over: Record<string, unknown> = {}) {
  return {
    id: 't1', schema_name: 'tenant_sotra', name: 'Sotra', slug: 'sotra',
    primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
    has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CI', mfa_required: false,
    ...over,
  }
}
function tenantUserRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u1', email: 'admin@sotra.ci', password_hash: '', role: 'admin',
    first_name: 'A', last_name: 'D', mfa_enabled: false, is_active: true,
    last_login_at: '2024-01-01', password_changed_at: '2026-05-30',
    ...over,
  }
}
function agencyRow(over: Record<string, unknown> = {}) {
  return {
    id: 'au1', email: 'owner@cabinet.ci', password_hash: '', role: 'agency_owner',
    first_name: 'Awa', last_name: 'Koné', mfa_enabled: false, is_active: true,
    password_changed_at: '2026-05-30',
    agency_id: 'ag1', agency_name: 'Cabinet RH CI', agency_status: 'active',
    agency_offline_message: null,
    primary_color: '#1D4ED8', logo_url: 'http://api/x', city: 'Abidjan',
    ...over,
  }
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  breachMock.mockReset().mockResolvedValue(null)
  agencyGuardMock.mockReset()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/login — super_admin MFA & politique', () => {
  it('MFA actif → 202 challenge', async () => {
    const hash = await bcrypt.hash('SuperAdmin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_MFA_SUPER) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ id: 'sa1', email: 'super@nexusrh-ci.com', password_hash: hash,
        role: 'super_admin', first_name: 'S', last_name: 'A', mfa_enabled: true, is_active: true,
        password_changed_at: '2026-05-30' }] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // audit mfa_required
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'super@nexusrh-ci.com', password: 'SuperAdmin1234!' } })
    expect(res.statusCode).toBe(202)
    const body = JSON.parse(res.body)
    expect(body.mfaRequired).toBe(true)
    expect(body.challenge).toBeDefined()
  })

  it('MFA obligatoire mais non actif → token restreint mfaSetupRequired', async () => {
    const hash = await bcrypt.hash('SuperAdmin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_MFA_SUPER)
      .mockResolvedValueOnce({ rows: [{ id: 'sa1', email: 'super@nexusrh-ci.com', password_hash: hash,
        role: 'super_admin', first_name: 'S', last_name: 'A', mfa_enabled: false, is_active: true,
        password_changed_at: '2026-05-30' }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE platform_users
      .mockResolvedValueOnce({ rows: [] }) // audit success
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'super@nexusrh-ci.com', password: 'SuperAdmin1234!' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.mfaSetupRequired).toBe(true)
  })

  it('mot de passe expiré → must_change_password + redirect /change-password', async () => {
    const hash = await bcrypt.hash('SuperAdmin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_EXPIRE)
      .mockResolvedValueOnce({ rows: [{ id: 'sa1', email: 'super@nexusrh-ci.com', password_hash: hash,
        role: 'super_admin', first_name: 'S', last_name: 'A', mfa_enabled: false, is_active: true,
        password_changed_at: '2020-01-01' }] }) // ancien → expiré
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'super@nexusrh-ci.com', password: 'SuperAdmin1234!' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.must_change_password).toBe(true)
    expect(body.passwordExpired).toBe(true)
    expect(body.redirectTo).toBe('/change-password')
  })

  it('mot de passe compromis (breach) → passwordBreached + must_change_password', async () => {
    const hash = await bcrypt.hash('SuperAdmin1234!', 4)
    breachMock.mockResolvedValue(true)
    queryMock
      .mockResolvedValueOnce(POLICY_BREACH)
      .mockResolvedValueOnce({ rows: [{ id: 'sa1', email: 'super@nexusrh-ci.com', password_hash: hash,
        role: 'super_admin', first_name: 'S', last_name: 'A', mfa_enabled: false, is_active: true,
        password_changed_at: '2026-05-30' }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'super@nexusrh-ci.com', password: 'SuperAdmin1234!' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.passwordBreached).toBe(true)
    expect(body.must_change_password).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/login — tenant MFA & politique', () => {
  it('MFA actif sur user tenant → 202 challenge', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users vide
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash, mfa_enabled: true })] }) // users
      .mockResolvedValueOnce({ rows: [] }) // audit mfa_required
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).mfaRequired).toBe(true)
  })

  it('MFA obligatoire tenant (politique) sans MFA actif → mfaSetupRequired', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_MFA_TENANT)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash, mfa_enabled: false })] }) // users
      .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] }) // employees
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).mfaSetupRequired).toBe(true)
  })

  it('mot de passe tenant expiré → redirect /change-password', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_EXPIRE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash, password_changed_at: '2020-01-01' })] })
      .mockResolvedValueOnce({ rows: [] }) // employees vide
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.passwordExpired).toBe(true)
    expect(body.redirectTo).toBe('/change-password')
  })

  it('employees lookup en échec (catch) → employeeId null, login OK', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash })] }) // users
      .mockRejectedValueOnce(new Error('employees table missing')) // employees → catch
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).user.employeeId).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/login — cabinet MFA & politique', () => {
  it('cabinet MFA actif → 202 challenge', async () => {
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants vide
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash, mfa_enabled: true })] }) // findAgencyUser
      .mockResolvedValueOnce({ rows: [] }) // audit mfa_required
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'Cabinet1234!' } })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).mfaRequired).toBe(true)
  })

  it('cabinet MFA obligatoire (politique) → mfaSetupRequired', async () => {
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_MFA_SUPER)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants vide
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash, mfa_enabled: false })] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit success
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'Cabinet1234!' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).mfaSetupRequired).toBe(true)
  })

  it('cabinet mot de passe compromis → passwordBreached', async () => {
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    breachMock.mockResolvedValue(true)
    queryMock
      .mockResolvedValueOnce(POLICY_BREACH)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants vide
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash })] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit success
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'Cabinet1234!' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).passwordBreached).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/login — tenant hors-ligne (findSuspendedTenantLogin)', () => {
  it('identifiants valides sur tenant suspendu → 503 + message offline', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants actifs vide (findTenantAndUser)
      .mockResolvedValueOnce({ rows: [] }) // findAgencyUser vide
      // findSuspendedTenantLogin
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra', offline_message: 'Maintenance en cours.' }] }) // tenants suspendus
      .mockResolvedValueOnce({ rows: [{ id: 'u1', password_hash: hash, is_active: true }] }) // user suspendu
      .mockResolvedValueOnce({ rows: [] }) // audit blocked_offline
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.offline).toBe(true)
    expect(body.error).toBe('Maintenance en cours.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/refresh', () => {
  function tok(over: Record<string, unknown> = {}) {
    return app.jwt.sign({
      sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: 'emp1', ...over,
    })
  }

  it('token normal → nouveau token', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${tok()}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).token).toBeDefined()
  })

  it('token cabinet non scopé (schemaName=platform) → préserve actorType', async () => {
    const t = app.jwt.sign({ sub: 'au1', tenantId: null, schemaName: 'platform', role: 'agency_owner',
      email: 'o@c.ci', firstName: 'O', lastName: 'C', employeeId: null,
      actorType: 'agency', agencyId: 'ag1' })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    const decoded = app.jwt.decode(JSON.parse(res.body).token) as Record<string, unknown>
    expect(decoded.actorType).toBe('agency')
    expect(decoded.agencyId).toBe('ag1')
  })

  it('token cabinet scopé valide → token scopé 30m', async () => {
    agencyGuardMock.mockResolvedValue({ ok: true, tenant: {} })
    const t = app.jwt.sign({ sub: 'au1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'o@c.ci', firstName: 'O', lastName: 'C', employeeId: null,
      actorType: 'agency', agencyId: 'ag1', agencyUserId: 'au1' })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scoped).toBe(true)
    expect(body.expiresInSec).toBe(1800)
  })

  it('token cabinet scopé sans agencyId → 401 session invalide', async () => {
    const t = app.jwt.sign({ sub: 'au1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'o@c.ci', firstName: 'O', lastName: 'C', employeeId: null,
      actorType: 'agency' })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toContain('Session cabinet invalide')
  })

  it('token cabinet scopé révoqué → 401 accès révoqué', async () => {
    agencyGuardMock.mockResolvedValue({ ok: false, reason: 'not_assigned' })
    const t = app.jwt.sign({ sub: 'au1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'o@c.ci', firstName: 'O', lastName: 'C', employeeId: null,
      actorType: 'agency', agencyId: 'ag1' })
    const res = await app.inject({ method: 'POST', url: '/auth/refresh',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toContain('révoqué')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /auth/csrf-token', () => {
  it('émet un token CSRF', async () => {
    const t = app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({ method: 'GET', url: '/auth/csrf-token',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    const decoded = app.jwt.decode(JSON.parse(res.body).csrfToken) as Record<string, unknown>
    expect(decoded.aud).toBe('csrf')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /auth/me', () => {
  it('user avec tenant → tenantConfig peuplé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Sotra', slug: 'sotra',
      primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
      has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CI' }] })
    const t = app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({ method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tenantConfig.slug).toBe('sotra')
  })

  it('user avec tenant introuvable → tenantConfig null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // tenant introuvable
    const t = app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({ method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tenantConfig).toBeNull()
  })

  it('super_admin sans tenant → tenantConfig null, pas de requête tenant', async () => {
    const t = app.jwt.sign({ sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
      email: 'sa@b.ci', firstName: 'S', lastName: 'A', employeeId: null })
    const res = await app.inject({ method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tenantConfig).toBeNull()
    expect(queryMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/change-password — politique historique & fuite', () => {
  function tokenFor(role: string, schemaName = 'tenant_sotra') {
    return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName, role,
      email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null })
  }

  it('utilisateur introuvable → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] }) // SELECT password_hash vide
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'NewSecret123' } })
    expect(res.statusCode).toBe(404)
  })

  it('nouveau mot de passe = ancien (réutilisation) → 400 reuse_blocked', async () => {
    const oldHash = await bcrypt.hash('SamePass123', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 5, breach_check_enabled: false }] }) // policy
      .mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] }) // SELECT history (vide → seul le courant compte)
      .mockResolvedValueOnce({ rows: [] }) // audit reuse_blocked
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { oldPassword: 'SamePass123', newPassword: 'SamePass123' } })
    expect(res.statusCode).toBe(400)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.password.reuse_blocked')
  })

  it('nouveau mot de passe compromis → 400 breach_blocked', async () => {
    const oldHash = await bcrypt.hash('CorrectOld', 4)
    breachMock.mockResolvedValue(true)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: true }] }) // policy
      .mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // audit breach_blocked
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'BreachedPass1' } })
    expect(res.statusCode).toBe(400)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('auth.password.breach_blocked')
  })

  it('OK avec historique → INSERT history + DELETE purge + 200', async () => {
    const oldHash = await bcrypt.hash('CorrectOld', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 5, breach_check_enabled: false }] }) // policy
      .mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // SELECT history (aucune réutilisation)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE password
      .mockResolvedValueOnce({ rows: [] }) // revokeAllRefreshTokensForUser (OWASP A07)
      .mockResolvedValueOnce({ rows: [] }) // INSERT history
      .mockResolvedValueOnce({ rows: [] }) // DELETE purge
      .mockResolvedValueOnce({ rows: [] }) // audit changed
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'BrandNewPass99' } })
    expect(res.statusCode).toBe(200)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "tenant_sotra".password_history'))
    expect(insertCall).toBeDefined()
  })

  it('change-password en scope platform → table platform.platform_users', async () => {
    const oldHash = await bcrypt.hash('CorrectOld', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: false }] }) // policy
      .mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // revokeAllRefreshTokensForUser (OWASP A07)
      .mockResolvedValueOnce({ rows: [] }) // audit
    const t = app.jwt.sign({ sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
      email: 'sa@b.ci', firstName: 'S', lastName: 'A', employeeId: null })
    const res = await app.inject({ method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${t}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'BrandNewPass99' } })
    expect(res.statusCode).toBe(200)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE platform.platform_users'))
    expect(updateCall).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/login — findTenantAndUser branches internes', () => {
  it('lookup d\'un schema tenant en échec (catch) → ignoré, 401 final', async () => {
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users vide
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants actifs
      .mockRejectedValueOnce(new Error('users table missing')) // SELECT users → catch (138-139)
      // aucun candidat → findTenantAndUser null
      .mockResolvedValueOnce({ rows: [] }) // findAgencyUser vide
      .mockResolvedValueOnce({ rows: [] }) // tenants suspendus vide
      .mockResolvedValueOnce({ rows: [] }) // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'ghost@sotra.ci', password: 'whatever123' } })
    expect(res.statusCode).toBe(401)
  })

  it('utilisateur tenant inactif → ignoré (continue), 401 final', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash, is_active: false })] }) // user inactif (149-151)
      .mockResolvedValueOnce({ rows: [] }) // findAgencyUser
      .mockResolvedValueOnce({ rows: [] }) // tenants suspendus
      .mockResolvedValueOnce({ rows: [] }) // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(401)
  })

  it('mot de passe tenant erroné sur un candidat actif → return null (156-158), 401', async () => {
    const hash = await bcrypt.hash('TheRealPassword', 4)
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash, is_active: true })] }) // candidat actif
      .mockResolvedValueOnce({ rows: [] }) // findAgencyUser
      .mockResolvedValueOnce({ rows: [] }) // tenants suspendus
      .mockResolvedValueOnce({ rows: [] }) // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'WrongGuess999' } })
    expect(res.statusCode).toBe(401)
  })

  it('tenant mot de passe compromis (breach) → passwordBreached (558-559)', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    breachMock.mockResolvedValue(true)
    queryMock
      .mockResolvedValueOnce(POLICY_BREACH)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [tenantRow()] }) // tenants
      .mockResolvedValueOnce({ rows: [tenantUserRow({ password_hash: hash })] }) // user
      .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] }) // employees
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).passwordBreached).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/login — replis pré-migration (findAgencyUser / findSuspendedTenantLogin)', () => {
  it('findAgencyUser : 1ère requête en échec → repli (187-198) puis 401', async () => {
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants (findTenantAndUser)
      .mockRejectedValueOnce(new Error('column offline_message missing')) // findAgencyUser 1ère requête
      .mockResolvedValueOnce({ rows: [] }) // findAgencyUser repli → vide
      .mockResolvedValueOnce({ rows: [] }) // tenants suspendus (findSuspendedTenantLogin)
      .mockResolvedValueOnce({ rows: [] }) // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'ghost@nowhere.ci', password: 'whatever123' } })
    expect(res.statusCode).toBe(401)
  })

  it('findAgencyUser : requête principale ET repli en échec → catch externe null (204-205)', async () => {
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants (findTenantAndUser)
      .mockRejectedValueOnce(new Error('agency_users absent')) // findAgencyUser 1ère requête
      .mockRejectedValueOnce(new Error('agency_users absent (repli)')) // repli → rejette aussi → catch externe
      .mockResolvedValueOnce({ rows: [] }) // tenants suspendus (findSuspendedTenantLogin)
      .mockResolvedValueOnce({ rows: [] }) // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'ghost@nowhere.ci', password: 'whatever123' } })
    expect(res.statusCode).toBe(401)
  })

  it('findSuspendedTenantLogin : 1ère requête en échec → repli (220-222) puis 401', async () => {
    queryMock
      .mockResolvedValueOnce(POLICY_PERMISSIVE)
      .mockResolvedValueOnce({ rows: [] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // tenants (findTenantAndUser)
      .mockResolvedValueOnce({ rows: [] }) // findAgencyUser vide
      .mockRejectedValueOnce(new Error('column offline_message missing')) // tenants suspendus 1ère requête
      .mockResolvedValueOnce({ rows: [] }) // tenants suspendus repli → vide
      .mockResolvedValueOnce({ rows: [] }) // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'ghost@nowhere.ci', password: 'whatever123' } })
    expect(res.statusCode).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('login MFA TOTP utilitaire — sanity authenticator', () => {
  it('authenticator génère un code à 6 chiffres', () => {
    const secret = authenticator.generateSecret()
    expect(authenticator.generate(secret)).toMatch(/^\d{6}$/)
  })
})
