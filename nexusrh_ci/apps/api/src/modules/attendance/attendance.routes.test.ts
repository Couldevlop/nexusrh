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
import { attendanceRoutes } from './attendance.routes.js'

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
  await app.register(attendanceRoutes, { prefix: '/attendance' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

const VALID_CONFIG = {
  lateMinutesTier1: 30,
  occurrencesTier1: 3,
  lateMinutesTier2: 60,
  occurrencesTier2: 3,
  unjustifiedAbsenceOccurrences: 1,
  warningsBeforeSanction: 2,
  windowMode: 'consecutive_or_month',
  defaultExpectedStart: '08:00',
  defaultToleranceMin: 10,
  defaultWorkdays: [1, 2, 3, 4, 5],
}

describe('OWASP A01 — GET /attendance/config réservé admin', () => {
  for (const role of ['manager', 'employee', 'readonly', 'hr_manager', 'hr_officer']) {
    it(`refuse le rôle ${role} (403)`, async () => {
      const res = await app.inject({
        method: 'GET', url: '/attendance/config',
        headers: { authorization: `Bearer ${tokenFor(app, role)}` },
      })
      expect(res.statusCode).toBe(403)
    })
  }

  it('sans token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/attendance/config' })
    expect(res.statusCode).toBe(401)
  })

  it('autorise admin (200) avec les défauts si aucune ligne', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.lateMinutesTier1).toBe(30)
    expect(body.data.defaultExpectedStart).toBe('08:00')
    expect(body.data.defaultWorkdays).toEqual([1, 2, 3, 4, 5])
  })
})

describe('PUT /attendance/config', () => {
  it('refuse un non-admin (403)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: VALID_CONFIG,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejette un champ inconnu (Zod strict) → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, extraField: 'nope' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette occurrencesTier1 = 0 → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, occurrencesTier1: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un defaultExpectedStart malformé → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, defaultExpectedStart: '8h00' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un defaultWorkdays hors 1..7 → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, defaultWorkdays: [0, 1, 2] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejette un lateMinutesTier1 négatif → 400', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { ...VALID_CONFIG, lateMinutesTier1: -1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte une config valide → 200 (INSERT) + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT id existant → aucun
      .mockResolvedValueOnce({ rows: [{ id: 'c1', ...VALID_CONFIG }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: VALID_CONFIG,
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]).toContain('attendance_config.updated')
  })

  it('met à jour la ligne existante (UPDATE) quand une config existe déjà', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] }) // SELECT id existant
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id', ...VALID_CONFIG }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'PUT', url: '/attendance/config',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: VALID_CONFIG,
    })
    expect(res.statusCode).toBe(200)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall).toBeDefined()
  })
})
