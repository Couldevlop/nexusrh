/**
 * GOLDEN — Le parcours MFA ne doit pas contourner les gardes du mot de passe
 * (OWASP A07).
 *
 * Incident constaté en prod : seul le compte MFA-enrôlé pouvait se connecter,
 * tous les autres étaient renvoyés sur le changement de mot de passe. Cause :
 * `/auth/login` sortait en 202 (challenge MFA) AVANT d'évaluer l'expiration /
 * la compromission du mot de passe, et `/auth/mfa/login-verify` émettait le JWT
 * final sans jamais relire ces états ni `is_active`. Le MFA — un durcissement —
 * agissait donc comme une porte dérobée sur trois contrôles de sécurité.
 *
 * Ces tests verrouillent le comportement attendu : les mêmes gardes s'appliquent
 * quel que soit le chemin, avec ou sans MFA.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { authenticator } from 'otplib'

vi.hoisted(() => { process.env['ENCRYPTION_KEY'] = 'a'.repeat(64) })

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  consumeTotpStep:    vi.fn().mockResolvedValue(true),
  setTokenEpoch:      vi.fn().mockResolvedValue(undefined),
  redisLockoutStore:  {},
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

const { breachMock } = vi.hoisted(() => ({ breachMock: vi.fn() }))
vi.mock('../../services/breach-check.service.js', () => ({ isPasswordBreached: breachMock }))

vi.mock('../../services/account-lockout.service.js', () => ({
  checkLockout:    vi.fn().mockResolvedValue({ locked: false, retryAfterSec: 0 }),
  registerFailure: vi.fn().mockResolvedValue({ locked: false, attempts: 1, retryAfterSec: 0 }),
  clearFailures:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema:   vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import { encrypt } from '@nexusrhci/shared/crypto'
import authPlugin from '../../plugins/auth.js'
import authRoutes from './auth.routes.js'
import authMfaRoutes from './auth-mfa.routes.js'

const SCHEMA   = 'tenant_sotra'
const USER_ID  = '11111111-1111-1111-1111-111111111111'
const EMAIL    = 'rh@sotra.ci'
const PASSWORD = 'MotDePasse123!'
const HASH     = bcrypt.hashSync(PASSWORD, 4)
const SECRET   = authenticator.generateSecret()

const DAYS = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes,    { prefix: '/auth' })
  await app.register(authMfaRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); breachMock.mockReset().mockResolvedValue(null) })

/** Séquence de requêtes de POST /auth/login pour un user tenant MFA-enrôlé. */
function mockLogin(opts: { passwordChangedAt: string | null }): void {
  queryMock
    .mockResolvedValueOnce({ rows: [{}] })                       // getSecurityPolicy
    .mockResolvedValueOnce({ rows: [] })                         // platform_users
    .mockResolvedValueOnce({ rows: [{                            // platform.tenants
      id: 't1', schema_name: SCHEMA, name: 'Sotra', slug: 'sotra',
      primary_color: '#E85D04', secondary_color: '#111', logo_url: null, city: 'Abidjan',
      has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CIV',
      mfa_required: false, enabled_modules: {},
    }] })
    .mockResolvedValueOnce({ rows: [{                            // "<schema>".users
      id: USER_ID, email: EMAIL, password_hash: HASH, role: 'hr_manager',
      first_name: 'Awa', last_name: 'Kone', mfa_enabled: true, is_active: true,
      last_login_at: DAYS(1), password_changed_at: opts.passwordChangedAt,
    }] })
    .mockResolvedValue({ rows: [] })                             // audits et divers
}

/** Séquence de requêtes de POST /auth/mfa/login-verify. */
function mockLoginVerify(opts: { isActive?: boolean } = {}): void {
  queryMock
    .mockResolvedValueOnce({ rows: [{                            // findUserScope
      email: EMAIL, mfa_enabled: true, mfa_secret: encrypt(SECRET),
      is_active: opts.isActive ?? true,
    }] })
    .mockResolvedValueOnce({ rows: [{                            // loadUserForToken — user
      id: USER_ID, email: EMAIL, role: 'hr_manager', first_name: 'Awa', last_name: 'Kone',
      is_active: opts.isActive ?? true, password_changed_at: DAYS(2),
    }] })
    .mockResolvedValueOnce({ rows: [{                            // tenant
      id: 't1', name: 'Sotra', slug: 'sotra', primary_color: '#E85D04', secondary_color: '#111',
      logo_url: null, city: 'Abidjan', has_subsidiaries: false,
      payroll_mode: 'monthly', default_country_code: 'CIV',
      enabled_modules: { dg_view: true },
    }] })
    .mockResolvedValue({ rows: [] })                             // employees + audits
}

async function login(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD },
  })
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> }
}

async function loginVerify(challenge: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST', url: '/auth/mfa/login-verify',
    payload: { challenge, code: authenticator.generate(SECRET) },
  })
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> }
}

describe('MFA + mot de passe expire — le 202 ne doit pas contourner la garde', () => {
  it('le challenge MFA porte pwdResetRequired quand le mot de passe est expire', async () => {
    mockLogin({ passwordChangedAt: DAYS(45) })   // > 30 j (politique par defaut)
    const { status, body } = await login()
    expect(status).toBe(202)
    const decoded = app.jwt.verify<{ pwdResetRequired?: boolean }>(body['challenge'] as string)
    expect(decoded.pwdResetRequired).toBe(true)
  })

  it('le challenge ne porte pas le flag quand le mot de passe est recent', async () => {
    mockLogin({ passwordChangedAt: DAYS(2) })
    const { status, body } = await login()
    expect(status).toBe(202)
    const decoded = app.jwt.verify<{ pwdResetRequired?: boolean }>(body['challenge'] as string)
    expect(decoded.pwdResetRequired).toBeUndefined()
  })

  it('le challenge porte le flag quand le mot de passe est compromis (HIBP)', async () => {
    breachMock.mockResolvedValue(true)
    mockLogin({ passwordChangedAt: DAYS(2) })
    const { body } = await login()
    const decoded = app.jwt.verify<{ pwdResetRequired?: boolean }>(body['challenge'] as string)
    expect(decoded.pwdResetRequired).toBe(true)
  })
})

describe('POST /auth/mfa/login-verify — memes gardes que /auth/login', () => {
  it('mot de passe expire → token final RESTREINT + must_change_password', async () => {
    mockLogin({ passwordChangedAt: DAYS(45) })
    const { body: loginBody } = await login()
    queryMock.mockReset()
    mockLoginVerify()

    const { status, body } = await loginVerify(loginBody['challenge'] as string)
    expect(status).toBe(200)
    expect(body['must_change_password']).toBe(true)
    expect(body['redirectTo']).toBe('/change-password')
    const token = app.jwt.verify<{ pwdResetRequired?: boolean }>(body['token'] as string)
    expect(token.pwdResetRequired).toBe(true)
  })

  it('mot de passe valide → token final PLEIN (aucune regression)', async () => {
    mockLogin({ passwordChangedAt: DAYS(2) })
    const { body: loginBody } = await login()
    queryMock.mockReset()
    mockLoginVerify()

    const { status, body } = await loginVerify(loginBody['challenge'] as string)
    expect(status).toBe(200)
    expect(body['must_change_password']).toBeFalsy()
    expect(body['redirectTo']).toBe('/dashboard')
    const token = app.jwt.verify<{ pwdResetRequired?: boolean }>(body['token'] as string)
    expect(token.pwdResetRequired).toBeUndefined()
  })

  it('compte desactive entre le challenge et la verification → 401', async () => {
    mockLogin({ passwordChangedAt: DAYS(2) })
    const { body: loginBody } = await login()
    queryMock.mockReset()
    mockLoginVerify({ isActive: false })

    const { status } = await loginVerify(loginBody['challenge'] as string)
    expect(status).toBe(401)
  })
})

describe('POST /auth/mfa/login-verify — tenantConfig complet (parite avec /auth/login)', () => {
  it('renvoie enabledModules, sinon le menu du DG est vide apres une connexion MFA', async () => {
    // `dg_view` vaut false par defaut cote front : si l'API omet enabledModules,
    // les deux seules entrees de menu du role dg sont masquees -> ecran sans menu.
    mockLogin({ passwordChangedAt: DAYS(2) })
    const { body: loginBody } = await login()
    queryMock.mockReset()
    mockLoginVerify()

    const { status, body } = await loginVerify(loginBody['challenge'] as string)
    expect(status).toBe(200)
    const cfg = body['tenantConfig'] as Record<string, unknown>
    expect(cfg['enabledModules']).toBeDefined()
    expect((cfg['enabledModules'] as Record<string, boolean>)['dg_view']).toBe(true)
  })
})
