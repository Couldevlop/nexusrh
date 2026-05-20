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
import expensesRoutes from './expenses.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'

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
  await app.register(expensesRoutes, { prefix: '/expenses' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('POST /expenses — Zod (OWASP A03)', () => {
  it('refuse body sans title (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { month: '2026-01' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse ligne avec amount négatif (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Test', lines: [{ description: 'Resto', date: '2026-01-15', amount: -1000 }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse ligne avec amount > 10 M FCFA (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Frais', lines: [{ description: 'Mission', date: '2026-01-15', amount: 99_999_999_999 }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse category hors énum (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Frais', lines: [{ description: 'X', date: '2026-01-15', amount: 5000, category: 'achat_illegal' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte body valide, persiste et trace audit_log expense.created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A }] })             // SELECT employee_id from email
      .mockResolvedValueOnce({ rows: [{ id: 'r-1', total_amount: 8000 }] })  // INSERT expense_reports
      .mockResolvedValueOnce({ rows: [] })                            // INSERT expense_lines
      .mockResolvedValueOnce({ rows: [] })                            // INSERT audit_log

    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Mission Yamoussoukro', lines: [{ description: 'Transport', date: '2026-01-15', amount: 8000, category: 'transport' }] },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('expense.created')
  })
})

describe('PATCH /expenses/:id/approve — RBAC manager équipe + audit (OWASP A01 + A09)', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/expenses/not-uuid/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('un manager NE PEUT PAS approuver une note hors équipe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // managerCanActOnReport → false
    const token = tokenFor(app, 'manager', { employeeId: 'mgr-1', email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe directe')
  })

  it('un hr_manager approuve, trace audit_log expense.approved', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'approved', total_amount: 15000, employee_id: 'emp-1' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('expense.approved')
  })
})

describe('PATCH /expenses/:id/reject — RBAC manager + audit', () => {
  it('un manager NE PEUT PAS rejeter une note hors équipe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas équipe
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Hors barème' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un hr_manager rejette, trace audit_log expense.rejected avec motif', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'rejected', employee_id: 'emp-1' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Pièces justificatives manquantes' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('expense.rejected')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.reason).toContain('Pièces')
  })
})

describe('PATCH /expenses/:id/pay — audit log financier (OWASP A09)', () => {
  it('paiement trace audit_log expense.paid avec montant', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'paid', total_amount: 25000, employee_id: 'emp-1' }] })
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/pay`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('expense.paid')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.totalAmount).toBe(25000)
  })

  it('refuse paiement par hr_officer (admin/hr_manager uniquement, 403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/pay`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /expenses/:id/lines — Zod (OWASP A03)', () => {
  it('refuse une ligne avec amount > 10M FCFA (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'X', date: '2026-01-15', amount: 50_000_000 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un id non-UUID sur ajout de ligne (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses/not-uuid/lines',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'X', date: '2026-01-15', amount: 5000 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /expenses/:id — UUID validation', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/expenses/not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})
