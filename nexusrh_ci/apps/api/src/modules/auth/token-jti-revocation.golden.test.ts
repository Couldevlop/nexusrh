/**
 * OWASP A07-4 — la blacklist de logout doit être PAR TOKEN (`jti`), pas par
 * utilisateur (`sub`).
 *
 * Avant correctif : aucun `sign()` ne posait de `jti`, donc `plugins/auth.ts` et
 * `POST /auth/logout` retombaient sur `jti ?? sub` → `blacklistTokenSafe(sub)`
 * blacklistait l'UTILISATEUR entier pour la TTL du token (jusqu'à 7 j) :
 *   (a) un logout tuait toutes les sessions/devices de l'utilisateur ;
 *   (b) le token émis par le login SUIVANT était immédiatement « Token révoqué »
 *       → self-lockout jusqu'à 7 jours ;
 *   (c) un attaquant avec un token volé pouvait lock la victime via /auth/logout.
 *
 * Ces tests utilisent une blacklist Redis EN MÉMOIRE (pas un vi.fn() muet) afin
 * que le lockout soit réellement reproduit de bout en bout.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

// Blacklist + époque de token EN MÉMOIRE (comportement Redis réel simulé).
const { blacklistStore, epochStore, setTokenEpochMock } = vi.hoisted(() => {
  const blacklistStore = new Map<string, number>()
  const epochStore = new Map<string, number>()
  return {
    blacklistStore, epochStore,
    setTokenEpochMock: vi.fn(async (userId: string) => {
      epochStore.set(userId, Math.floor(Date.now() / 1000))
    }),
  }
})

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn(async (jti: string, ttl: number) => { blacklistStore.set(jti, ttl) }),
  blacklistTokenSafe: vi.fn(async (jti: string, ttl: number) => { blacklistStore.set(jti, ttl) }),
  isTokenBlacklisted: vi.fn(async (jti: string) => blacklistStore.has(jti)),
  redisLockoutStore:  {},
  setTokenEpoch:      setTokenEpochMock,
  getTokenEpoch:      vi.fn(async (userId: string) => epochStore.get(userId) ?? 0),
}))

// Pas de persistance de refresh token dans ces tests (on cible le JWT).
vi.mock('../../services/refresh-token.service.js', () => ({
  issueRefreshToken:             vi.fn().mockResolvedValue('rt-' + 'x'.repeat(40)),
  consumeRefreshToken:           vi.fn().mockResolvedValue(null),
  revokeRefreshToken:            vi.fn().mockResolvedValue(undefined),
  revokeAllRefreshTokensForUser: vi.fn().mockResolvedValue(undefined),
  verifyAccountActive:           vi.fn().mockResolvedValue({ role: 'admin', passwordChangedAt: '2024-01-01' }),
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
  },
}))

vi.mock('../../services/breach-check.service.js', () => ({
  isPasswordBreached: vi.fn().mockResolvedValue(null),
}))

import authPlugin from '../../plugins/auth.js'
import authRoutes from './auth.routes.js'

let app: FastifyInstance
const PASSWORD = 'Admin1234!'

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  // Route applicative protégée : sert de sonde « ce token est-il accepté ? »
  app.get('/protected', { preHandler: [app.authenticate] }, async () => ({ ok: true }))
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  blacklistStore.clear()
  epochStore.clear()
  setTokenEpochMock.mockClear()
})

/** Empile les réponses DB d'un login tenant nominal (cf. auth.routes.test.ts). */
async function mockTenantLogin(): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  queryMock
    .mockResolvedValueOnce({ rows: [{ breach_check_enabled: false, password_max_age_days: 0 }] }) // getSecurityPolicy
    .mockResolvedValueOnce({ rows: [] })  // platform_users
    .mockResolvedValueOnce({ rows: [{
      id: 't1', schema_name: 'tenant_sotra', name: 'Sotra', slug: 'sotra',
      primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
      has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CI', mfa_required: false,
    }] })                                  // tenants
    .mockResolvedValueOnce({ rows: [{
      id: 'u1', email: 'admin@sotra.ci', password_hash: passwordHash, role: 'admin',
      first_name: 'A', last_name: 'D', mfa_enabled: false, is_active: true,
      last_login_at: '2024-01-01', password_changed_at: '2024-01-01',
    }] })                                  // users
    .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] }) // employees
    .mockResolvedValueOnce({ rows: [] })   // UPDATE last_login_at
    .mockResolvedValueOnce({ rows: [] })   // audit_log
}

async function login(): Promise<string> {
  await mockTenantLogin()
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'admin@sotra.ci', password: PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).token as string
}

async function logout(token: string): Promise<void> {
  queryMock.mockResolvedValue({ rows: [] }) // audit_log
  const res = await app.inject({
    method: 'POST', url: '/auth/logout',
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.statusCode).toBe(200)
}

function probe(token: string) {
  return app.inject({ method: 'GET', url: '/protected', headers: { authorization: `Bearer ${token}` } })
}

describe('A07-4 — chaque token signé porte un `jti` unique', () => {
  it('le token de login porte un jti (UUID) distinct du sub', async () => {
    const token = await login()
    const decoded = app.jwt.decode<Record<string, unknown>>(token)!
    expect(typeof decoded['jti']).toBe('string')
    expect(decoded['jti']).not.toBe(decoded['sub'])
    expect(decoded['jti']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('deux logins successifs produisent deux jti différents', async () => {
    const a = app.jwt.decode<Record<string, unknown>>(await login())!
    const b = app.jwt.decode<Record<string, unknown>>(await login())!
    expect(a['jti']).not.toBe(b['jti'])
  })

  it('le token CSRF et le token de refresh portent aussi un jti', async () => {
    const token = await login()
    queryMock.mockResolvedValue({ rows: [] })
    const csrf = await app.inject({
      method: 'GET', url: '/auth/csrf-token', headers: { authorization: `Bearer ${token}` },
    })
    expect(csrf.statusCode).toBe(200)
    expect(app.jwt.decode<Record<string, unknown>>(JSON.parse(csrf.body).csrfToken)!['jti']).toBeTypeOf('string')

    const refreshed = await app.inject({
      method: 'POST', url: '/auth/refresh', headers: { authorization: `Bearer ${token}` },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(app.jwt.decode<Record<string, unknown>>(JSON.parse(refreshed.body).token)!['jti']).toBeTypeOf('string')
  })
})

describe('A07-4 — le logout est PAR TOKEN, pas par utilisateur', () => {
  it('RÉGRESSION lockout : logout puis nouveau login → le NOUVEAU token est accepté', async () => {
    const first = await login()
    await logout(first)

    const second = await login()
    const res = await probe(second)

    // Avant correctif : 401 « Token révoqué » (le sub entier était blacklisté).
    expect(res.statusCode).toBe(200)
  })

  it('le token déconnecté reste, lui, bel et bien révoqué', async () => {
    const token = await login()
    await logout(token)
    const res = await probe(token)
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('Token révoqué')
  })

  it('logout sur un device ne tue pas la session de l\'autre device', async () => {
    const deviceA = await login()
    const deviceB = await login()
    await logout(deviceA)

    expect((await probe(deviceA)).statusCode).toBe(401)
    expect((await probe(deviceB)).statusCode).toBe(200)
  })

  it('la clé blacklistée est le jti du token, pas le sub', async () => {
    const token = await login()
    const decoded = app.jwt.decode<Record<string, unknown>>(token)!
    await logout(token)
    expect(blacklistStore.has(decoded['jti'] as string)).toBe(true)
    expect(blacklistStore.has('u1')).toBe(false)
  })

  it('RÉTRO-COMPAT : un token LEGACY sans jti reste révocable (fallback sur le sub)', async () => {
    // Token déjà en circulation, émis avant le correctif (aucun jti).
    const legacy = app.jwt.sign({
      sub: 'u-legacy', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
      email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    expect(app.jwt.decode<Record<string, unknown>>(legacy)!['jti']).toBeUndefined()

    expect((await probe(legacy)).statusCode).toBe(200)
    await logout(legacy)
    expect(blacklistStore.has('u-legacy')).toBe(true)
    expect((await probe(legacy)).statusCode).toBe(401)
  })
})

describe('A07-4 — non-régression : l\'époque de token reste la révocation GLOBALE', () => {
  it('change-password pose une nouvelle époque pour l\'utilisateur', async () => {
    const correctOldHash = await bcrypt.hash('CorrectOld', 4)
    const token = await login()
    queryMock.mockReset()
    queryMock
      .mockResolvedValueOnce({ rows: [{ password_history_count: 0, breach_check_enabled: false }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [{ password_hash: correctOldHash }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const res = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'CorrectOld', newPassword: 'NewSecret123' },
    })
    expect(res.statusCode).toBe(200)
    expect(setTokenEpochMock).toHaveBeenCalledWith('u1')
  })

  it('l\'époque révoque TOUS les tokens de l\'utilisateur, jti ou pas (deux devices d\'un coup)', async () => {
    const deviceA = await login()
    const deviceB = await login()
    expect((await probe(deviceA)).statusCode).toBe(200)
    expect((await probe(deviceB)).statusCode).toBe(200)

    // Époque postérieure aux deux tokens (iat < epoch) — cas d'un changement de
    // mot de passe / de rôle survenu APRÈS leur émission. On part du iat le plus
    // récent : les deux logins ne tombent pas forcément sur la même seconde.
    const iats = [deviceA, deviceB].map(t => app.jwt.decode<{ iat: number }>(t)!.iat)
    epochStore.set('u1', Math.max(...iats) + 1)

    for (const t of [deviceA, deviceB]) {
      const res = await probe(t)
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body).error).toBe('Session invalidée — reconnectez-vous')
    }
  })

  it('un token émis APRÈS l\'époque reste valide (le jti ne remplace pas l\'époque)', async () => {
    epochStore.set('u1', Math.floor(Date.now() / 1000) - 60)
    const fresh = await login()
    expect((await probe(fresh)).statusCode).toBe(200)
  })
})
