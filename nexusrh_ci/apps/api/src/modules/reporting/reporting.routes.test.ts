import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

vi.mock('../../services/redis.js', () => ({
  blacklistToken:     vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))

import authPlugin from '../../plugins/auth.js'
import reportingRoutes from './reporting.routes.js'

const TENANT = 'tenant_sotra'

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT,
    role,
    email: `${role}@sotra.ci`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(reportingRoutes, { prefix: '/reporting' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('GET /reporting/overview — year validation (OWASP A03)', () => {
  it('refuse year non numérique (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview?year=abcd',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse year hors plage 2000-courant+1 (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview?year=1999',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte year valide et trace audit_log reporting.overview', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // depts
      .mockResolvedValueOnce({ rows: [] }) // pay
      .mockResolvedValueOnce({ rows: [] }) // absTypes
      .mockResolvedValueOnce({ rows: [] }) // recJobs
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // empsTotal
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview?year=2026',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('reporting.overview')
  })
})

describe('GET /reporting/* — RBAC + audit log (OWASP A01 + A09)', () => {
  it('un employee NE PEUT PAS accéder à /overview (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un manager NE PEUT PAS accéder à /payroll-summary (admin/hr uniquement, 403)', async () => {
    const token = tokenFor(app, 'manager')
    const res = await app.inject({
      method: 'GET', url: '/reporting/payroll-summary',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('/cnps-analytics trace audit_log reporting.cnps_analytics', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // declarations
      .mockResolvedValueOnce({ rows: [] }) // monthlyHistory
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/reporting/cnps-analytics?year=2026',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('reporting.cnps_analytics')
    // entity_id est NULL hardcodé dans le SQL reporting → changes = params[2]
    const changes = JSON.parse(auditCall?.[1]?.[2] as string)
    expect(changes.year).toBe(2026)
  })

  it('/absences trace audit_log reporting.absences', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // byMonth
      .mockResolvedValueOnce({ rows: [] }) // byDept
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/reporting/absences?year=2026',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('reporting.absences')
  })

  it('readonly peut accéder à /overview (lecture seule autorisée)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] }) // audit

    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})
