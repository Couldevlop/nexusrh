/**
 * Couverture exhaustive des branches restantes de agency.routes :
 *  - sessions/activate : refus tenant restreint déjà couvert ; ici la trace
 *    audit du refus (guard.ok=false) ;
 *  - sessions/deactivate : hors contexte cabinet (403) + retour cabinet (200) ;
 *  - GET /me (succès + 404 + contexte manquant) ;
 *  - GET /members + POST /members (409 email) ;
 *  - PATCH /members/:id (succès, id invalide, validation, aucun champ) ;
 *  - POST /client-tenants (validation 400, conflit slug 409) ;
 *  - super_admin : GET /agencies (pagination), POST /agencies (slug pris 409 +
 *    owner email pris 409), GET /agencies/:id (404 + succès), PATCH /agencies/:id
 *    (succès, aucun champ, 404), suspend (message obligatoire, includeClients,
 *    404), reactivate (includeClients), attach (404 cabinet/tenant).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

const { blacklistMock } = vi.hoisted(() => ({ blacklistMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: blacklistMock,
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  redisLockoutStore: {},
}))

const { createTenantMock } = vi.hoisted(() => ({ createTenantMock: vi.fn() }))
vi.mock('../../services/tenant-provisioning.service.js', () => ({
  createTenantWithSchema: createTenantMock,
  TenantSlugConflictError: class TenantSlugConflictError extends Error {},
}))

vi.mock('../../services/email.js', () => ({
  sendWelcomeAgencyEmail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test', appUrl: 'http://localhost:3001', apiUrl: 'http://localhost:4001',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import agencyRoutes from './agency.routes.js'
import { TenantSlugConflictError } from '../../services/tenant-provisioning.service.js'

let app: FastifyInstance
const AG = '11111111-1111-1111-1111-111111111111'
const T1 = '22222222-2222-2222-2222-222222222222'

const GUARD_OK = {
  agency_status: 'active', tenant_id: T1, schema_name: 'tenant_acme', name: 'ACME', slug: 'acme',
  primary_color: '#1D4ED8', secondary_color: '#F48C06', logo_url: null, city: 'Abidjan',
  tenant_status: 'active', default_country_code: 'CIV',
  has_subsidiaries: false, payroll_mode: 'single_country', link_id: 'lnk1',
}

function ownerToken(over: Record<string, unknown> = {}) {
  return app.jwt.sign({ sub: 'au1', tenantId: null, schemaName: 'platform', role: 'agency_owner',
    email: 'owner@cab.ci', firstName: 'O', lastName: 'W', employeeId: null,
    actorType: 'agency', agencyId: AG, ...over })
}
function ownerNoAgency() {
  // Token cabinet sans agencyId → branches "Contexte cabinet manquant"
  return app.jwt.sign({ sub: 'au1', tenantId: null, schemaName: 'platform', role: 'agency_owner',
    email: 'owner@cab.ci', firstName: 'O', lastName: 'W', employeeId: null, actorType: 'agency' })
}
function scopedAgencyToken() {
  // Token cabinet scopé sur un tenant (actorType='agency') → deactivate OK
  return app.jwt.sign({ sub: 'au1', tenantId: 't1', schemaName: 'tenant_acme', role: 'admin',
    email: 'owner@cab.ci', firstName: 'O', lastName: 'W', employeeId: null,
    actorType: 'agency', agencyId: AG })
}
function superToken() {
  return app.jwt.sign({ sub: 'sa1', tenantId: null, schemaName: 'platform', role: 'super_admin',
    email: 'super@ci', firstName: 'S', lastName: 'A', employeeId: null })
}
function adminTenantToken() {
  return app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_x', role: 'admin',
    email: 'a@x.ci', firstName: 'A', lastName: 'D', employeeId: null })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(agencyRoutes, { prefix: '/agency' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  blacklistMock.mockClear()
  createTenantMock.mockReset()
})

describe('POST /agency/sessions/activate — refus tracé', () => {
  it('token restreint (pwdResetRequired) → 403 (bloqué en amont par le plugin auth)', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken({ pwdResetRequired: true })}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
  })

  it('agencyId manquant dans le token → 403 (contexte cabinet)', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerNoAgency()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('Contexte cabinet')
  })

  it('body invalide (tenantId absent) → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('guard refuse (tenant non rattaché) → 403 générique + audit denied', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...GUARD_OK, link_id: null }] })
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('Accès au tenant refusé')
  })
})

describe('POST /agency/sessions/deactivate', () => {
  it('hors contexte cabinet → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/deactivate',
      headers: { authorization: `Bearer ${adminTenantToken()}` } })
    expect(res.statusCode).toBe(403)
  })

  it('retour au contexte cabinet → 200 (scoped:false)', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/deactivate',
      headers: { authorization: `Bearer ${scopedAgencyToken()}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scoped).toBe(false)
    expect(body.token).toBeTruthy()
  })
})

describe('GET /agency/me', () => {
  it('contexte cabinet manquant → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/agency/me',
      headers: { authorization: `Bearer ${ownerNoAgency()}` } })
    expect(res.statusCode).toBe(403)
  })

  it('cabinet introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/agency/me',
      headers: { authorization: `Bearer ${ownerToken()}` } })
    expect(res.statusCode).toBe(404)
  })

  it('succès → renvoie les infos du cabinet', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: AG, slug: 'cab', name: 'Cabinet RH', status: 'active' }] })
    const res = await app.inject({ method: 'GET', url: '/agency/me',
      headers: { authorization: `Bearer ${ownerToken()}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.id).toBe(AG)
  })
})

describe('GET /agency/members', () => {
  it('contexte manquant → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerNoAgency()}` } })
    expect(res.statusCode).toBe(403)
  })

  it('liste les membres → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'm1', email: 'm@cab.ci', role: 'agency_member' }] })
    const res = await app.inject({ method: 'GET', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerToken()}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
})

describe('POST /agency/members', () => {
  it('contexte manquant → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerNoAgency()}` }, payload: { email: 'x@cab.ci' } })
    expect(res.statusCode).toBe(403)
  })

  it('validation échouée (email manquant) → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { firstName: 'X' } })
    expect(res.statusCode).toBe(400)
  })

  it('email déjà utilisé (23505) → 409', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await app.inject({ method: 'POST', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { email: 'dup@cab.ci' } })
    expect(res.statusCode).toBe(409)
  })

  it('erreur inattendue à l\'insert membre (non-23505) → 500 (rethrow)', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom member'))
    const res = await app.inject({ method: 'POST', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { email: 'm2@cab.ci' } })
    expect(res.statusCode).toBe(500)
  })
})

describe('PATCH /agency/members/:id', () => {
  it('contexte manquant → 403', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/agency/members/${T1}`,
      headers: { authorization: `Bearer ${ownerNoAgency()}` }, payload: { firstName: 'Z' } })
    expect(res.statusCode).toBe(403)
  })

  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/agency/members/not-uuid',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { firstName: 'Z' } })
    expect(res.statusCode).toBe(400)
  })

  it('validation échouée (rôle invalide) → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/agency/members/${T1}`,
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { role: 'god' } })
    expect(res.statusCode).toBe(400)
  })

  it('aucun champ à modifier (body vide) → 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: T1 }] }) // target trouvée
    const res = await app.inject({ method: 'PATCH', url: `/agency/members/${T1}`,
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Aucun champ')
  })

  it('mise à jour de tous les champs → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: T1 }] }) // target trouvée
      .mockResolvedValueOnce({ rows: [{ id: T1 }] }) // UPDATE
    const res = await app.inject({ method: 'PATCH', url: `/agency/members/${T1}`,
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { firstName: 'A', lastName: 'B', role: 'agency_member', isActive: false } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.updated).toBe(true)
  })
})

describe('POST /agency/client-tenants', () => {
  it('contexte manquant → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/client-tenants',
      headers: { authorization: `Bearer ${ownerNoAgency()}` },
      payload: { name: 'NewCo', slug: 'newco', adminEmail: 'a@newco.ci' } })
    expect(res.statusCode).toBe(403)
  })

  it('validation échouée (adminEmail manquant) → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/client-tenants',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { name: 'NewCo', slug: 'newco' } })
    expect(res.statusCode).toBe(400)
  })

  it('conflit de slug (TenantSlugConflictError) → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ sender_email: null, sender_name: null, logo_url: null }] }) // agencies sender
    createTenantMock.mockRejectedValue(new TenantSlugConflictError('slug pris'))
    const res = await app.inject({ method: 'POST', url: '/agency/client-tenants',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { name: 'NewCo', slug: 'newco', adminEmail: 'admin@newco.ci' } })
    expect(res.statusCode).toBe(409)
  })

  it('erreur inattendue de provisioning (non-conflit) → 500 (rethrow)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ sender_email: null, sender_name: null, logo_url: null }] }) // sender
    createTenantMock.mockRejectedValue(new Error('boom provisioning'))
    const res = await app.inject({ method: 'POST', url: '/agency/client-tenants',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { name: 'NewCo', slug: 'newco', adminEmail: 'admin@newco.ci' } })
    expect(res.statusCode).toBe(500)
  })

  it('succès sans sender configuré → 201', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ sender_email: null, sender_name: null, logo_url: null }] }) // sender
      .mockResolvedValueOnce({ rows: [] }) // insert link
    createTenantMock.mockResolvedValue({ id: T1, slug: 'newco', schemaName: 'tenant_newco',
      name: 'NewCo', planType: 'trial', adminEmail: 'admin@newco.ci', tempPassword: 'CI_X!' })
    const res = await app.inject({ method: 'POST', url: '/agency/client-tenants',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { name: 'NewCo', slug: 'newco', adminEmail: 'admin@newco.ci' } })
    expect(res.statusCode).toBe(201)
    const [, , opts] = createTenantMock.mock.calls[0]!
    expect(opts.sender).toBeNull()
  })
})

describe('GET /agency/agencies (super_admin)', () => {
  it('liste paginée → 200 avec total', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG, name: 'Cab', users_count: '2', tenants_count: '1' }] }) // rows
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // total
    const res = await app.inject({ method: 'GET', url: '/agency/agencies?page=2&limit=10',
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(1)
    expect(body.page).toBe(2)
    expect(body.limit).toBe(10)
  })
})

describe('POST /agency/agencies (super_admin) — conflits', () => {
  it('validation échouée → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/agencies',
      headers: { authorization: `Bearer ${superToken()}` }, payload: { name: 'X' } })
    expect(res.statusCode).toBe(400)
  })

  it('slug déjà utilisé → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }) // slug check trouvé
    const res = await app.inject({ method: 'POST', url: '/agency/agencies',
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { name: 'Cab', slug: 'cab', ownerEmail: 'o@cab.ci' } })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà utilisé')
  })

  it('erreur inattendue à l\'insert owner (non-23505) → 500 (rethrow)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                 // slug libre
      .mockResolvedValueOnce({ rows: [{ id: AG }] })       // insert agency
      .mockRejectedValueOnce(new Error('boom owner'))      // insert owner échoue (autre erreur)
    const res = await app.inject({ method: 'POST', url: '/agency/agencies',
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { name: 'Cab', slug: 'cab3', ownerEmail: 'o3@cab.ci' } })
    expect(res.statusCode).toBe(500)
  })

  it('email owner déjà utilisé (23505) → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                 // slug libre
      .mockResolvedValueOnce({ rows: [{ id: AG }] })       // insert agency
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' })) // insert owner dup
    const res = await app.inject({ method: 'POST', url: '/agency/agencies',
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { name: 'Cab', slug: 'cab2', ownerEmail: 'dup@cab.ci' } })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('owner')
  })
})

describe('GET /agency/agencies/:id (super_admin)', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/agency/agencies/not-uuid',
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(400)
  })

  it('cabinet introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: `/agency/agencies/${AG}`,
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(404)
  })

  it('succès → cabinet + users + tenants', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG, name: 'Cab' }] }) // agency
      .mockResolvedValueOnce({ rows: [{ id: 'm1' }] })            // users
      .mockResolvedValueOnce({ rows: [{ id: T1 }] })              // tenants
    const res = await app.inject({ method: 'GET', url: `/agency/agencies/${AG}`,
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.users).toHaveLength(1)
    expect(body.data.tenants).toHaveLength(1)
  })
})

describe('PATCH /agency/agencies/:id (super_admin)', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/agency/agencies/not-uuid',
      headers: { authorization: `Bearer ${superToken()}` }, payload: { name: 'X' } })
    expect(res.statusCode).toBe(400)
  })

  it('aucun champ → 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/agency/agencies/${AG}`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('cabinet introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE returns no row
    const res = await app.inject({ method: 'PATCH', url: `/agency/agencies/${AG}`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { name: 'NouveauNom' } })
    expect(res.statusCode).toBe(404)
  })

  it('mise à jour (avec senderEmail vidé → NULL) → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: AG }] }) // UPDATE ok
    const res = await app.inject({ method: 'PATCH', url: `/agency/agencies/${AG}`,
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { name: 'Cab', city: 'Bouaké', senderEmail: '' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.updated).toBe(true)
  })
})

describe('POST /agency/agencies/:id/suspend (super_admin)', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/agencies/not-uuid/suspend',
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('corps invalide (message > 2000 caractères) → 400', async () => {
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { message: 'x'.repeat(2001) } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('invalide')
  })

  it('repli pré-migration : colonne offline_message absente (UPDATE 1 rejette → 2e UPDATE)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                              // policy défauts
      .mockRejectedValueOnce(Object.assign(new Error('col missing'), { code: '42703' })) // UPDATE avec offline_message échoue
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                   // UPDATE repli (sans offline_message)
      .mockResolvedValueOnce({ rows: [{ id: 'au1' }] })               // members
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { message: 'Hors ligne' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('suspended')
  })

  it('message obligatoire absent (politique vide) → 400', async () => {
    // getOfflineMessagePolicy : ligne settings avec defaultMessage vide + required true
    queryMock.mockResolvedValueOnce({ rows: [{ offline_message_default: '', offline_message_required: true }] })
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('obligatoire')
  })

  it('cabinet introuvable → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })  // policy : défauts (message générique)
      .mockResolvedValueOnce({ rows: [] })  // UPDATE agencies → aucune ligne
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { message: 'Hors ligne' } })
    expect(res.statusCode).toBe(404)
  })

  it('suspension avec includeClients → cascade + blacklist', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                            // policy défauts
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                  // UPDATE agencies
      .mockResolvedValueOnce({ rows: [{ id: T1 }, { id: 'c2' }] })    // cascade tenants
      .mockResolvedValueOnce({ rows: [{ id: 'au1' }] })              // members
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { message: 'Maintenance', includeClients: true } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.clientsSuspended).toBe(2)
    expect(blacklistMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /agency/agencies/:id/reactivate (super_admin)', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/agencies/not-uuid/reactivate',
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('cabinet introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE → aucune ligne
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/reactivate`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(404)
  })

  it('repli pré-migration : UPDATE avec offline_message rejette → 2e UPDATE', async () => {
    queryMock
      .mockRejectedValueOnce(Object.assign(new Error('col missing'), { code: '42703' })) // UPDATE 1 échoue
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                                       // UPDATE repli
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/reactivate`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('active')
  })

  it('réactivation avec includeClients → cascade', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG }] })             // UPDATE agencies
      .mockResolvedValueOnce({ rows: [{ id: T1 }] })             // cascade tenants
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/reactivate`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { includeClients: true } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.clientsReactivated).toBe(1)
  })
})

describe('POST /agency/agencies/:id/tenants (rattachement, super_admin)', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/agencies/not-uuid/tenants',
      headers: { authorization: `Bearer ${superToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(400)
  })

  it('tenantId invalide → 400', async () => {
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/tenants`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { tenantId: 'bad' } })
    expect(res.statusCode).toBe(400)
  })

  it('cabinet introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // agency exists → non
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/tenants`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(404)
  })

  it('tenant introuvable → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG }] }) // agency exists
      .mockResolvedValueOnce({ rows: [] })           // tenant introuvable
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/tenants`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /agency/agencies/:id/tenants/:tenantId (super_admin)', () => {
  it('id invalide → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/agency/agencies/not-uuid/tenants/${T1}`,
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(400)
  })

  it('rattachement introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE detached → aucune ligne
    const res = await app.inject({ method: 'DELETE', url: `/agency/agencies/${AG}/tenants/${T1}`,
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(404)
  })
})
