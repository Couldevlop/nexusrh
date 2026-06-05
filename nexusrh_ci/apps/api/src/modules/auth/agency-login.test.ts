/**
 * Branche login CABINET de recrutement (platform.agency_users).
 * Ordre : super_admin → tenant → cabinet (le cabinet n'est vérifié que si aucun
 * tenant ne matche, d'où zéro régression sur le chemin tenant nominal).
 *
 * Couvre : succès (claims actorType/agencyId, redirect), cabinet suspendu,
 * user inactif, mauvais mot de passe, et non-régression super_admin.
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
const { checkMock, registerMock, clearMock } = vi.hoisted(() => ({
  checkMock: vi.fn(), registerMock: vi.fn(), clearMock: vi.fn(),
}))
vi.mock('../../services/account-lockout.service.js', () => ({
  checkLockout: checkMock, registerFailure: registerMock, clearFailures: clearMock,
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
const POLICY = { rows: [{ breach_check_enabled: false, password_max_age_days: 0 }] }

function agencyRow(over: Record<string, unknown> = {}) {
  return {
    id: 'au1', email: 'owner@cabinet.ci', password_hash: '', role: 'agency_owner',
    first_name: 'Awa', last_name: 'Koné', mfa_enabled: false, is_active: true,
    password_changed_at: '2026-05-30',
    agency_id: 'ag1', agency_name: 'Cabinet RH CI', agency_status: 'active',
    primary_color: '#1D4ED8', logo_url: 'http://api/public/brand/x', city: 'Abidjan',
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
  checkMock.mockReset().mockResolvedValue({ locked: false, retryAfterSec: 0 })
  registerMock.mockReset().mockResolvedValue({ locked: false, attempts: 1, retryAfterSec: 0 })
  clearMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /auth/login — branche cabinet', () => {
  it('identifiants cabinet valides → 200, contexte cabinet (actorType, schemaName=platform, redirect)', async () => {
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY)                                    // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })                             // platform_users vide
      .mockResolvedValueOnce({ rows: [] })                             // tenants vide (findTenantAndUser)
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash })] }) // findAgencyUser
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] })                             // audit success
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'Cabinet1234!' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.user.actorType).toBe('agency')
    expect(body.user.agencyId).toBe('ag1')
    expect(body.user.schemaName).toBe('platform')
    expect(body.user.role).toBe('agency_owner')
    expect(body.tenantConfig).toBeNull()
    expect(body.agencyConfig.id).toBe('ag1')
    expect(body.redirectTo).toBe('/agency/dashboard')
    expect(clearMock).toHaveBeenCalledTimes(1)
    // Le token porte les claims cabinet
    const decoded = app.jwt.decode(body.token) as Record<string, unknown>
    expect(decoded.actorType).toBe('agency')
    expect(decoded.agencyId).toBe('ag1')
    expect(decoded.schemaName).toBe('platform')
  })

  it('cabinet suspendu + bons identifiants → 503 + message hors-ligne (jamais sans mot de passe valide)', async () => {
    // Contrat « mise hors ligne » : un cabinet suspendu par le super_admin
    // renvoie le message configuré APRÈS vérification du mot de passe (OWASP
    // A07 — pas de fuite d'existence ; pas de compteur de lockout : le mot de
    // passe est correct).
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY)
      .mockResolvedValueOnce({ rows: [] })  // platform_users
      .mockResolvedValueOnce({ rows: [] })  // tenants
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash, agency_status: 'suspended',
        agency_offline_message: 'Cabinet hors service.' })] })
      .mockResolvedValueOnce({ rows: [] })  // audit blocked_offline
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'Cabinet1234!' } })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.offline).toBe(true)
    expect(body.error).toBe('Cabinet hors service.')
    expect(registerMock).not.toHaveBeenCalled()
    expect(clearMock).toHaveBeenCalledTimes(1)
  })

  it('utilisateur cabinet inactif → 401', async () => {
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash, is_active: false })] })
      .mockResolvedValueOnce({ rows: [] })  // tenants suspendus vide (findSuspendedTenantLogin)
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'Cabinet1234!' } })
    expect(res.statusCode).toBe(401)
  })

  it('mauvais mot de passe cabinet → 401 (même si le cabinet est suspendu : pas de fuite)', async () => {
    const hash = await bcrypt.hash('Cabinet1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [agencyRow({ password_hash: hash, agency_status: 'suspended',
        agency_offline_message: 'SECRET — réservé aux identifiants valides.' })] })
      .mockResolvedValueOnce({ rows: [] })  // tenants suspendus vide (findSuspendedTenantLogin)
      .mockResolvedValueOnce({ rows: [] })  // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cabinet.ci', password: 'WRONG_PASSWORD!' } })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain('SECRET')
    expect(registerMock).toHaveBeenCalledTimes(1)
  })

  it('non-régression : super_admin matche AVANT toute recherche cabinet', async () => {
    const hash = await bcrypt.hash('SuperAdmin1234!', 4)
    queryMock
      .mockResolvedValueOnce(POLICY)
      .mockResolvedValueOnce({ rows: [{ id: 'sa1', email: 'super@nexusrh-ci.com', password_hash: hash,
        role: 'super_admin', first_name: 'S', last_name: 'A', mfa_enabled: false, is_active: true,
        password_changed_at: '2026-05-30' }] }) // platform_users
      .mockResolvedValueOnce({ rows: [] }) // UPDATE platform_users
      .mockResolvedValueOnce({ rows: [] }) // audit success
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'super@nexusrh-ci.com', password: 'SuperAdmin1234!' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.user.role).toBe('super_admin')
    expect(body.user.actorType).toBeUndefined()
    // Aucune requête agency_users n'a été émise
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('agency_users'))).toBe(false)
  })
})
