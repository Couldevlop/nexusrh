/**
 * COUVERTURE — Routes du portail super_admin (platform.routes.ts).
 *
 * Cible : tous les endpoints /platform/* non couverts par les tests existants
 * (legal-watch, offline-mode golden) : liste/détail/CRUD tenants, création avec
 * provisionnement mocké, reset-admin (nominal + mode réparation + diagnostics),
 * admin-status, settings (lecture/écriture + auto-création table), logs,
 * legal-constants, country-configs, dashboard, et l'intégralité du sous-module
 * Sourcing IA (modèles, plateformes, settings). RBAC super_admin systématique.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore: {},
}))

const { provisionMock, seedRulesMock, seedAbsenceMock } = vi.hoisted(() => ({
  provisionMock: vi.fn().mockResolvedValue(undefined),
  seedRulesMock: vi.fn().mockResolvedValue(undefined),
  seedAbsenceMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../db/provisioning.js', () => ({
  provisionTenantSchema: provisionMock,
  seedPayrollRulesCI: seedRulesMock,
  seedAbsenceTypesCI: seedAbsenceMock,
}))

const { createTenantMock } = vi.hoisted(() => ({ createTenantMock: vi.fn() }))
vi.mock('../../services/tenant-provisioning.service.js', () => ({
  createTenantWithSchema: createTenantMock,
  TenantSlugConflictError: class TenantSlugConflictError extends Error {},
  PLAN_DEFAULTS: {
    trial:         { maxUsers: 10,   maxEmployees: 20  },
    starter:       { maxUsers: 30,   maxEmployees: 30  },
    business:      { maxUsers: 100,  maxEmployees: 150 },
    enterprise:    { maxUsers: 9999, maxEmployees: 9999 },
    public_sector: { maxUsers: 200,  maxEmployees: 500 },
  },
}))

const { sendResetEmailMock } = vi.hoisted(() => ({ sendResetEmailMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({
  sendPasswordResetEmail: sendResetEmailMock,
}))

vi.mock('../../services/legislation-packs.js', () => ({
  listLegislationPacks: vi.fn().mockReturnValue([{ code: 'CIV-2024', status: 'active' }]),
}))

const { invalidateConfigMock } = vi.hoisted(() => ({ invalidateConfigMock: vi.fn() }))
vi.mock('../../services/sourcing-config.service.js', () => ({
  invalidateSourcingConfigCache: invalidateConfigMock,
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
import { offlineStatusCache } from '../../cache.js'
import { TenantSlugConflictError } from '../../services/tenant-provisioning.service.js'

let app: FastifyInstance
const TID = '33333333-3333-3333-3333-333333333333'
const MID = '44444444-4444-4444-4444-444444444444'

function superToken() {
  return app.jwt.sign({ sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
    email: 'super@ci', firstName: 'S', lastName: 'A', employeeId: null })
}
function adminToken() {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_x', role: 'admin',
    email: 'a@x.ci', firstName: 'A', lastName: 'D', employeeId: null })
}
function hrManagerToken() {
  return app.jwt.sign({ sub: 'u2', tenantId: 't1', schemaName: 'tenant_x', role: 'hr_manager',
    email: 'rh@x.ci', firstName: 'R', lastName: 'H', employeeId: null })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(platformRoutes, { prefix: '/platform' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  provisionMock.mockClear().mockResolvedValue(undefined)
  seedRulesMock.mockClear().mockResolvedValue(undefined)
  seedAbsenceMock.mockClear().mockResolvedValue(undefined)
  createTenantMock.mockReset()
  sendResetEmailMock.mockClear().mockResolvedValue(undefined)
  invalidateConfigMock.mockClear()
  offlineStatusCache.invalidate()
})

const hSuper = () => ({ authorization: `Bearer ${superToken()}` })
const hAdmin = () => ({ authorization: `Bearer ${adminToken()}` })

// ─── GET /platform/legislation-packs ─────────────────────────────────────────
describe('GET /platform/legislation-packs', () => {
  it('super_admin → 200 + liste', async () => {
    const res = await app.inject({ method: 'GET', url: '/platform/legislation-packs', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/platform/legislation-packs' })
    expect(res.statusCode).toBe(401)
  })
  it('rôle admin tenant → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/platform/legislation-packs', headers: hAdmin() })
    expect(res.statusCode).toBe(403)
  })
})

// ─── GET /platform/tenants ───────────────────────────────────────────────────
describe('GET /platform/tenants', () => {
  it('liste paginée → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: TID, name: 'SOTRA' }] }) // select tenants
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })            // count
    const res = await app.inject({ method: 'GET', url: '/platform/tenants', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(1)
    expect(body.page).toBe(1)
  })
  it('filtre status valide → ajoute WHERE', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/tenants?status=active&page=2&limit=10', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const selectCall = queryMock.mock.calls.find(c => String(c[0]).includes('FROM platform.tenants t'))
    expect(String(selectCall![0])).toContain('WHERE t.status = $3')
  })
  it('status invalide → ignoré (pas de WHERE)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/tenants?status=hacker', headers: hSuper() })
    expect(res.statusCode).toBe(200)
  })
  it('première requête échoue → repli sans WHERE', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('column t.status'))  // select avec t.*
      .mockResolvedValueOnce({ rows: [{ id: TID }] })       // repli select
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })    // count
    const res = await app.inject({ method: 'GET', url: '/platform/tenants?status=active', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).total).toBe(1)
  })
  it('admin tenant → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/platform/tenants', headers: hAdmin() })
    expect(res.statusCode).toBe(403)
  })
})

// ─── GET /platform/tenants/:id ───────────────────────────────────────────────
describe('GET /platform/tenants/:id', () => {
  it('trouvé → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: TID, name: 'SOTRA' }] })
    const res = await app.inject({ method: 'GET', url: `/platform/tenants/${TID}`, headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.id).toBe(TID)
  })
  it('introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/platform/tenants/${TID}`, headers: hSuper() })
    expect(res.statusCode).toBe(404)
  })
})

// ─── POST /platform/tenants ──────────────────────────────────────────────────
describe('POST /platform/tenants', () => {
  const VALID = { name: 'NewCo', slug: 'newco', adminEmail: 'admin@newco.ci' }

  it('création réussie → 201 + tempPassword + audit', async () => {
    createTenantMock.mockResolvedValue({
      id: TID, slug: 'newco', schemaName: 'tenant_newco', planType: 'trial', tempPassword: 'CI_X!',
    })
    const res = await app.inject({ method: 'POST', url: '/platform/tenants', headers: hSuper(), payload: VALID })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.tempPassword).toBe('CI_X!')
    expect(body.data.id).toBe(TID)
    expect(createTenantMock).toHaveBeenCalledTimes(1)
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(audit?.[1]?.[1]).toBe('tenant.created')
  })
  it('validation échouée (email invalide) → 400 + issues', async () => {
    const res = await app.inject({ method: 'POST', url: '/platform/tenants', headers: hSuper(),
      payload: { name: 'X', slug: 'x', adminEmail: 'pas-un-email' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).issues.length).toBeGreaterThan(0)
    expect(createTenantMock).not.toHaveBeenCalled()
  })
  it('slug déjà pris → 409', async () => {
    createTenantMock.mockRejectedValue(new TenantSlugConflictError('Slug "newco" déjà utilisé'))
    const res = await app.inject({ method: 'POST', url: '/platform/tenants', headers: hSuper(), payload: VALID })
    expect(res.statusCode).toBe(409)
  })
  it('erreur de provisionnement non-slug → propagée (500)', async () => {
    createTenantMock.mockRejectedValue(new Error('boom provision'))
    const res = await app.inject({ method: 'POST', url: '/platform/tenants', headers: hSuper(), payload: VALID })
    expect(res.statusCode).toBe(500)
  })
  it('admin tenant → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/platform/tenants', headers: hAdmin(), payload: VALID })
    expect(res.statusCode).toBe(403)
  })
})

// ─── PATCH /platform/tenants/:id ─────────────────────────────────────────────
describe('PATCH /platform/tenants/:id', () => {
  it('id non-UUID → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/platform/tenants/not-a-uuid', headers: hSuper(),
      payload: { name: 'X' } })
    expect(res.statusCode).toBe(400)
  })
  it('aucun champ valide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/platform/tenants/${TID}`, headers: hSuper(),
      payload: { champ_inconnu: 'x' } })
    expect(res.statusCode).toBe(400)
  })
  it('mise à jour simple → 200 + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                                  // UPDATE
      .mockResolvedValueOnce({ rows: [] })                                  // audit
      .mockResolvedValueOnce({ rows: [{ id: TID, name: 'Renommé' }] })      // SELECT
    const res = await app.inject({ method: 'PATCH', url: `/platform/tenants/${TID}`, headers: hSuper(),
      payload: { name: 'Renommé', status: 'suspended', plan_type: 'business', mfa_required: 'true' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.name).toBe('Renommé')
    const update = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE platform.tenants SET'))
    expect(String(update![0])).toContain('mfa_required')
  })
  it('has_subsidiaries=true → (re)provisionne le schéma avant bascule', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_newco' }] }) // SELECT schema_name
      .mockResolvedValueOnce({ rows: [] })                                // audit subsidiaries_enabled
      .mockResolvedValueOnce({ rows: [] })                                // UPDATE
      .mockResolvedValueOnce({ rows: [] })                                // audit updated
      .mockResolvedValueOnce({ rows: [{ id: TID }] })                     // SELECT final
    const res = await app.inject({ method: 'PATCH', url: `/platform/tenants/${TID}`, headers: hSuper(),
      payload: { has_subsidiaries: true } })
    expect(res.statusCode).toBe(200)
    expect(provisionMock).toHaveBeenCalledWith('tenant_newco')
  })
  it('has_subsidiaries=true + schema_name absent → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: null }] })
    const res = await app.inject({ method: 'PATCH', url: `/platform/tenants/${TID}`, headers: hSuper(),
      payload: { has_subsidiaries: true } })
    expect(res.statusCode).toBe(409)
  })
  it('has_subsidiaries=true + échec provisionnement → 500', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_newco' }] })
    provisionMock.mockRejectedValueOnce(new Error('migration failed'))
    const res = await app.inject({ method: 'PATCH', url: `/platform/tenants/${TID}`, headers: hSuper(),
      payload: { has_subsidiaries: true } })
    expect(res.statusCode).toBe(500)
  })
})

// ─── POST /platform/tenants/:id/suspend (compléments non couverts ailleurs) ──
describe('POST /platform/tenants/:id/suspend — compléments couverture', () => {
  it('message non conforme (> 2000 caractères) → 400', async () => {
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`, headers: hSuper(),
      payload: { message: 'x'.repeat(2001) } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('invalide')
  })
  it('UPDATE avec offline_message échoue → repli pré-migration, 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ offline_message_default: 'Défaut système.', offline_message_required: true }] }) // politique
      .mockRejectedValueOnce(new Error('column offline_message')) // UPDATE principal échoue
      .mockResolvedValueOnce({ rows: [{ id: TID }] })             // repli UPDATE
      .mockResolvedValueOnce({ rows: [] })                        // audit
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`, headers: hSuper(),
      payload: { message: 'Maintenance.' } })
    expect(res.statusCode).toBe(200)
  })
  it('tenant introuvable (repli renvoie 0 ligne) → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ offline_message_default: 'Défaut.', offline_message_required: true }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE RETURNING vide
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/suspend`, headers: hSuper(),
      payload: { message: 'Maintenance.' } })
    expect(res.statusCode).toBe(404)
  })
})

// ─── POST /platform/tenants/:id/reactivate ───────────────────────────────────
describe('POST /platform/tenants/:id/reactivate', () => {
  it('nominal → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reactivate`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(200)
  })
  it('UPDATE principal échoue → repli pré-migration, 200', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('column offline_message'))
      .mockResolvedValueOnce({ rows: [] }) // repli UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reactivate`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(200)
  })
})

// ─── POST /platform/tenants/:id/reset-admin ──────────────────────────────────
describe('POST /platform/tenants/:id/reset-admin', () => {
  const TENANT_ROW = {
    schema_name: 'tenant_newco', name: 'NewCo', slug: 'newco', at_rate: '0.03',
    primary_color: '#E85D04', city: 'Abidjan',
  }

  it('tenant introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT tenant
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(404)
  })

  it('cas nominal : admin existant → reset password + email', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT_ROW] })                       // SELECT tenant
      .mockResolvedValueOnce({ rows: [{ exists: true }] })                 // schema exists
      .mockResolvedValueOnce({ rows: [{ id: 'adm1', email: 'admin@newco.ci' }] }) // admin
      .mockResolvedValueOnce({ rows: [] })                                 // UPDATE password
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.adminEmail).toBe('admin@newco.ci')
    expect(body.tempPassword).toMatch(/^CI_.+!$/)
    expect(sendResetEmailMock).toHaveBeenCalledTimes(1)
  })

  it('schema_name absent + pas de mode réparation → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...TENANT_ROW, schema_name: null }] })
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(409)
  })

  it('schéma absent en base + pas de réparation → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT_ROW] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // schema absent
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(409)
  })

  it('admin absent + pas de réparation → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT_ROW] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] }) // pas d'admin
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(409)
  })

  it('mode réparation complet : schema_name vide + schéma absent + admin créé → 200 repaired', async () => {
    const repairBody = { adminEmail: 'NewAdmin@newco.ci', firstName: 'New', lastName: 'Admin' }
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...TENANT_ROW, schema_name: null }] }) // SELECT tenant
      .mockResolvedValueOnce({ rows: [] })                                     // UPDATE schema_name réparé
      .mockResolvedValueOnce({ rows: [{ exists: false }] })                    // schema absent
      .mockResolvedValueOnce({ rows: [] })                                     // SELECT admin (absent)
      .mockResolvedValueOnce({ rows: [{ id: 'new1', email: 'newadmin@newco.ci' }] }) // INSERT admin
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: repairBody })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.repaired).toBe(true)
    expect(provisionMock).toHaveBeenCalled()
    expect(seedRulesMock).toHaveBeenCalled()
    expect(seedAbsenceMock).toHaveBeenCalled()
    expect(sendResetEmailMock).toHaveBeenCalledTimes(1)
  })

  it('erreur interne (SELECT tenant rejette) → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({ method: 'POST', url: `/platform/tenants/${TID}/reset-admin`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(500)
  })
})

// ─── GET /platform/tenants/:id/admin-status ──────────────────────────────────
describe('GET /platform/tenants/:id/admin-status', () => {
  it('tenant introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/platform/tenants/${TID}/admin-status`, headers: hSuper() })
    expect(res.statusCode).toBe(404)
  })
  it('schéma présent → schemaExists true + adminUser', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_newco', name: 'NewCo' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'adm1', email: 'a@newco.ci', is_active: true, has_hash: true }] })
    const res = await app.inject({ method: 'GET', url: `/platform/tenants/${TID}/admin-status`, headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.schemaExists).toBe(true)
    expect(body.adminUser.email).toBe('a@newco.ci')
  })
  it('schéma absent (query échoue) → schemaExists false', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_ghost', name: 'Ghost' }] })
      .mockRejectedValueOnce(new Error('relation does not exist'))
    const res = await app.inject({ method: 'GET', url: `/platform/tenants/${TID}/admin-status`, headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).schemaExists).toBe(false)
  })
})

// ─── GET /platform/settings ──────────────────────────────────────────────────
describe('GET /platform/settings', () => {
  it('table existante → 200 + flags dérivés', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ app_name: 'NexusRH CI', maintenance_mode: false }] })
    const res = await app.inject({ method: 'GET', url: '/platform/settings', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.version).toBe('1.0.0')
    expect(body.data.aiConfigured).toBe(false)
    expect(body.data.smtpConfigured).toBe(false)
  })
  it('table absente → auto-création + insert + relecture', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('relation platform.platform_settings does not exist')) // SELECT initial
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // INSERT DEFAULT
      .mockResolvedValueOnce({ rows: [{ app_name: 'NexusRH CI' }] }) // relecture
    const res = await app.inject({ method: 'GET', url: '/platform/settings', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.app_name).toBe('NexusRH CI')
  })
})

// ─── PATCH /platform/settings ────────────────────────────────────────────────
describe('PATCH /platform/settings', () => {
  it('aucun champ valide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/platform/settings', headers: hSuper(),
      payload: { champ_inconnu: 1 } })
    expect(res.statusCode).toBe(400)
  })
  it('coercition booléens/ints/texte + maintenance_mode invalide le cache → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // INSERT singleton ON CONFLICT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
    const res = await app.inject({ method: 'PATCH', url: '/platform/settings', headers: hSuper(),
      payload: {
        maintenance_mode: 'true',
        password_max_age_days: '5000',         // borné à 3650
        password_history_count: 999,           // borné à 50
        max_tenants: '42',
        default_trial_days: -1,                // négatif → ignoré
        offline_message_default: 'x'.repeat(3000), // borné à 2000
        offline_message_required: 0,
      } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).success).toBe(true)
    const update = queryMock.mock.calls.find(c => String(c[0]).includes('UPDATE platform.platform_settings SET'))
    expect(update).toBeDefined()
    const vals = update![1] as unknown[]
    expect(vals).toContain(3650)        // password_max_age_days borné
    expect(vals).toContain(50)          // password_history_count borné
    expect(vals.some(v => typeof v === 'string' && v.length === 2000)).toBe(true) // offline message borné
  })
  it('INSERT singleton échoue → repli DEFAULT VALUES, 200', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('no singleton column')) // INSERT (singleton)
      .mockResolvedValueOnce({ rows: [] })                     // repli INSERT DEFAULT VALUES
      .mockResolvedValueOnce({ rows: [] })                     // UPDATE
    const res = await app.inject({ method: 'PATCH', url: '/platform/settings', headers: hSuper(),
      payload: { app_name: 'Nouveau Nom' } })
    expect(res.statusCode).toBe(200)
  })
})

// ─── GET /platform/logs ──────────────────────────────────────────────────────
describe('GET /platform/logs', () => {
  it('sans filtre → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'l1', action: 'tenant.created' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/logs', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
  it('filtre tenant_id → ajoute la clause', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/platform/logs?tenant_id=${TID}&limit=5`, headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('al.tenant_id =')
  })
  it('requête échoue → 200 avec data vide', async () => {
    queryMock.mockRejectedValueOnce(new Error('no audit_log'))
    const res = await app.inject({ method: 'GET', url: '/platform/logs', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
})

// ─── GET /platform/legal-constants ───────────────────────────────────────────
describe('GET /platform/legal-constants', () => {
  it('création table + seed + lecture → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // INSERT seed CI
      .mockResolvedValueOnce({ rows: [{ country: 'CI', version: '2024' }] }) // SELECT
    const res = await app.inject({ method: 'GET', url: '/platform/legal-constants', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
  it('SELECT échoue → data vide (catch)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('select failed'))
    const res = await app.inject({ method: 'GET', url: '/platform/legal-constants', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
})

// ─── PATCH /platform/legal-constants/:country/:version ────────────────────────
describe('PATCH /platform/legal-constants/:country/:version', () => {
  it('constants manquant → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/platform/legal-constants/CI/2024', headers: hSuper(),
      payload: { notes: 'x' } })
    expect(res.statusCode).toBe(400)
  })
  it('constants tableau (invalide) → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/platform/legal-constants/CI/2024', headers: hSuper(),
      payload: { constants: [1, 2] } })
    expect(res.statusCode).toBe(400)
  })
  it('mise à jour avec SMIG → upsert + audit, 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // upsert constants
      .mockResolvedValueOnce({ rows: [] }) // audit LEGAL_UPDATE
    const res = await app.inject({ method: 'PATCH', url: '/platform/legal-constants/CI/2024', headers: hSuper(),
      payload: { constants: { SMIG_MENSUEL: 80000 }, notes: 'MAJ', effective: '2024-06-01' } })
    expect(res.statusCode).toBe(200)
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('LEGAL_UPDATE'))
    expect(audit).toBeDefined()
  })
  it('mise à jour sans SMIG → pas d\'audit LEGAL_UPDATE, 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // upsert
    const res = await app.inject({ method: 'PATCH', url: '/platform/legal-constants/CI/2024', headers: hSuper(),
      payload: { constants: { ABATTEMENT_ITS: 0.15 } } })
    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls.some(c => String(c[0]).includes('LEGAL_UPDATE'))).toBe(false)
  })
})

// ─── GET /platform/country-configs ───────────────────────────────────────────
describe('GET /platform/country-configs', () => {
  it('super_admin → création table + upsert + lecture, 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ country_code: 'CI' }] }) // SELECT
    const res = await app.inject({ method: 'GET', url: '/platform/country-configs', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
  it('admin tenant autorisé en lecture → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ country_code: 'CI' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/country-configs', headers: hAdmin() })
    expect(res.statusCode).toBe(200)
  })
})

// ─── GET /platform/dashboard ─────────────────────────────────────────────────
describe('GET /platform/dashboard', () => {
  it('KPIs agrégés → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ active_count: '3', trial_count: '1', suspended_count: '0', total_count: '4' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/dashboard', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.activeCount).toBe(3)
    expect(data.totalCount).toBe(4)
  })
})

// ─── Sourcing IA — modèles ───────────────────────────────────────────────────
describe('Sourcing IA — /platform/sourcing/models', () => {
  it('GET → liste', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MID, provider: 'anthropic' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/models', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
  it('GET échoue → data vide', async () => {
    queryMock.mockRejectedValueOnce(new Error('no table'))
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/models', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
  it('POST champs manquants → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/platform/sourcing/models', headers: hSuper(),
      payload: { provider: 'anthropic' } })
    expect(res.statusCode).toBe(400)
  })
  it('POST valide → 201 + invalidation cache', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MID }] })
    const res = await app.inject({ method: 'POST', url: '/platform/sourcing/models', headers: hSuper(),
      payload: { provider: 'anthropic', model_id: 'claude-x', display_name: 'Claude X' } })
    expect(res.statusCode).toBe(201)
    expect(invalidateConfigMock).toHaveBeenCalled()
  })
  it('POST erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const res = await app.inject({ method: 'POST', url: '/platform/sourcing/models', headers: hSuper(),
      payload: { provider: 'anthropic', model_id: 'claude-x', display_name: 'Claude X' } })
    expect(res.statusCode).toBe(500)
  })
  it('PATCH aucun champ → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/platform/sourcing/models/${MID}`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(400)
  })
  it('PATCH valide → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MID, display_name: 'MAJ' }] })
    const res = await app.inject({ method: 'PATCH', url: `/platform/sourcing/models/${MID}`, headers: hSuper(),
      payload: { display_name: 'MAJ', is_active: false } })
    expect(res.statusCode).toBe(200)
    expect(invalidateConfigMock).toHaveBeenCalled()
  })
  it('PATCH erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('update failed'))
    const res = await app.inject({ method: 'PATCH', url: `/platform/sourcing/models/${MID}`, headers: hSuper(),
      payload: { display_name: 'X' } })
    expect(res.statusCode).toBe(500)
  })
  it('DELETE id non-UUID → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/platform/sourcing/models/abc', headers: hSuper() })
    expect(res.statusCode).toBe(400)
  })
  it('DELETE valide → 200 + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ provider: 'anthropic', model_id: 'claude-x', display_name: 'Claude X' }] }) // snapshot
      .mockResolvedValueOnce({ rows: [] })  // DELETE
      .mockResolvedValueOnce({ rows: [] })  // audit
    const res = await app.inject({ method: 'DELETE', url: `/platform/sourcing/models/${MID}`, headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(audit?.[1]?.[1]).toBe('sourcing.model_deleted')
  })
  it('DELETE erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('select snapshot failed'))
    const res = await app.inject({ method: 'DELETE', url: `/platform/sourcing/models/${MID}`, headers: hSuper() })
    expect(res.statusCode).toBe(500)
  })
})

// ─── Sourcing IA — plateformes ───────────────────────────────────────────────
describe('Sourcing IA — /platform/sourcing/platforms', () => {
  it('GET avec country_code → filtre panafricain', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MID, code: 'apec' }] })
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/platforms?country_code=CI', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]!
    expect(String(call[0])).toContain('is_panafrican = true')
  })
  it('GET sans filtre + erreur DB → data vide', async () => {
    queryMock.mockRejectedValueOnce(new Error('no table'))
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/platforms', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
  it('GET autorisé hr_manager → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/platforms',
      headers: { authorization: `Bearer ${hrManagerToken()}` } })
    expect(res.statusCode).toBe(200)
  })
  it('POST champs manquants → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/platform/sourcing/platforms', headers: hSuper(),
      payload: { code: 'apec' } })
    expect(res.statusCode).toBe(400)
  })
  it('POST valide → 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MID }] })
    const res = await app.inject({ method: 'POST', url: '/platform/sourcing/platforms', headers: hSuper(),
      payload: { code: 'apec', name: 'APEC' } })
    expect(res.statusCode).toBe(201)
  })
  it('POST erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const res = await app.inject({ method: 'POST', url: '/platform/sourcing/platforms', headers: hSuper(),
      payload: { code: 'apec', name: 'APEC' } })
    expect(res.statusCode).toBe(500)
  })
  it('PATCH aucun champ → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/platform/sourcing/platforms/${MID}`, headers: hSuper(), payload: {} })
    expect(res.statusCode).toBe(400)
  })
  it('PATCH valide → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: MID }] })
    const res = await app.inject({ method: 'PATCH', url: `/platform/sourcing/platforms/${MID}`, headers: hSuper(),
      payload: { name: 'APEC MAJ' } })
    expect(res.statusCode).toBe(200)
  })
  it('PATCH erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('update failed'))
    const res = await app.inject({ method: 'PATCH', url: `/platform/sourcing/platforms/${MID}`, headers: hSuper(),
      payload: { name: 'X' } })
    expect(res.statusCode).toBe(500)
  })
  it('DELETE id non-UUID → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/platform/sourcing/platforms/abc', headers: hSuper() })
    expect(res.statusCode).toBe(400)
  })
  it('DELETE valide → 200 + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ name: 'APEC', country_code: 'CI', url: 'https://apec.fr' }] })
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({ method: 'DELETE', url: `/platform/sourcing/platforms/${MID}`, headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('audit_log'))
    expect(audit?.[1]?.[1]).toBe('sourcing.platform_deleted')
  })
  it('DELETE erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('snapshot failed'))
    const res = await app.inject({ method: 'DELETE', url: `/platform/sourcing/platforms/${MID}`, headers: hSuper() })
    expect(res.statusCode).toBe(500)
  })
})

// ─── Sourcing IA — settings (singleton clé/valeur) ───────────────────────────
describe('Sourcing IA — /platform/sourcing/settings', () => {
  it('GET → objet aplati (value wrapping + brut)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { key: 'max_profiles_min', value: { value: 1 } },
      { key: 'richness_weights', value: { a: 1 } },
    ] })
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/settings', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.max_profiles_min).toBe(1)
    expect(data.richness_weights).toEqual({ a: 1 })
  })
  it('GET erreur DB → data vide', async () => {
    queryMock.mockRejectedValueOnce(new Error('no table'))
    const res = await app.inject({ method: 'GET', url: '/platform/sourcing/settings', headers: hSuper() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual({})
  })
  it('PATCH upsert clés autorisées (dont richness_weights) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // upsert max_profiles_min
      .mockResolvedValueOnce({ rows: [] }) // upsert richness_weights
    const res = await app.inject({ method: 'PATCH', url: '/platform/sourcing/settings', headers: hSuper(),
      payload: { max_profiles_min: 2, richness_weights: { skills: 0.5 }, champ_interdit: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(invalidateConfigMock).toHaveBeenCalled()
    const upserts = queryMock.mock.calls.filter(c => String(c[0]).includes('sourcing_settings'))
    expect(upserts).toHaveLength(2)
  })
  it('PATCH erreur DB → 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('upsert failed'))
    const res = await app.inject({ method: 'PATCH', url: '/platform/sourcing/settings', headers: hSuper(),
      payload: { max_profiles_min: 2 } })
    expect(res.statusCode).toBe(500)
  })
})
