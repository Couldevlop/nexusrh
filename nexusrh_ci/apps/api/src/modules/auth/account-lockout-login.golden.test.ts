/**
 * GOLDEN — Câblage du verrouillage de compte dans /auth/login (OWASP A07).
 *
 * La logique pure (compteurs, seuil, fail-open) est couverte par
 * account-lockout.service.test.ts. Ici on vérifie le CÂBLAGE :
 *   - compte verrouillé → 423 + Retry-After (avant toute vérif d'identifiants) ;
 *   - échec d'identifiants → registerFailure appelé ; verrou atteint → 423 ;
 *   - succès → clearFailures appelé.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore:  {},
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/breach-check.service.js', () => ({
  isPasswordBreached: vi.fn().mockResolvedValue(null),
}))

// Verrouillage piloté par test
const { checkMock, registerMock, clearMock } = vi.hoisted(() => ({
  checkMock: vi.fn(), registerMock: vi.fn(), clearMock: vi.fn(),
}))
vi.mock('../../services/account-lockout.service.js', () => ({
  checkLockout:    checkMock,
  registerFailure: registerMock,
  clearFailures:   clearMock,
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

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  checkMock.mockReset().mockResolvedValue({ locked: false, retryAfterSec: 0 })
  registerMock.mockReset().mockResolvedValue({ locked: false, attempts: 1, retryAfterSec: 0 })
  clearMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /auth/login — verrouillage de compte (OWASP A07)', () => {
  it('compte déjà verrouillé → 423 + Retry-After, sans vérifier les identifiants', async () => {
    checkMock.mockResolvedValue({ locked: true, retryAfterSec: 600 })
    queryMock
      .mockResolvedValueOnce({ rows: [{}] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })   // audit auth.login.locked
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'whatever123' } })
    expect(res.statusCode).toBe(423)
    expect(res.headers['retry-after']).toBe('600')
    expect(JSON.parse(res.body).error).toContain('verrouillé')
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(audit?.[1]?.[1]).toBe('auth.login.locked')
    // Aucune vérification d'identifiants : pas de SELECT platform_users
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('platform_users'))).toBe(false)
  })

  it('mauvais identifiants → registerFailure appelé avec l\'email, 401', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{}] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })   // platform_users vide
      .mockResolvedValueOnce({ rows: [] })   // tenants vide
      .mockResolvedValueOnce({ rows: [] })   // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'ghost@nowhere.ci', password: 'whatever123' } })
    expect(res.statusCode).toBe(401)
    expect(registerMock).toHaveBeenCalledTimes(1)
    expect(registerMock.mock.calls[0][1]).toBe('ghost@nowhere.ci')
    expect(clearMock).not.toHaveBeenCalled()
  })

  it('échec qui ATTEINT le seuil → 423 (verrou déclenché)', async () => {
    registerMock.mockResolvedValue({ locked: true, attempts: 5, retryAfterSec: 900 })
    queryMock
      .mockResolvedValueOnce({ rows: [{}] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })   // platform_users vide
      .mockResolvedValueOnce({ rows: [] })   // tenants vide
      .mockResolvedValueOnce({ rows: [] })   // audit failed
      .mockResolvedValueOnce({ rows: [] })   // audit locked
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'bad' } })
    expect(res.statusCode).toBe(423)
    expect(res.headers['retry-after']).toBe('900')
  })

  it('connexion réussie → clearFailures appelé, registerFailure non', async () => {
    const passwordHash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [{ breach_check_enabled: false, password_max_age_days: 0 }] }) // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] }) // platform_users vide
      .mockResolvedValueOnce({ rows: [{ id: 't1', schema_name: 'tenant_sotra', name: 'Sotra', slug: 'sotra',
        primary_color: '#E85D04', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
        has_subsidiaries: false, payroll_mode: 'monthly', default_country_code: 'CI', mfa_required: false }] }) // tenants
      .mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'admin@sotra.ci', password_hash: passwordHash,
        role: 'admin', first_name: 'A', last_name: 'D', mfa_enabled: false, is_active: true,
        last_login_at: '2024-01-01', password_changed_at: '2026-05-30' }] }) // users
      .mockResolvedValueOnce({ rows: [{ id: 'emp1' }] }) // employees
      .mockResolvedValueOnce({ rows: [] }) // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] }) // audit success
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(200)
    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(clearMock.mock.calls[0][1]).toBe('admin@sotra.ci')
    expect(registerMock).not.toHaveBeenCalled()
  })
})
