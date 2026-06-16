import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ─── Mocks globaux (même pattern que absences.routes.test.ts) ────────────────
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))

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
import orgChartRoutes from './org-chart.routes.js'

const TENANT_SCHEMA = 'tenant_sotra'

const DEPT_ROWS = [
  { id: 'dir', name: 'Direction Générale', code: 'DG', manager_id: 'e1', parent_id: null },
  { id: 'expl', name: 'Exploitation', code: 'EXP', manager_id: 'e2', parent_id: 'dir' },
]
const EMP_ROWS = [
  { id: 'e1', first_name: 'Aya', last_name: 'Koné', job_title: 'DG', department_id: 'dir', manager_id: null, profile_photo_url: null },
  { id: 'e2', first_name: 'Jean', last_name: 'Brou', job_title: 'Chef', department_id: 'expl', manager_id: 'e1', profile_photo_url: null },
]

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: 'u-' + role,
    tenantId: 't1',
    schemaName: TENANT_SCHEMA,
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
  await app.register(orgChartRoutes, { prefix: '/org-chart' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] }) // défaut (audit_log non bloquant)
})

describe('GET /org-chart/departments', () => {
  it('renvoie l\'arbre des services pour un rôle RH (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: DEPT_ROWS })
      .mockResolvedValueOnce({ rows: EMP_ROWS })
    const res = await app.inject({
      method: 'GET',
      url: '/org-chart/departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: Array<{ id: string; children: unknown[] }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.id).toBe('dir')
    expect(body.data[0]?.children).toHaveLength(1)
  })

  it('OWASP A01 — refuse le rôle employee (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/org-chart/departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse l\'accès sans token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/org-chart/departments' })
    expect(res.statusCode).toBe(401)
  })

  it('OWASP A02 — la requête employés ne sélectionne aucun champ sensible', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: DEPT_ROWS })
      .mockResolvedValueOnce({ rows: EMP_ROWS })
    await app.inject({
      method: 'GET',
      url: '/org-chart/departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    const sqls = queryMock.mock.calls.map((c) => String(c[0]).toLowerCase())
    const empSql = sqls.find((s) => s.includes('from "tenant_sotra".employees')) ?? ''
    expect(empSql).not.toContain('base_salary')
    expect(empSql).not.toContain('nni')
    expect(empSql).not.toContain('iban')
  })
})

describe('GET /org-chart/reporting', () => {
  it('renvoie la hiérarchie managériale pour un manager (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: DEPT_ROWS })
      .mockResolvedValueOnce({ rows: EMP_ROWS })
    const res = await app.inject({
      method: 'GET',
      url: '/org-chart/reporting',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> }
    expect(body.data[0]?.id).toBe('e1')
  })
})

describe('GET /org-chart/export.svg', () => {
  it('renvoie un SVG téléchargeable (200, image/svg+xml)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: DEPT_ROWS })
      .mockResolvedValueOnce({ rows: EMP_ROWS })
    const res = await app.inject({
      method: 'GET',
      url: '/org-chart/export.svg?type=departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/svg+xml')
    expect(res.headers['content-disposition']).toContain('organigramme.svg')
    expect(res.body).toContain('<svg')
    expect(res.body).toContain('Direction')
  })
})

describe('GET /org-chart/export.pdf', () => {
  it('renvoie un PDF téléchargeable (200, application/pdf)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: DEPT_ROWS })
      .mockResolvedValueOnce({ rows: EMP_ROWS })
    const res = await app.inject({
      method: 'GET',
      url: '/org-chart/export.pdf?type=reporting',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })

  it('OWASP A09 — l\'export écrit une entrée audit_log', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: DEPT_ROWS })
      .mockResolvedValueOnce({ rows: EMP_ROWS })
    await app.inject({
      method: 'GET',
      url: '/org-chart/export.pdf?type=departments',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
    expect(String(auditCall?.[0])).toContain('orgchart.export')
  })
})
