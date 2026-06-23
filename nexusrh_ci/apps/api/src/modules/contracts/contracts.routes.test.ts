import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux ──────────────────────────────────────────────────────────────
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
import contractsRoutes from './contracts.routes.js'

const TENANT_SCHEMA = 'tenant_sotra'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT_SCHEMA,
    role,
    email: opts.email ?? `${role}@sotra.ci`,
    firstName: 'Test',
    lastName:  'User',
    employeeId: opts.employeeId ?? null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
})

const validBody = {
  employee_id: '11111111-1111-1111-1111-111111111111',
  type: 'cdi' as const,
  start_date: '2026-01-01',
  base_salary: 350000,
  job_title: 'Comptable',
  job_level: 'agent_maitrise',
}

describe('POST /contracts — validation Zod (OWASP A03)', () => {
  it('refuse un type de contrat hors énum OHADA/CI (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, type: 'esclavage_moderne' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('invalides')
  })

  it('refuse un employee_id qui n\'est pas un UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, employee_id: 'not-a-uuid' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un base_salary négatif ou non-entier (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, base_salary: -500 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un start_date au format ISO non YYYY-MM-DD (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, start_date: '01/02/2026' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte un body valide, persiste et trace audit_log contract.created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'con-1', type: 'cdi', base_salary: 350000 }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('contract.created')
  })
})

describe('POST /contracts/:id/terminate — audit log critique (OWASP A09)', () => {
  it('rupture contrat trace audit_log contract.terminated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-1' }] }) // UPDATE contracts
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees (désactivation)
      .mockResolvedValueOnce({ rows: [] }) // INSERT hr_events
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts/con-1/terminate',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        termination_date: '2026-06-30',
        termination_reason: 'resignation',
        notice_days: 30,
      },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.[1]?.[1]).toBe('contract.terminated')
    // Le payload de changes contient la raison et la date
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.reason).toBe('resignation')
    expect(changes.terminationDate).toBe('2026-06-30')
    // Régression : l'INSERT hr_events doit cibler la colonne RÉELLE « date »
    // (et jamais « event_date » qui n'existe pas → 42703 → 500 à chaque rupture).
    const hrEventCall = queryMock.mock.calls.find((c) => String(c[0]).includes('hr_events'))
    expect(String(hrEventCall?.[0])).toMatch(/\bdate\b/)
    expect(String(hrEventCall?.[0])).not.toContain('event_date')
  })

  it('refuse rupture par un hr_officer (403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts/con-1/terminate',
      headers: { authorization: `Bearer ${token}` },
      payload: { termination_date: '2026-06-30', termination_reason: 'resignation' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('retourne 404 si le contrat n\'existe pas', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE returns no rows

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/contracts/unknown/terminate',
      headers: { authorization: `Bearer ${token}` },
      payload: { termination_date: '2026-06-30', termination_reason: 'other' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /contracts/:id — audit log critique (OWASP A09)', () => {
  it('suppression snapshote le contrat et trace audit_log contract.deleted', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-1', type: 'cdi', status: 'active' }] }) // SELECT snapshot
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'DELETE',
      url: '/contracts/con-99',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('contract.deleted')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.employeeId).toBe('emp-1')
    expect(changes.statusBeforeDelete).toBe('active')
  })

  it('refuse la suppression par hr_manager (admin uniquement, 403)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'DELETE',
      url: '/contracts/con-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse la suppression par employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'DELETE',
      url: '/contracts/con-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
