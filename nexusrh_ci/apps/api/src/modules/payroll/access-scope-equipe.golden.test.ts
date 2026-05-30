/**
 * Golden test E2E — scope d'accès "équipe directe" (OWASP A01, IDOR).
 *
 * Corrige des sur-permissions où un `manager` pouvait atteindre les données d'un
 * employé HORS de son équipe directe :
 *   - GET /payroll/payslips/:id/transparency  (données salariales + CNPS)
 *   - GET /expenses/:id                        (note de frais)
 *   - POST /training/enroll                    (inscription d'un tiers)
 *
 * Règle appliquée : employee = soi uniquement ; manager = son équipe directe
 * (employees.manager_id → manager.email) ; admin/hr_* = tout le tenant.
 *
 * Isolation : pg routé par SQL, redis/config/migrations mockés.
 */
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
import expensesRoutes from '../expenses/expenses.routes.js'
import trainingRoutes from '../training/training.routes.js'

const SCHEMA = 'tenant_sotra'
const SLIP_ID = '11111111-1111-1111-1111-111111111111'
const REPORT_ID = '22222222-2222-2222-2222-222222222222'
const SESSION_ID = '33333333-3333-3333-3333-333333333333'
const EMP_FOREIGN = '44444444-4444-4444-4444-444444444444' // employé hors équipe

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{ email: string; employeeId: string }> = {}) {
  return app.jwt.sign({
    sub: `u-${role}`, tenantId: 't1', schemaName: SCHEMA, role,
    email: opts.email ?? `${role}@sotra.ci`, firstName: 'A', lastName: 'B',
    employeeId: opts.employeeId ?? null,
  })
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes,  { prefix: '/payroll' })
  await app.register(expensesRoutes, { prefix: '/expenses' })
  await app.register(trainingRoutes, { prefix: '/training' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/payslips/:id/transparency — scope manager', () => {
  it('manager HORS équipe → 403 (bulletin d\'un employé non géré)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('manager_id')) return { rows: [] }              // team check → vide
      if (q.includes('.pay_slips')) return { rows: [{ id: SLIP_ID, employee_id: EMP_FOREIGN, lines: [] }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe directe')
  })

  it('employee → 403 sur le bulletin d\'un autre employé', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.pay_slips')) return { rows: [{ id: SLIP_ID, employee_id: EMP_FOREIGN, lines: [] }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: 'emp-moi' })}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /expenses/:id — scope manager', () => {
  it('manager HORS équipe → 403', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('manager_id')) return { rows: [] }                       // managerCanActOnReport → vide
      if (q.includes('expense_reports')) return { rows: [{ id: REPORT_ID, employee_email: 'autre@sotra.ci' }] }
      if (q.includes('expense_lines')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/expenses/${REPORT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe directe')
  })

  it('hr_officer → 200 (accès complet au tenant)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('expense_lines')) return { rows: [] }
      if (q.includes('expense_reports')) return { rows: [{ id: REPORT_ID, employee_email: 'autre@sotra.ci', amount: 1000 }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/expenses/${REPORT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /training/enroll — scope manager', () => {
  it('manager NE PEUT inscrire un employé HORS de son équipe → 403', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('manager_id')) return { rows: [] }   // team check → vide
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/training/enroll',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })}` },
      payload: { session_id: SESSION_ID, employee_id: EMP_FOREIGN },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe directe')
  })
})
