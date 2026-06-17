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
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import mobilityRoutes from './mobility.routes.js'

const SCHEMA = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(mobilityRoutes, { prefix: '/mobility' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('OWASP A01 — RBAC', () => {
  it('refuse employee (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/mobility/requests', headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('autorise manager en lecture (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/mobility/requests', headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` } })
    expect(res.statusCode).toBe(200)
  })
})

describe('évaluation des compétences + écart', () => {
  it('upsert d\'une compétence évaluée (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) // upsert + audit
    const res = await app.inject({
      method: 'PUT', url: `/mobility/employees/${UUID_A}/competencies`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { competencyId: UUID_B, level: 4 },
    })
    expect(res.statusCode).toBe(200)
  })
  it('refuse un niveau Bloom hors bornes (400)', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/mobility/employees/${UUID_A}/competencies`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { competencyId: UUID_B, level: 9 },
    })
    expect(res.statusCode).toBe(400)
  })
  it('calcule l\'écart salarié vs poste (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ competency_id: 'c1', label: 'Excel', required_level: 4 }] }) // requiredOf
      .mockResolvedValueOnce({ rows: [{ competency_id: 'c1', level: 2 }] }) // assessedMap
    const res = await app.inject({
      method: 'GET', url: `/mobility/employees/${UUID_A}/gap?jobProfileId=${UUID_B}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { rows: Array<{ gap: number }>; gapsCount: number } }
    expect(body.data.rows[0]?.gap).toBe(2)
    expect(body.data.gapsCount).toBe(1)
  })
})

describe('passerelles + workflow (décision réservée DRH)', () => {
  it('crée une passerelle (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'm1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/mobility/requests',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { employeeId: UUID_A, targetJobProfileId: UUID_B, reason: 'Évolution' },
    })
    expect(res.statusCode).toBe(201)
  })
  it('hr_officer ne peut PAS approuver (décision réservée admin/hr_manager, 403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'in_review' }] }) // SELECT status
    const res = await app.inject({
      method: 'PATCH', url: '/mobility/requests/m1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { status: 'approved' },
    })
    expect(res.statusCode).toBe(403)
  })
  it('hr_manager approuve (200, décideur + date posés)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'in_review' }] }) // SELECT status
      .mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'approved' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PATCH', url: '/mobility/requests/m1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { status: 'approved' },
    })
    expect(res.statusCode).toBe(200)
    const upd = queryMock.mock.calls.find((c) => /UPDATE .*mobility_requests SET/.test(String(c[0])))
    expect(String(upd?.[0])).toContain('decided_by')
  })
  it('refuse une transition interdite (proposed → approved) (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'proposed' }] })
    const res = await app.inject({
      method: 'PATCH', url: '/mobility/requests/m1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { status: 'approved' },
    })
    expect(res.statusCode).toBe(409)
  })
})
