/**
 * GOLDEN — Parcours MFA des comptes CABINET (`platform.agency_users`).
 *
 * Incident constaté en prod : aucun compte de cabinet ne pouvait entrer.
 * Le login réussit (200) mais, la MFA étant obligatoire, le token remis est
 * RESTREINT (`mfaPending`) et le front redirige vers /mfa-setup — où
 * `POST /auth/mfa/setup` répondait **404 « Utilisateur introuvable »**.
 *
 * Cause : un utilisateur de cabinet porte `schemaName: 'platform'` dans son
 * token, mais il vit dans `platform.agency_users`, pas dans
 * `platform.platform_users` — la seule table que consultaient `findUserScope`
 * et `loadUserForToken`. Impasse totale : ni enrôlement, ni validation de code.
 *
 * Ces tests verrouillent les deux extrémités du parcours, et surtout le fait
 * qu'un compte de cabinet ne doit JAMAIS ressortir avec un rôle plateforme.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { authenticator } from 'otplib'
import bcrypt from 'bcryptjs'

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

vi.mock('../../services/breach-check.service.js', () => ({
  isPasswordBreached: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../services/account-lockout.service.js', () => ({
  checkLockout:    vi.fn().mockResolvedValue({ locked: false, retryAfterSec: 0 }),
  registerFailure: vi.fn().mockResolvedValue({ locked: false, attempts: 1, retryAfterSec: 0 }),
  clearFailures:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
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

import { encrypt } from '../../utils/crypto.js'
import authPlugin from '../../plugins/auth.js'
import authMfaRoutes from './auth-mfa.routes.js'
import authRoutes from './auth.routes.js'

const AGENCY_USER = '040af228-5cf7-4bdc-a305-3d39082968f7'
const AGENCY_ID   = '567a9eac-2eaf-4539-86e8-10cebd087909'
const EMAIL       = 'owner@cabinet-talents.ci'
const SECRET      = authenticator.generateSecret()

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authMfaRoutes, { prefix: '/auth' })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

/** Token restreint tel qu'émis par /auth/login pour un cabinet sans MFA. */
function agencyToken(extra: Record<string, unknown> = {}): string {
  return app.jwt.sign({
    sub: AGENCY_USER, tenantId: null, schemaName: 'platform', role: 'agency_owner',
    email: EMAIL, firstName: 'Awa', lastName: 'Kone', employeeId: null,
    actorType: 'agency', agencyId: AGENCY_ID, ...extra,
  })
}

/** Ligne renvoyée par la recherche dans platform.agency_users. */
const agencyScopeRow = (mfaEnabled: boolean) => ({
  email: EMAIL, mfa_enabled: mfaEnabled,
  mfa_secret: mfaEnabled ? encrypt(SECRET) : null,
  is_active: true,
})

describe('POST /auth/mfa/setup — compte de cabinet', () => {
  it('génère le QR code au lieu de répondre 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                        // platform_users : absent
      .mockResolvedValueOnce({ rows: [agencyScopeRow(false)] })   // agency_users : trouvé
      .mockResolvedValue({ rows: [] })                            // UPDATE + DELETE + 10 INSERT + audit

    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${agencyToken({ mfaPending: true })}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(body.backupCodes).toHaveLength(10)
    // Le secret est écrit dans la table du CABINET, jamais dans platform_users.
    const update = queryMock.mock.calls.find(c => String(c[0]).includes('SET mfa_secret'))
    expect(String(update?.[0])).toContain('agency_users')
  })
})

describe('POST /auth/mfa/login-verify — compte de cabinet', () => {
  const challenge = (): string => app.jwt.sign(
    // `aud` n'est pas dans le type JwtSignPayload de l'application (cast
    // contrôlé, comme dans auth-mfa.routes.test.ts).
    { sub: AGENCY_USER, schemaName: 'platform', tenantId: null,
      aud: 'mfa-challenge', userId: AGENCY_USER } as never,
    { expiresIn: '3m' },
  )

  function mockVerifyQueries(): void {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                      // findUserScope → platform_users
      .mockResolvedValueOnce({ rows: [agencyScopeRow(true)] })  // findUserScope → agency_users
      .mockResolvedValueOnce({ rows: [] })                      // loadUserForToken → platform_users
      .mockResolvedValueOnce({ rows: [{                         // loadUserForToken → agency_users
        id: AGENCY_USER, email: EMAIL, role: 'agency_owner',
        first_name: 'Awa', last_name: 'Kone',
        agency_id: AGENCY_ID, agency_name: 'Cabinet Talents CI',
        primary_color: '#1D4ED8', logo_url: null, city: 'Abidjan',
      }] })
      .mockResolvedValue({ rows: [] })                          // audit
  }

  it('émet le token du cabinet — jamais un rôle plateforme', async () => {
    mockVerifyQueries()
    const res = await app.inject({
      method: 'POST', url: '/auth/mfa/login-verify',
      payload: { challenge: challenge(), code: authenticator.generate(SECRET) },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const token = app.jwt.verify<{ role: string; actorType?: string; agencyId?: string }>(body.token)
    expect(token.role).toBe('agency_owner')
    expect(token.role).not.toBe('super_admin')     // jamais d'escalade de privilège
    expect(token.actorType).toBe('agency')
    expect(token.agencyId).toBe(AGENCY_ID)
    expect(body.agencyConfig?.name).toBe('Cabinet Talents CI')
    expect(body.redirectTo).toBe('/agency/dashboard')
  })
})

describe('POST /auth/change-password — compte de cabinet', () => {
  it('change le mot de passe dans agency_users au lieu de repondre 404', async () => {
    const OLD = 'AncienMotDePasse123!'
    queryMock
      .mockResolvedValueOnce({ rows: [{}] })                                   // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })                                     // platform_users : absent
      .mockResolvedValueOnce({ rows: [{ password_hash: bcrypt.hashSync(OLD, 4) }] }) // agency_users
      .mockResolvedValue({ rows: [] })                                         // historique, UPDATE, audits

    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${agencyToken()}` },
      payload: { oldPassword: OLD, newPassword: 'NouveauMotDePasse456!' },
    })

    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find(c => String(c[0]).includes('SET password_hash'))
    expect(String(update?.[0])).toContain('agency_users')
  })
})
