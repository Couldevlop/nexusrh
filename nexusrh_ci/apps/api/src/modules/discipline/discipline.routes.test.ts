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
import disciplineRoutes from './discipline.routes.js'

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
  await app.register(disciplineRoutes, { prefix: '/discipline' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('OWASP A01 — accès restreint niveau 4', () => {
  for (const role of ['manager', 'employee', 'readonly']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/discipline',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('autorise hr_officer en lecture (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/discipline',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuse la suppression à hr_officer (DELETE réservé admin/hr_manager) (403)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/discipline/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/discipline' })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /discipline', () => {
  it('refuse un body invalide (type hors échelle) → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/discipline',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: '11111111-1111-1111-1111-111111111111', type: 'pendaison', reason: 'x', actionDate: '2026-01-01' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('crée une sanction et journalise (201 + audit_log)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'd1', status: 'draft' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/discipline',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {
        employeeId: '11111111-1111-1111-1111-111111111111',
        type: 'avertissement', reason: 'Retards répétés', actionDate: '2026-01-15',
      },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    // l'action est passée en paramètre ($2), pas inline dans le SQL
    expect(auditCall?.[1]).toContain('discipline.created')
  })
})

describe('PATCH /discipline/:id — transition contrôlée', () => {
  it('refuse une transition interdite (closed → issued) → 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'closed' }] }) // SELECT status
    const res = await app.inject({
      method: 'PATCH', url: '/discipline/d1',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { status: 'issued' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('accepte une transition valide (draft → issued) → 200', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ status: 'draft' }] }) // SELECT
      .mockResolvedValueOnce({ rows: [{ id: 'd1', status: 'issued' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PATCH', url: '/discipline/d1',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { status: 'issued' },
    })
    expect(res.statusCode).toBe(200)
  })
})
