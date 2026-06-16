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
import successionRoutes from './succession.routes.js'

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
  await app.register(successionRoutes, { prefix: '/succession' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('OWASP A01 — RBAC', () => {
  it('refuse employee (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/succession/plans', headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('autorise readonly en lecture (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/succession/plans', headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` } })
    expect(res.statusCode).toBe(200)
  })
  it('refuse la création à readonly (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/succession/plans',
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
      payload: { positionTitle: 'DAF' },
    })
    expect(res.statusCode).toBe(403)
  })
  it('refuse la suppression à hr_officer (403)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/succession/plans/p1', headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` } })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /succession/plans — synthèse de couverture', () => {
  it('attache la couverture (atRisk) à chaque plan', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'p1', position_title: 'DAF' }, { id: 'p2', position_title: 'DRH' }] }) // plans
      .mockResolvedValueOnce({ rows: [{ plan_id: 'p1', readiness: 'ready_now' }, { plan_id: 'p1', readiness: 'long_term' }] }) // candidates
    const res = await app.inject({ method: 'GET', url: '/succession/plans', headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: Array<{ id: string; coverage: { atRisk: boolean; readyNow: number } }> }
    const p1 = body.data.find((p) => p.id === 'p1')!
    const p2 = body.data.find((p) => p.id === 'p2')!
    expect(p1.coverage.readyNow).toBe(1)
    expect(p1.coverage.atRisk).toBe(false)
    expect(p2.coverage.atRisk).toBe(true) // aucun candidat
  })
})

describe('POST /succession/plans + candidats', () => {
  it('crée un plan (201 + audit)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'p1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/succession/plans',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { positionTitle: 'Directeur Financier', criticality: 'critical' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('succession.plan_created')
  })
  it('refuse un plan sans intitulé (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/succession/plans',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { criticality: 'high' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('refuse un candidat en doublon (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // INSERT ON CONFLICT DO NOTHING → 0 rows
    const res = await app.inject({
      method: 'POST', url: '/succession/plans/p1/candidates',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', readiness: 'short_term' },
    })
    expect(res.statusCode).toBe(409)
  })
  it('ajoute un successeur (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/succession/plans/p1/candidates',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', readiness: 'ready_now' },
    })
    expect(res.statusCode).toBe(201)
  })
})
