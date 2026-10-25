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
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import approvalsRoutes from './approvals.routes.js'

const HOUR = 3_600_000
let app: FastifyInstance

function tokenFor(role: string, employeeId: string | null, sub = `u-${employeeId ?? role}`) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
  })
}

// emp-1 → n1 (N+1) ; rh-1 sans responsable
const HIERARCHY = [{ id: 'emp-1', manager_id: 'n1' }, { id: 'n1', manager_id: null }, { id: 'rh-1', manager_id: null }]

function routeSql(opts: { absences?: unknown[]; expenses?: unknown[] }) {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql)
    if (s.includes('workflow_configs')) return { rows: [{ levels_count: 1, config: {} }] }
    if (s.includes('SELECT id, manager_id FROM')) return { rows: HIERARCHY }
    if (s.includes('FROM "tenant_sotra".absences a')) return { rows: opts.absences ?? [] }
    if (s.includes('FROM "tenant_sotra".expense_reports er')) return { rows: opts.expenses ?? [] }
    return { rows: [] }
  })
}

const absence = (over: Record<string, unknown> = {}) => ({
  id: 'abs-1', employee_id: 'emp-1', first_name: 'Yao', last_name: 'Koffi', label: 'Congés payés',
  detail: '2026-11-02 → 2026-11-06 (5 j)', validation_level: 0,
  submitted_at: new Date(Date.now() - 2 * HOUR).toISOString(), approval_trail: [], ...over,
})
const report = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1', employee_id: 'emp-1', first_name: 'Yao', last_name: 'Koffi', label: 'Mission Bouaké',
  detail: '45000 FCFA', validation_level: 0,
  submitted_at: new Date(Date.now() - 2 * HOUR).toISOString(), approval_trail: [], ...over,
})

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(approvalsRoutes, { prefix: '/approvals' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /approvals/pending', () => {
  it('le N+1 voit la demande de son collaborateur, actionnable, échéance proche', async () => {
    routeSql({ absences: [absence({ submitted_at: new Date(Date.now() - 20 * HOUR).toISOString() })] })
    const res = await app.inject({ method: 'GET', url: '/approvals/pending', headers: { authorization: `Bearer ${tokenFor('manager', 'n1')}` } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ module: 'absences', employeeName: 'Yao Koffi', dueSoon: true })
    expect(body.data[0].workflow).toMatchObject({ canAct: true, next: { kind: 'manager', level: 1 } })
    expect(body.summary).toMatchObject({ actionable: 1, overdue: 0, dueSoon: 1 })
  })

  it('le N+1 en retard : compté en retard', async () => {
    routeSql({ absences: [absence({ submitted_at: new Date(Date.now() - 30 * HOUR).toISOString() })] })
    const res = await app.inject({ method: 'GET', url: '/approvals/pending', headers: { authorization: `Bearer ${tokenFor('manager', 'n1')}` } })
    expect(JSON.parse(res.body).summary).toMatchObject({ actionable: 1, overdue: 1, dueSoon: 0 })
  })

  it('RH : absence invisible avant le visa N+1, note de frais visible en lecture seule', async () => {
    routeSql({ absences: [absence()], expenses: [report()] })
    const res = await app.inject({ method: 'GET', url: '/approvals/pending', headers: { authorization: `Bearer ${tokenFor('hr_manager', 'rh-1')}` } })
    const body = JSON.parse(res.body)
    expect(body.data.map((d: { module: string }) => d.module)).toEqual(['expenses'])
    expect(body.data[0].workflow.canAct).toBe(false)
    expect(body.summary).toMatchObject({ actionable: 0, readOnly: 1 })
  })

  it('RH : l’absence visée par le N+1 arrive dans sa file, actionnable', async () => {
    const visa = new Date(Date.now() - HOUR).toISOString()
    routeSql({ absences: [absence({ validation_level: 1, approval_trail: [{ step: 1, kind: 'manager', by: 'u-n1', byEmployeeId: 'n1', at: visa }] })] })
    const res = await app.inject({ method: 'GET', url: '/approvals/pending', headers: { authorization: `Bearer ${tokenFor('hr_officer', 'rh-1')}` } })
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].workflow).toMatchObject({ canAct: true, next: { kind: 'hr' } })
  })

  it('ses propres demandes n’y figurent jamais', async () => {
    routeSql({ absences: [absence({ employee_id: 'rh-1', validation_level: 0 })] })
    const res = await app.inject({ method: 'GET', url: '/approvals/pending', headers: { authorization: `Bearer ${tokenFor('hr_manager', 'rh-1')}` } })
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('un salarié sans équipe ne voit rien', async () => {
    routeSql({ absences: [absence()], expenses: [report()] })
    const res = await app.inject({ method: 'GET', url: '/approvals/pending', headers: { authorization: `Bearer ${tokenFor('employee', 'emp-9')}` } })
    expect(JSON.parse(res.body)).toMatchObject({ data: [], summary: { actionable: 0, overdue: 0, dueSoon: 0, readOnly: 0 } })
  })

  it('sans authentification : 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/approvals/pending' })
    expect(res.statusCode).toBe(401)
  })
})
