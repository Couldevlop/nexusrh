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
import calibrationRoutes from './calibration.routes.js'

const SCHEMA = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({ sub: 'u-' + role, tenantId: 't1', schemaName: SCHEMA, role, email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId: null })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(calibrationRoutes, { prefix: '/calibration' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [] }) })

describe('OWASP A01 — RBAC', () => {
  it('refuse employee (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/calibration/sessions', headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` } })
    expect(res.statusCode).toBe(403)
  })
  it('refuse la suppression à hr_officer (403)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/calibration/sessions/${UUID_A}`, headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` } })
    expect(res.statusCode).toBe(403)
  })
})

describe('sessions + entrées', () => {
  it('crée une session (201 + audit)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 's1' }] }).mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/calibration/sessions',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { title: 'Calibrage 2026', sessionDate: '2026-03-01' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('calibration.session_created')
  })

  it('détail : calcule la case 9-box de chaque entrée + synthèse', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 's1', title: 'C' }] }) // session
      .mockResolvedValueOnce({ rows: [
        { id: 'e1', employee_id: 'emp1', first_name: 'A', last_name: 'B', job_title: null,
          performance_before: 2, potential_before: 2, performance_after: 3, potential_after: 3,
          qualities: null, gaps: null, corrective_actions: null },
      ] }) // entries
    const res = await app.inject({
      method: 'GET', url: '/calibration/sessions/s1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { entries: Array<{ boxAfter: { key: string } | null }>; summary: { byKey: Record<string, number> } } }
    expect(body.data.entries[0]?.boxAfter?.key).toBe('star')
    expect(body.data.summary.byKey.star).toBe(1)
  })

  it('refuse un score hors bornes à l\'inscription (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/calibration/sessions/s1/entries',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: UUID_A, performanceBefore: 9 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un doublon collaborateur (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // INSERT ON CONFLICT DO NOTHING → 0 rows
    const res = await app.inject({
      method: 'POST', url: '/calibration/sessions/s1/entries',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: UUID_A, performanceBefore: 2, potentialBefore: 3 },
    })
    expect(res.statusCode).toBe(409)
  })

  it('refuse une transition de statut interdite (closed → draft) (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'closed' }] }) // SELECT status
    const res = await app.inject({
      method: 'PATCH', url: '/calibration/sessions/s1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { status: 'draft' },
    })
    expect(res.statusCode).toBe(409)
  })
})
