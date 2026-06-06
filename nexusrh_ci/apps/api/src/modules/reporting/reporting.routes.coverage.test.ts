/**
 * COUVERTURE — chemins non couverts par reporting.routes.test :
 *   - /overview : agrégation avec données réelles (annualTotals cumulés), catch 500 ;
 *   - /payroll-summary : succès (périodes + distribution salaires) + audit, catch 500 ;
 *   - /absences : catch 500 ;
 *   - /cnps-analytics : succès avec données, catch 500.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

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

beforeEach(() => { queryMock.mockReset().mockResolvedValue({ rows: [] }) })

describe('GET /reporting/overview — agrégation avec données', () => {
  it('cumule annualTotals sur les périodes de paie', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ department: 'Exploitation', count: 10, avg_salary: 200000 }] }) // depts
      .mockResolvedValueOnce({ rows: [
        { month: '2026-01', total_gross: 1000, total_net: 800, total_cnps: 150, total_its: 50 },
        { month: '2026-02', total_gross: 2000, total_net: 1600, total_cnps: 300, total_its: 100 },
      ] }) // pay
      .mockResolvedValueOnce({ rows: [{ type_label: 'CP', type_color: '#fff', count: 3, total_days: 12 }] }) // absTypes
      .mockResolvedValueOnce({ rows: [{ status: 'open', count: 2 }] }) // recJobs
      .mockResolvedValueOnce({ rows: [{ total: 80 }] }) // empsTotal
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview?year=2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.activeEmployees).toBe(80)
    expect(data.annualTotals.totalGross).toBe(3000)
    expect(data.annualTotals.totalNet).toBe(2400)
    expect(data.annualTotals.totalCnps).toBe(450)
    expect(data.annualTotals.totalIts).toBe(150)
    expect(data.departments).toHaveLength(1)
  })

  it('tolère des lignes de paie à valeurs nulles (annualTotals = 0)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // depts
      .mockResolvedValueOnce({ rows: [
        { month: '2026-01', total_gross: null, total_net: null, total_cnps: null, total_its: null },
      ] }) // pay avec valeurs nulles → branches || 0
      .mockResolvedValueOnce({ rows: [] }) // absTypes
      .mockResolvedValueOnce({ rows: [] }) // recJobs
      .mockResolvedValueOnce({ rows: [] }) // empsTotal vide → activeEmployees ?? 0
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview?year=2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.activeEmployees).toBe(0)
    expect(data.annualTotals).toEqual({ totalGross: 0, totalNet: 0, totalCnps: 0, totalIts: 0 })
  })

  it('500 si une requête d\'agrégation échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'GET', url: '/reporting/overview?year=2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /reporting/payroll-summary', () => {
  it('renvoie périodes + distribution salaires + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [
        { month: '2026-02', total_gross: 2000, total_net: 1600, total_cnps: 300, total_its: 100, employees_count: 5 },
      ] }) // periods
      .mockResolvedValueOnce({ rows: [
        { range: '< 100K', count: 3 },
        { range: '100–300K', count: 7 },
      ] }) // salaryDist
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/reporting/payroll-summary',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.periods).toHaveLength(1)
    expect(data.salaryDistribution).toHaveLength(2)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('reporting.payroll_summary')
  })

  it('500 si une requête échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'GET', url: '/reporting/payroll-summary',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

describe('GET /reporting/absences — catch', () => {
  it('500 si une requête échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'GET', url: '/reporting/absences?year=2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(500)
  })

  it('refuse year invalide (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/reporting/absences?year=abcd',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /reporting/cnps-analytics', () => {
  it('renvoie déclarations + historique mensuel', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ year: 2026, quarter: 1, status: 'declared',
        masse_salariale: 5000000, total_cotisations_salariales: 300000,
        total_cotisations_patronales: 400000, total_cotisations: 700000, employees_count: 80 }] }) // declarations
      .mockResolvedValueOnce({ rows: [{ month: '2026-01', total_cnps: 70000, total_its: 30000, total_gross: 1000000 }] }) // monthly
      .mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'GET', url: '/reporting/cnps-analytics?year=2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body).data
    expect(data.declarations).toHaveLength(1)
    expect(data.monthlyHistory).toHaveLength(1)
  })

  it('refuse year invalide (400)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/reporting/cnps-analytics?year=1999',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('500 si la requête déclarations échoue (catch)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const res = await app.inject({
      method: 'GET', url: '/reporting/cnps-analytics?year=2026',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(500)
  })
})
