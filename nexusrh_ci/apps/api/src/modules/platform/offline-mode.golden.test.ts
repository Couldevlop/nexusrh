/**
 * GOLDEN — Mise hors ligne d'un tenant / cabinet avec message configurable.
 *
 * Couvre le CÂBLAGE de bout en bout :
 *   - POST /platform/tenants/:id/suspend : message stocké, politique « message
 *     obligatoire » (variable système) respectée, RBAC super_admin, audit ;
 *   - POST /platform/tenants/:id/reactivate : message purgé ;
 *   - POST /agency/agencies/:id/suspend : message + cascade optionnelle sur les
 *     tenants clients (« un cabinet et ses clients hors usage ») ;
 *   - POST /auth/login : identifiants VALIDES sur un tenant/cabinet suspendu →
 *     503 + message configuré (OWASP A07 — jamais révélé sans mot de passe
 *     correct ; mauvais mot de passe → 401 générique) ;
 *   - resolveOfflineMessage : sémantique « obligatoire » (pure).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

const { blacklistMock } = vi.hoisted(() => ({ blacklistMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: blacklistMock,
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore:  {},
}))

vi.mock('../../services/email.js', () => ({
  sendEmployeeWelcomeEmail:   vi.fn().mockResolvedValue(undefined),
  sendWelcomeTenantEmail:     vi.fn().mockResolvedValue(undefined),
  sendWelcomeAgencyEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail:     vi.fn().mockResolvedValue(undefined),
  sendPasswordResetLinkEmail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/breach-check.service.js', () => ({
  isPasswordBreached: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../services/account-lockout.service.js', () => ({
  checkLockout:    vi.fn().mockResolvedValue({ locked: false, retryAfterSec: 0 }),
  registerFailure: vi.fn().mockResolvedValue({ locked: false, attempts: 1, retryAfterSec: 0 }),
  clearFailures:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: vi.fn().mockResolvedValue(undefined),
  seedPayrollRulesCI:    vi.fn().mockResolvedValue(undefined),
  seedAbsenceTypesCI:    vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/tenant-provisioning.service.js', () => ({
  createTenantWithSchema: vi.fn(),
  TenantSlugConflictError: class TenantSlugConflictError extends Error {},
}))

vi.mock('../../services/legislation-packs.js', () => ({
  listLegislationPacks: vi.fn().mockReturnValue([]),
}))

vi.mock('../../services/sourcing-config.service.js', () => ({
  invalidateSourcingConfigCache: vi.fn(),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test', appUrl: 'http://localhost:3001', apiUrl: 'http://localhost:4001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: '' }, smtp: { user: '' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import platformRoutes from './platform.routes.js'
import agencyRoutes from '../agency/agency.routes.js'
import authRoutes from '../auth/auth.routes.js'
import { offlineStatusCache } from '../../cache.js'
import {
  resolveOfflineMessage,
  getTenantOfflineStatus,
  DEFAULT_OFFLINE_MESSAGE,
} from '../../services/offline-status.service.js'

let app: FastifyInstance
const TID = '33333333-3333-3333-3333-333333333333'
const AG  = '11111111-1111-1111-1111-111111111111'

function superToken() {
  return app.jwt.sign({ sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
    email: 'super@ci', firstName: 'S', lastName: 'A', employeeId: null })
}
function tenantAdminToken() {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_x', role: 'admin',
    email: 'a@x.ci', firstName: 'A', lastName: 'D', employeeId: null })
}

// Lignes platform_settings pilotant la politique de message hors-ligne
const POLICY_REQUIRED_WITH_DEFAULT = { offline_message_default: 'Site en maintenance — variable système.', offline_message_required: true }
const POLICY_REQUIRED_NO_DEFAULT   = { offline_message_default: '', offline_message_required: true }
const POLICY_OPTIONAL_NO_DEFAULT   = { offline_message_default: '', offline_message_required: false }

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(platformRoutes, { prefix: '/platform' })
  await app.register(agencyRoutes,   { prefix: '/agency' })
  await app.register(authRoutes,     { prefix: '/auth' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  blacklistMock.mockClear()
  offlineStatusCache.invalidate()
})

// ─── resolveOfflineMessage — sémantique « message obligatoire » (pure) ───────
describe('resolveOfflineMessage', () => {
  it('message fourni → borné à 2000 caractères, prioritaire sur le défaut', () => {
    const m = resolveOfflineMessage('  Fermé pour audit.  ', { defaultMessage: 'Défaut', required: true })
    expect(m).toBe('Fermé pour audit.')
  })
  it('aucun message + défaut présent → variable système utilisée', () => {
    expect(resolveOfflineMessage(undefined, { defaultMessage: 'Défaut', required: true })).toBe('Défaut')
  })
  it('obligatoire + aucun message ni défaut → refus (null)', () => {
    expect(resolveOfflineMessage('', { defaultMessage: '', required: true })).toBeNull()
  })
  it('facultatif + aucun message → chaîne vide (stocké NULL, générique affiché)', () => {
    expect(resolveOfflineMessage(undefined, { defaultMessage: '', required: false })).toBe('')
  })
})

// ─── POST /platform/tenants/:id/suspend ──────────────────────────────────────
describe('POST /platform/tenants/:id/suspend — mise hors ligne avec message', () => {
  it('sans token → 401 ; token tenant admin → 403 (RBAC super_admin)', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`, payload: {} })
    expect(r1.statusCode).toBe(401)
    const r2 = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`,
      headers: { authorization: `Bearer ${tenantAdminToken()}` }, payload: {} })
    expect(r2.statusCode).toBe(403)
  })

  it('message fourni → status=suspended + offline_message stocké + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [POLICY_REQUIRED_WITH_DEFAULT] }) // politique (variable système)
      .mockResolvedValueOnce({ rows: [{ id: TID }] })                  // UPDATE tenants RETURNING
      .mockResolvedValueOnce({ rows: [] })                             // audit
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { message: 'Suspension contractuelle — contactez OpenLab.' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).offlineMessage).toBe('Suspension contractuelle — contactez OpenLab.')
    const update = queryMock.mock.calls.find(c => String(c[0]).includes(`SET status = 'suspended'`))
    expect(update).toBeDefined()
    expect(String(update![0])).toContain('offline_message')
    expect(update![1]).toEqual([TID, 'Suspension contractuelle — contactez OpenLab.'])
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(audit?.[1]?.[1]).toBe('tenant.suspend')
  })

  it('aucun message → la variable système (défaut) est utilisée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [POLICY_REQUIRED_WITH_DEFAULT] })
      .mockResolvedValueOnce({ rows: [{ id: TID }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).offlineMessage).toBe('Site en maintenance — variable système.')
  })

  it('message obligatoire + variable système vide + aucun message → 400, pas d\'UPDATE', async () => {
    queryMock.mockResolvedValueOnce({ rows: [POLICY_REQUIRED_NO_DEFAULT] })
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('obligatoire')
    expect(queryMock.mock.calls.some(c => String(c[0]).includes(`SET status = 'suspended'`))).toBe(false)
  })

  it('message facultatif + vide → 200, offline_message NULL', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [POLICY_OPTIONAL_NO_DEFAULT] })
      .mockResolvedValueOnce({ rows: [{ id: TID }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find(c => String(c[0]).includes(`SET status = 'suspended'`))
    expect(update![1]).toEqual([TID, null])
  })

  it('reactivate → status=active + offline_message purgé', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: TID }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] })            // audit
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reactivate`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(200)
    const update = queryMock.mock.calls.find(c => String(c[0]).includes(`SET status = 'active'`))
    expect(String(update![0])).toContain('offline_message = NULL')
  })
})

// ─── POST /agency/agencies/:id/suspend — cabinet (et ses clients) ────────────
describe('POST /agency/agencies/:id/suspend — cabinet hors usage', () => {
  it('avec includeClients → cabinet + tenants clients suspendus, même message', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [POLICY_REQUIRED_WITH_DEFAULT] })          // politique
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                            // UPDATE agencies
      .mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] })            // cascade tenants
      .mockResolvedValueOnce({ rows: [{ id: 'au1' }, { id: 'au2' }] })          // membres
      .mockResolvedValueOnce({ rows: [] })                                      // audit
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { message: 'Cabinet fermé temporairement.', includeClients: true } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.clientsSuspended).toBe(2)
    expect(body.data.offlineMessage).toBe('Cabinet fermé temporairement.')
    const cascade = queryMock.mock.calls.find(c => String(c[0]).includes('agency_tenants'))
    expect(cascade).toBeDefined()
    expect(cascade![1]).toEqual([AG, 'Cabinet fermé temporairement.'])
    // Sessions des membres révoquées immédiatement
    expect(blacklistMock).toHaveBeenCalledTimes(2)
  })

  it('sans includeClients → aucun tenant client touché', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [POLICY_REQUIRED_WITH_DEFAULT] })
      .mockResolvedValueOnce({ rows: [{ id: AG }] })
      .mockResolvedValueOnce({ rows: [] })  // membres
      .mockResolvedValueOnce({ rows: [] })  // audit
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { message: 'Fermé.' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.clientsSuspended).toBe(0)
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('agency_tenants'))).toBe(false)
  })

  it('message obligatoire + rien de disponible → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [POLICY_REQUIRED_NO_DEFAULT] })
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('reactivate avec includeClients → cabinet + clients réactivés, messages purgés', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                 // UPDATE agencies
      .mockResolvedValueOnce({ rows: [{ id: 't1' }] })               // cascade clients
      .mockResolvedValueOnce({ rows: [] })                           // audit
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/reactivate`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { includeClients: true } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.clientsReactivated).toBe(1)
    const update = queryMock.mock.calls.find(c => String(c[0]).includes(`agencies SET status='active'`))
    expect(String(update![0])).toContain('offline_message=NULL')
  })
})

// ─── POST /auth/login — tenant / cabinet hors ligne ─────────────────────────
describe('POST /auth/login — accès à un tenant/cabinet hors ligne', () => {
  const SETTINGS_ROW = { breach_check_enabled: false, password_max_age_days: 0 }

  it('identifiants VALIDES sur un tenant suspendu → 503 + message configuré', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [SETTINGS_ROW] })  // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })              // platform_users
      .mockResolvedValueOnce({ rows: [] })              // tenants actifs (findTenantAndUser)
      .mockResolvedValueOnce({ rows: [] })              // agency_users (findAgencyUser)
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra', offline_message: 'SOTRA est suspendu — contactez la plateforme.' }] }) // tenants suspendus
      .mockResolvedValueOnce({ rows: [{ id: 'u1', password_hash: hash, is_active: true }] })      // user du tenant suspendu
      .mockResolvedValueOnce({ rows: [] })              // audit blocked_offline
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.offline).toBe(true)
    expect(body.error).toBe('SOTRA est suspendu — contactez la plateforme.')
  })

  it('mot de passe INCORRECT sur un tenant suspendu → 401 générique (pas de fuite du message)', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [SETTINGS_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra', offline_message: 'SECRET — ne pas divulguer.' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1', password_hash: hash, is_active: true }] })
      .mockResolvedValueOnce({ rows: [] })              // audit failed
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'admin@sotra.ci', password: 'MauvaisMdp123!' } })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain('SECRET')
  })

  it('identifiants VALIDES sur un cabinet suspendu → 503 + message du cabinet', async () => {
    const hash = await bcrypt.hash('Admin1234!', 4)
    queryMock
      .mockResolvedValueOnce({ rows: [SETTINGS_ROW] })  // getSecurityPolicy
      .mockResolvedValueOnce({ rows: [] })              // platform_users
      .mockResolvedValueOnce({ rows: [] })              // tenants actifs
      .mockResolvedValueOnce({ rows: [{                 // agency_users + agencies
        id: 'au1', email: 'owner@cab.ci', password_hash: hash, role: 'agency_owner',
        first_name: 'A', last_name: 'K', mfa_enabled: false, is_active: true,
        password_changed_at: '2026-06-01', agency_id: AG, agency_name: 'Cabinet Talents',
        agency_status: 'suspended', agency_offline_message: 'Cabinet hors service jusqu\'à nouvel ordre.',
        primary_color: null, logo_url: null, city: 'Abidjan',
      }] })
      .mockResolvedValueOnce({ rows: [] })              // audit blocked_offline
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { email: 'owner@cab.ci', password: 'Admin1234!' } })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.offline).toBe(true)
    expect(body.error).toBe('Cabinet hors service jusqu\'à nouvel ordre.')
  })
})

// ─── Service — statut hors-ligne + cache 30 s ────────────────────────────────
describe('getTenantOfflineStatus — cache', () => {
  it('statut suspendu + message lus en DB, puis servis depuis le cache (1 seule requête)', async () => {
    const pool = { query: queryMock } as unknown as import('pg').Pool
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'suspended', offline_message: 'Hors ligne.' }] })
    const s1 = await getTenantOfflineStatus(pool, 'tenant_sotra')
    expect(s1).toEqual({ offline: true, message: 'Hors ligne.' })
    const callsAfterFirst = queryMock.mock.calls.length
    const s2 = await getTenantOfflineStatus(pool, 'tenant_sotra')
    expect(s2).toEqual(s1)
    expect(queryMock.mock.calls.length).toBe(callsAfterFirst) // cache hit
  })
  it('tenant inconnu → pas hors ligne (fail-open)', async () => {
    const pool = { query: queryMock } as unknown as import('pg').Pool
    queryMock.mockResolvedValueOnce({ rows: [] })
    const s = await getTenantOfflineStatus(pool, 'tenant_ghost')
    expect(s.offline).toBe(false)
  })
  it('message vide → le générique est utilisé à l\'affichage', () => {
    expect(DEFAULT_OFFLINE_MESSAGE.length).toBeGreaterThan(10)
  })
})
