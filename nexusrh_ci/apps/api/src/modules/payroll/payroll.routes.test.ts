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
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import payrollRoutes from './payroll.routes.js'

const TENANT = 'tenant_sotra'
const EMP_A = '11111111-1111-1111-1111-111111111111'
const EMP_B = '22222222-2222-2222-2222-222222222222'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT,
    role,
    email: opts.email ?? `${role}@sotra.ci`,
    firstName: 'Test',
    lastName: 'User',
    employeeId: opts.employeeId ?? null,
  })
}

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

const validSim = {
  baseSalary: 250000,
  workedDays: 26,
  workingDaysMonth: 26,
  atRate: 0.02,
  maritalStatus: 'single' as const,
  childrenCount: 0,
  variableElements: { PRIME_TRANSPORT: 30000 },
}

describe('POST /payroll/simulate — Zod (OWASP A03)', () => {
  it('refuse baseSalary > 50M (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, baseSalary: 999_999_999 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse atRate > 0.1 (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, atRate: 0.5 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse workedDays > workingDaysMonth (400 cohérence métier)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, workedDays: 31, workingDaysMonth: 26 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse maritalStatus hors énum (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, maritalStatus: 'pacs_libre' as never },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un readonly de simuler (403)', async () => {
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: validSim,
    })
    expect(res.statusCode).toBe(403)
  })

  it('simulation hr_manager renvoie net + audit log', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: validSim,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.meta.mode).toBe('simulation')
    expect(body.meta.persistedAt).toBeNull()
    expect(body.data.netPayable).toBeGreaterThan(0)
    expect(body.data.currency).toBe('XOF')
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('payroll.simulated')
  })

  it('simulation enrichit les lines avec formulaHuman (axe 1 explainer)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: validSim,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const salaryLine = body.data.lines.find((l: { code: string }) => l.code === '1000')
    expect(salaryLine.formulaHuman).toContain('Salaire')
    expect(salaryLine.category).toBe('salary')
    expect(salaryLine.legalReference).toContain('Code')
  })
})

describe('POST /payroll/simulate — RBAC IDOR (OWASP A01)', () => {
  it('employee NE PEUT PAS simuler sur un autre employé (403)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: EMP_A })
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, employee_id: EMP_B },
    })
    expect(res.statusCode).toBe(403)
  })

  it('employee PEUT simuler sur son propre employeeId', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit

    const token = tokenFor(app, 'employee', { employeeId: EMP_A })
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, employee_id: EMP_A },
    })
    expect(res.statusCode).toBe(200)
  })

  it('manager NE PEUT PAS simuler sur un employé hors équipe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas équipe

    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validSim, employee_id: EMP_B },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /payroll/payslips/:id/transparency — UUID validation', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/payroll/payslips/not-uuid/transparency',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
