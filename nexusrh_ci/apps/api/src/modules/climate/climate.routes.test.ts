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
import climateRoutes from './climate.routes.js'

const SCHEMA = 'tenant_sotra'
function tokenFor(app: FastifyInstance, role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(climateRoutes, { prefix: '/climate' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('OWASP A01 — gestion réservée RH', () => {
  it('refuse la création d\'enquête à un employee (403)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
      payload: { title: 'X', questions: [{ label: 'Q', type: 'scale' }] },
    })
    expect(res.statusCode).toBe(403)
  })
  it('refuse la liste RH à un employee (403)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
  it('autorise hr_manager à créer (201)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 's1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { title: 'Climat 2026', questions: [{ label: 'Satisfaction ?', type: 'scale' }] },
    })
    expect(res.statusCode).toBe(201)
  })
  it('refuse une enquête sans question (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { title: 'X', questions: [] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /climate/surveys/:id/results — anonymat (jamais employee_id)', () => {
  it('n\'expose que des agrégats et ne sélectionne pas employee_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ questions: [{ key: 'sat', label: 'Sat', type: 'scale' }] }] }) // survey
      .mockResolvedValueOnce({ rows: [{ answers: { sat: 5 } }, { answers: { sat: 3 } }] }) // responses
    const res = await app.inject({
      method: 'GET', url: '/climate/surveys/s1/results',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { responseCount: number } }
    expect(body.data.responseCount).toBe(2)
    // la requête sur les réponses ne sélectionne QUE answers
    const respSql = queryMock.mock.calls.map((c) => String(c[0])).find((s) => s.includes('climate_responses')) ?? ''
    expect(respSql).toContain('answers')
    expect(respSql).not.toContain('employee_id')
  })
})

describe('réponse self-service', () => {
  it('refuse une réponse à une enquête non ouverte (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'draft' }] }) // survey status
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys/s1/responses',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', 'emp-1')}` },
      payload: { answers: { sat: 4 } },
    })
    expect(res.statusCode).toBe(409)
  })
  it('refuse une 2e réponse du même salarié (409, anti-doublon)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] }) // survey open
      .mockResolvedValueOnce({ rows: [] }) // INSERT ON CONFLICT DO NOTHING → 0 rows
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys/s1/responses',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', 'emp-1')}` },
      payload: { answers: { sat: 4 } },
    })
    expect(res.statusCode).toBe(409)
  })
  it('enregistre une réponse valide (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] }) // survey open
      .mockResolvedValueOnce({ rows: [{ id: 'r1' }] }) // INSERT ok
    const res = await app.inject({
      method: 'POST', url: '/climate/surveys/s1/responses',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', 'emp-1')}` },
      payload: { answers: { sat: 4, libre: 'RAS' } },
    })
    expect(res.statusCode).toBe(201)
  })
})
