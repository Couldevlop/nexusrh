import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import offboardingRoutes from './offboarding.routes.js'

const SCHEMA = 'tenant_sotra'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('OWASP A01 — RBAC', () => {
  it('refuse employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
  it('autorise readonly en lecture (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
    })
    expect(res.statusCode).toBe(200)
  })
  it('refuse la création à readonly (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', departureType: 'demission', departureDate: '2026-03-01' },
    })
    expect(res.statusCode).toBe(403)
  })
  it('refuse la suppression à hr_officer (403)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/offboarding/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(403)
  })
  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/offboarding' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /offboarding', () => {
  it('refuse un type de départ invalide (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', departureType: 'vacances', departureDate: '2026-03-01' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('ouvre un dossier avec checklist par défaut (201 + audit)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'open' }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/offboarding',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', departureType: 'licenciement', departureDate: '2026-03-31', noticeServed: false },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls[0]
    expect(String(insert?.[0])).toContain('offboarding_cases')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('offboarding.created')
  })
})

describe('POST /offboarding/:id/settlement — solde de tout compte', () => {
  it('calcule le solde depuis le salaire + ancienneté et historise (200)', async () => {
    queryMock
      // SELECT case + employee
      .mockResolvedValueOnce({ rows: [{
        departure_type: 'licenciement', departure_date: '2026-03-31', notice_served: false,
        status: 'open', base_salary: '300000', hire_date: '2019-04-01',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/offboarding/o1/settlement',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { congesDaysOutstanding: 10 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { total: number; indemniteLicenciement: number; indemnitePreavis: number } }
    expect(body.data.total).toBeGreaterThan(0)
    expect(body.data.indemniteLicenciement).toBeGreaterThan(0) // ~7 ans d'ancienneté
    expect(body.data.indemnitePreavis).toBeGreaterThan(0)       // préavis non effectué
    // l'UPDATE persiste le settlement
    const upd = queryMock.mock.calls.find((c) => String(c[0]).includes('SET settlement'))
    expect(upd).toBeDefined()
  })

  it('404 si dossier inexistant', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/offboarding/inconnu/settlement',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /offboarding/:id — transition contrôlée', () => {
  it('refuse open → closed (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'open' }] })
    const res = await app.inject({
      method: 'PATCH', url: '/offboarding/o1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { status: 'closed' },
    })
    expect(res.statusCode).toBe(409)
  })
})
