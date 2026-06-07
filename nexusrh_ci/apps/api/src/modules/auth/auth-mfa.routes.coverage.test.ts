/**
 * COVERAGE — Branches non couvertes de auth-mfa.routes.ts.
 *
 * Complète auth-mfa.routes.test.ts sans le modifier. Cible :
 *   - scope platform (findUserScope + loadUserForToken super_admin)
 *   - utilisateur introuvable (404) sur setup / verify / disable
 *   - MFA déjà activé (409) sur verify
 *   - login-verify : succès TOTP, succès backup code (consommé), code invalide,
 *     MFA non actif (409), userInfo introuvable (404), challenge mauvais aud
 *   - forgot-password : utilisateur trouvé dans un tenant
 *   - reset-password : token dans un tenant, aucun match (404)
 *
 * Pièges respectés : pg mocké via vi.hoisted, schema-migrations mocké, email
 * mocké, bcrypt 12 rounds → timeout généreux sur les tests qui en génèrent.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { authenticator } from 'otplib'
import { sendPasswordResetLinkEmail } from '../../services/email.js'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:      vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe:  vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted:  vi.fn().mockResolvedValue(false),
  consumeTotpStep:     vi.fn().mockResolvedValue(true), // anti-rejeu TOTP : step neuf
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema:   vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:    vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:      vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:      vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail:  vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    appUrl: 'http://localhost:3001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import authMfaRoutes, { buildMfaChallenge } from './auth-mfa.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'

function tokenFor(app: FastifyInstance, role: string, schemaName = TENANT) {
  return app.jwt.sign({
    sub: UUID_A, tenantId: 't1', schemaName, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authMfaRoutes, { prefix: '/auth' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

// ─────────────────────────────────────────────────────────────────────────────
describe('preHandler — branche platform (ensurePlatformSchema)', () => {
  it('un token super_admin (schemaName=platform) déclenche le chemin platform', async () => {
    // setup en scope platform : findUserScope lit platform.platform_users
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // findUserScope platform → vide → 404
    const token = tokenFor(app, 'super_admin', 'platform')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/mfa/setup — scope platform + 404', () => {
  it('utilisateur introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // findUserScope vide
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('scope platform → secret + QR + backup codes (table platform.mfa_backup_codes)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'sa@b.ci', mfa_enabled: false, mfa_secret: null }] }) // findUserScope platform
      .mockResolvedValueOnce({ rows: [] })   // UPDATE mfa_secret
      .mockResolvedValueOnce({ rows: [] })   // DELETE backup codes
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) // 10 INSERT
      .mockResolvedValueOnce({ rows: [] })   // activity_log
    const token = tokenFor(app, 'super_admin', 'platform')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.backupCodes).toHaveLength(10)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO platform.mfa_backup_codes'))
    expect(insertCall).toBeDefined()
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/mfa/verify — 404 et 409 MFA déjà activé', () => {
  it('utilisateur introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // findUserScope vide
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('MFA déjà activé → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: 'SECRET' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà activé')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/mfa/disable — 404 utilisateur introuvable', () => {
  it('scope null → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // findUserScope vide
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'whatever' },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/mfa/login-verify — flux complets', () => {
  it('challenge avec mauvais aud → 401', async () => {
    const wrong = app.jwt.sign({ sub: UUID_A, schemaName: TENANT, tenantId: 't1', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null })
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge: wrong, code: '123456' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('MFA non actif sur le compte → 409', async () => {
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock.mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: false, mfa_secret: null }] }) // findUserScope
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code: '123456' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('MFA non actif')
  })

  it('code TOTP invalide → 401 + audit mfa.login_failed', async () => {
    const secret = authenticator.generateSecret()
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope
      .mockResolvedValueOnce({ rows: [] }) // audit mfa.login_failed
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code: '000000' },
    })
    expect(res.statusCode).toBe(401)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mfa.login_failed')
  })

  it('code TOTP valide → 200 + token final + tenantConfig (tenant)', async () => {
    const secret = authenticator.generateSecret()
    const code = authenticator.generate(secret)
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope
      // loadUserForToken (tenant)
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, email: 'a@b.ci', role: 'admin', first_name: 'A', last_name: 'B' }] }) // users
      .mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Sotra', slug: 'sotra', primary_color: '#E85D04',
        secondary_color: '#F48C06', logo_url: null, city: 'Abidjan', has_subsidiaries: false,
        payroll_mode: 'monthly', default_country_code: 'CI' }] }) // tenants
      .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] }) // employees
      .mockResolvedValueOnce({ rows: [] }) // audit mfa.login_success
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.token).toBeDefined()
    expect(body.tenantConfig.slug).toBe('sotra')
    expect(body.redirectTo).toBe('/dashboard')
    expect(res.headers['set-cookie']).toBeDefined()
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mfa.login_success')
  })

  it('code TOTP valide en scope platform → 200 + redirect /platform/dashboard', async () => {
    const secret = authenticator.generateSecret()
    const code = authenticator.generate(secret)
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: 'platform', tenantId: null })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'sa@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope platform
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, email: 'sa@b.ci', first_name: 'Super', last_name: 'Admin' }] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // activity_log
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.redirectTo).toBe('/platform/dashboard')
    expect(body.tenantConfig).toBeNull()
    expect(body.user.role).toBe('super_admin')
  })

  it('backup code valide → consommé (UPDATE used_at) + 200', async () => {
    const secret = authenticator.generateSecret()
    const backupPlain = 'ABCDEFGHJK'
    const backupHash = await bcrypt.hash(backupPlain, 4)
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope
      .mockResolvedValueOnce({ rows: [{ id: 'bc1', code_hash: backupHash }] }) // SELECT backup codes non utilisés
      .mockResolvedValueOnce({ rows: [] }) // UPDATE used_at
      // loadUserForToken (tenant)
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, email: 'a@b.ci', role: 'employee', first_name: 'A', last_name: 'B' }] })
      .mockResolvedValueOnce({ rows: [{ id: 't1', name: 'Sotra', slug: 'sotra', primary_color: '#E85D04',
        secondary_color: '#F48C06', logo_url: null, city: 'Abidjan', has_subsidiaries: false,
        payroll_mode: 'monthly', default_country_code: 'CI' }] })
      .mockResolvedValueOnce({ rows: [] }) // employees vide → employeeId null
      .mockResolvedValueOnce({ rows: [] }) // audit mfa.login_success
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code: backupPlain },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.redirectTo).toBe('/mon-espace') // role employee
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('SET used_at = now()'))
    expect(updateCall).toBeDefined()
  })

  it('backup code invalide → 401', async () => {
    const secret = authenticator.generateSecret()
    const otherHash = await bcrypt.hash('ZZZZZZZZZZ', 4)
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope
      .mockResolvedValueOnce({ rows: [{ id: 'bc1', code_hash: otherHash }] }) // backup codes (ne matche pas)
      .mockResolvedValueOnce({ rows: [] }) // audit mfa.login_failed
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code: 'WRONGCODE9' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('code TOTP valide mais utilisateur introuvable (loadUserForToken null) → 404', async () => {
    const secret = authenticator.generateSecret()
    const code = authenticator.generate(secret)
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope
      .mockResolvedValueOnce({ rows: [] }) // loadUserForToken users vide → null
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code },
    })
    expect(res.statusCode).toBe(404)
  })

  it('TOTP valide mais tenant introuvable (loadUserForToken tenant null) → 404', async () => {
    const secret = authenticator.generateSecret()
    const code = authenticator.generate(secret)
    const challenge = buildMfaChallenge(app, { sub: UUID_A, schemaName: TENANT, tenantId: 't1' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: secret }] }) // findUserScope
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, email: 'a@b.ci', role: 'admin', first_name: 'A', last_name: 'B' }] }) // users
      .mockResolvedValueOnce({ rows: [] }) // tenants vide → null
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge, code },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/forgot-password — utilisateur dans un tenant', () => {
  it('email trouvé dans un tenant actif → INSERT token tenant + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // platform_users vide
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT }] }) // tenants actifs
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, first_name: 'Kouassi' }] }) // users tenant
      .mockResolvedValueOnce({ rows: [] }) // DELETE old tokens
      .mockResolvedValueOnce({ rows: [] }) // INSERT password_reset_tokens
      .mockResolvedValueOnce({ rows: [] }) // audit_log tenant
    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'kouassi@sotra.ci' },
    })
    expect(res.statusCode).toBe(200)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes(`"${TENANT}".password_reset_tokens`))
    expect(insertCall).toBeDefined()
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes(`"${TENANT}".audit_log`))
    expect(auditCall?.[1]?.[1]).toBe('password.reset_requested')
  })

  it('email SMTP en échec → 200 quand même (anti-énumération, branche .catch)', async () => {
    vi.mocked(sendPasswordResetLinkEmail).mockRejectedValueOnce(new Error('SMTP down'))
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, first_name: 'Super' }] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // DELETE old tokens
      .mockResolvedValueOnce({ rows: [] }) // INSERT password_reset_tokens
      .mockResolvedValueOnce({ rows: [] }) // activity_log
    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'superadmin@nexusrh-ci.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toContain('Si ce compte existe')
    // Laisse la microtask .catch() s'exécuter avant la fin du test.
    await new Promise((r) => setTimeout(r, 10))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /auth/reset-password — tenant + 404', () => {
  it('token trouvé dans un tenant → UPDATE password + used_at + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // platform.password_reset_tokens vide
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT }] }) // tenants actifs
      .mockResolvedValueOnce({ rows: [{ id: 'tok1', user_id: UUID_A,
        expires_at: new Date(Date.now() + 600_000).toISOString(), used_at: null }] }) // token tenant
      .mockResolvedValueOnce({ rows: [] }) // UPDATE password
      .mockResolvedValueOnce({ rows: [] }) // UPDATE used_at
      .mockResolvedValueOnce({ rows: [] }) // audit_log tenant
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes(`"${TENANT}".audit_log`))
    expect(auditCall?.[1]?.[1]).toBe('password.reset_completed')
  }, 30_000)

  it('token tenant déjà utilisé → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // platform vide
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT }] }) // tenants
      .mockResolvedValueOnce({ rows: [{ id: 'tok1', user_id: UUID_A,
        expires_at: new Date(Date.now() + 600_000).toISOString(), used_at: new Date().toISOString() }] })
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('token tenant expiré → 410', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // platform vide
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT }] }) // tenants
      .mockResolvedValueOnce({ rows: [{ id: 'tok1', user_id: UUID_A,
        expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }] })
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(410)
  })

  it('aucun token trouvé nulle part → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // platform vide
      .mockResolvedValueOnce({ rows: [{ schema_name: TENANT }] }) // tenants
      .mockResolvedValueOnce({ rows: [] }) // token tenant vide
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(404)
  })
})
