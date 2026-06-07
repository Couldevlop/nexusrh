import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { authenticator } from 'otplib'

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
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import authMfaRoutes from './auth-mfa.routes.js'

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

describe('POST /auth/mfa/setup — génère secret + QR + backup codes (OWASP A02)', () => {
  it('refuse sans authentification (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/mfa/setup' })
    expect(res.statusCode).toBe(401)
  })

  it('génère secret + QR base64 + 10 backup codes (one-time display)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: false, mfa_secret: null }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [] })   // UPDATE mfa_secret
      .mockResolvedValueOnce({ rows: [] })   // DELETE backup codes
      // 10 INSERT backup codes
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })   // audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(body.secret).toMatch(/^[A-Z2-7]+$/)  // base32
    expect(body.backupCodes).toHaveLength(10)
    expect(body.backupCodes[0]).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
  }, 60_000)  // bcrypt 12 rounds × 10 codes = ~3-5s (bien plus sous instrumentation coverage)
})

describe('POST /auth/mfa/verify — active MFA après scan du QR (OWASP A03)', () => {
  it('refuse code non-6-digits (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '12345' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse 409 si aucun secret en attente', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: false, mfa_secret: null }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('refuse code TOTP invalide (401) + audit mfa.verify_failed', async () => {
    const secret = authenticator.generateSecret()
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: false, mfa_secret: secret }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '000000' },
    })
    expect(res.statusCode).toBe(401)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mfa.verify_failed')
  })

  it('code TOTP valide → active mfa_enabled + audit mfa.enabled', async () => {
    const secret = authenticator.generateSecret()
    const validCode = authenticator.generate(secret)
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: false, mfa_secret: secret }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE mfa_enabled
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: validCode },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mfa.enabled')
  })
})

describe('POST /auth/forgot-password — anti-énumération (OWASP A07)', () => {
  it('email inconnu → 200 générique (anti-énumération)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT platform_users
      .mockResolvedValueOnce({ rows: [] }) // SELECT tenants
    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'ghost@nowhere.ci' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toContain('Si ce compte existe')
  })

  it('email mal formé → 200 générique aussi (anti-énumération même sur 400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'not-email' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toContain('Si ce compte existe')
  })

  it('platform user trouvé → INSERT password_reset_tokens + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, first_name: 'Super' }] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // DELETE old tokens
      .mockResolvedValueOnce({ rows: [] }) // INSERT password_reset_tokens
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/auth/forgot-password',
      payload: { email: 'superadmin@nexusrh.com' },
    })
    expect(res.statusCode).toBe(200)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO platform.password_reset_tokens'))
    expect(insertCall).toBeDefined()
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('activity_log'))
    expect(auditCall?.[1]?.[1]).toBe('password.reset_requested')
  })
})

describe('POST /auth/reset-password — token unique-use (OWASP A02)', () => {
  it('refuse token < 20 chars (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'short', newPassword: 'NewPass1234' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse nouveau mot de passe < 8 chars (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('token déjà utilisé → 409', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: UUID_A, user_id: UUID_A,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        used_at: new Date().toISOString() }],
    })
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('token expiré → 410', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: UUID_A, user_id: UUID_A,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        used_at: null }],
    })
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(410)
  })

  it('token valide → UPDATE password + UPDATE used_at + audit', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: UUID_A, user_id: UUID_A,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          used_at: null }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE password_hash
      .mockResolvedValueOnce({ rows: [] }) // UPDATE used_at
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const res = await app.inject({
      method: 'POST', url: '/auth/reset-password',
      payload: { token: 'x'.repeat(40), newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('activity_log'))
    expect(auditCall?.[1]?.[1]).toBe('password.reset_completed')
  })
})

describe('POST /auth/mfa/login-verify — challenge JWT + code TOTP', () => {
  it('refuse challenge invalide (401)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge: 'bad.jwt.here', code: '123456' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuse code hors format (400, ni 6-digits ni 10-chars)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge: 'x'.repeat(50), code: '12' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('challenge avec mauvais aud → 401', async () => {
    const wrongChallenge = app.jwt.sign({
      sub: UUID_A, tenantId: 't1', schemaName: TENANT, role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })  // pas de aud='mfa-challenge'
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge: wrongChallenge, code: '123456' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /auth/mfa/disable — re-vérification mot de passe', () => {
  it('refuse password absent (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('mauvais mot de passe → 401 + audit mfa.disable_failed', async () => {
    const goodHash = await bcrypt.hash('GoodPass', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: 'S' }] })
      .mockResolvedValueOnce({ rows: [{ password_hash: goodHash }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'WrongPass' },
    })
    expect(res.statusCode).toBe(401)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mfa.disable_failed')
  })

  it('bon mot de passe → désactive MFA + purge backup codes + audit mfa.disabled', async () => {
    const goodHash = await bcrypt.hash('GoodPass', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.ci', mfa_enabled: true, mfa_secret: 'S' }] })
      .mockResolvedValueOnce({ rows: [{ password_hash: goodHash }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE mfa_enabled=false
      .mockResolvedValueOnce({ rows: [] }) // DELETE backup codes
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'GoodPass' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('mfa.disabled')
  })
})
