/**
 * Routes cabinet de recrutement — activation de session (chokepoint A01),
 * CRUD super_admin, gestion des membres (owner), onboarding tenant client.
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
function memberToken() {
  return app.jwt.sign({ sub: 'au2', tenantId: null, schemaName: 'platform', role: 'agency_member',
    email: 'm@cab.ci', firstName: 'M', lastName: 'B', employeeId: null, actorType: 'agency', agencyId: AG })
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

describe('POST /agency/sessions/activate — chokepoint A01', () => {
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate', payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(401)
  })

  it('token admin tenant (rôle non cabinet) → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${adminTenantToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
  })

  it('token cabinet restreint (mfaPending) → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken({ mfaPending: true })}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
  })

  it('tenant non rattaché → 403', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...GUARD_OK, link_id: null }] })
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
  })

  it('tenant non-CI → 403', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...GUARD_OK, default_country_code: 'SEN' }] })
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(403)
  })

  it('happy path → 200, token scopé (admin délégué, claims cabinet, TTL 30min)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [GUARD_OK] })
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.scoped).toBe(true)
    expect(body.expiresInSec).toBe(1800)
    expect(body.tenantConfig.id).toBe(T1)
    const decoded = app.jwt.decode(body.token) as Record<string, number | string>
    expect(decoded.schemaName).toBe('tenant_acme')
    expect(decoded.role).toBe('admin')
    expect(decoded.actorType).toBe('agency')
    expect(decoded.agencyId).toBe(AG)
    expect(decoded.onBehalfOf).toBe(T1)
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(1800)
  })

  it('membre peut aussi activer (rôle agency_member autorisé)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [GUARD_OK] })
    const res = await app.inject({ method: 'POST', url: '/agency/sessions/activate',
      headers: { authorization: `Bearer ${memberToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(200)
  })
})

describe('CRUD cabinets (super_admin)', () => {
  it('POST /agency/agencies → 201 + owner + tempPassword', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })            // slug check
      .mockResolvedValueOnce({ rows: [{ id: AG }] })  // insert agency
      .mockResolvedValueOnce({ rows: [] })            // insert owner
    const res = await app.inject({ method: 'POST', url: '/agency/agencies',
      headers: { authorization: `Bearer ${superToken()}` },
      payload: { name: 'Cabinet RH', slug: 'cabinet-rh', ownerEmail: 'owner@cab.ci' } })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.data.id).toBe(AG)
    expect(body.tempPassword).toMatch(/^CI_.+!$/)
  })

  it('POST /agency/agencies par un cabinet (non super_admin) → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/agencies',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { name: 'X', slug: 'x', ownerEmail: 'o@x.ci' } })
    expect(res.statusCode).toBe(403)
  })

  it('rattacher un tenant NON-CI → 422', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                   // agency exists
      .mockResolvedValueOnce({ rows: [{ default_country_code: 'SEN' }] }) // tenant country
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/tenants`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(422)
  })

  it('rattacher un tenant CI → 201', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                   // agency exists
      .mockResolvedValueOnce({ rows: [{ default_country_code: 'CIV' }] }) // tenant country
      .mockResolvedValueOnce({ rows: [] })                            // insert link
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/tenants`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: { tenantId: T1 } })
    expect(res.statusCode).toBe(201)
  })

  it('suspendre un cabinet → 200 + blacklist des sessions membres', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                           // politique message hors-ligne (défauts)
      .mockResolvedValueOnce({ rows: [{ id: AG }] })                 // update status
      .mockResolvedValueOnce({ rows: [{ id: 'au1' }, { id: 'au2' }] }) // members
    const res = await app.inject({ method: 'POST', url: `/agency/agencies/${AG}/suspend`,
      headers: { authorization: `Bearer ${superToken()}` }, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(blacklistMock).toHaveBeenCalledTimes(2)
  })

  it('détacher un tenant → 200', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'lnk1' }] }) // update detached_at
    const res = await app.inject({ method: 'DELETE', url: `/agency/agencies/${AG}/tenants/${T1}`,
      headers: { authorization: `Bearer ${superToken()}` } })
    expect(res.statusCode).toBe(200)
  })
})

describe('Membres & onboarding (agency_owner)', () => {
  it('owner crée un membre → 201', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'm1' }] }) // insert
    const res = await app.inject({ method: 'POST', url: '/agency/members',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { email: 'rec@cab.ci', firstName: 'R', lastName: 'E' } })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).tempPassword).toMatch(/^CI_.+!$/)
  })

  it('un membre NE PEUT PAS créer de membre → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/agency/members',
      headers: { authorization: `Bearer ${memberToken()}` }, payload: { email: 'x@cab.ci' } })
    expect(res.statusCode).toBe(403)
  })

  it('owner ne peut PAS modifier un membre d\'un autre cabinet → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // target introuvable dans CE cabinet
    const res = await app.inject({ method: 'PATCH', url: `/agency/members/${T1}`,
      headers: { authorization: `Bearer ${ownerToken()}` }, payload: { firstName: 'Z' } })
    expect(res.statusCode).toBe(404)
  })

  it('GET /agency/my-tenants → liste', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: T1, name: 'ACME', slug: 'acme' }] })
    const res = await app.inject({ method: 'GET', url: '/agency/my-tenants',
      headers: { authorization: `Bearer ${ownerToken()}` } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('onboard tenant client → createTenantWithSchema(CIV) + rattachement, 201', async () => {
    createTenantMock.mockResolvedValue({ id: T1, slug: 'newco', schemaName: 'tenant_newco',
      name: 'NewCo', planType: 'trial', adminEmail: 'admin@newco.ci', tempPassword: 'CI_X!' })
    queryMock
      .mockResolvedValueOnce({ rows: [{ sender_email: 'recrut@cab.ci', sender_name: 'Cabinet RH', logo_url: null }] }) // agencies sender
      .mockResolvedValueOnce({ rows: [] }) // insert link
    const res = await app.inject({ method: 'POST', url: '/agency/client-tenants',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { name: 'NewCo', slug: 'newco', adminEmail: 'admin@newco.ci' } })
    expect(res.statusCode).toBe(201)
    expect(createTenantMock).toHaveBeenCalledTimes(1)
    const [, input, opts] = createTenantMock.mock.calls[0]!
    expect(input.defaultCountryCode).toBe('CIV')
    expect(opts.sender).toEqual({ email: 'recrut@cab.ci', name: 'Cabinet RH' })
  })
})
