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

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptIfPresent: vi.fn((v) => v),
  decryptIfPresent: vi.fn((v) => v),
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

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
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
})

const validEmployee = {
  firstName: 'Marie',
  lastName: 'Konaté',
  email: 'marie.konate@sotra.ci',
  baseSalary: 350000,
  hireDate: '2024-01-15',
  jobTitle: 'Comptable',
  contractType: 'cdi' as const,
}

describe('POST /employees — Zod validation (OWASP A03)', () => {
  it('refuse un body sans firstName/lastName (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { baseSalary: 200000 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un email invalide (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validEmployee, email: 'pas-un-email' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un baseSalary < SMIG (75 000 FCFA) avec 422', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validEmployee, baseSalary: 50000 },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('SMIG')
  })

  it('accepte un body valide, persiste et logue audit_log employee.created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', first_name: 'Marie', last_name: 'Konaté' }] })
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { authorization: `Bearer ${token}` },
      payload: validEmployee,
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('employee.created')
  })
})

describe('PATCH /employees/:id — IDOR + Zod (OWASP A01 + A03)', () => {
  it('un employee NE PEUT PAS modifier un autre employé (403)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: 'emp-self' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/employees/22222222-2222-2222-2222-222222222222',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: '+225 0102030405' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('propre profil')
  })

  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/employees/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: '+225 0102030405' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un employee peut modifier son propre profil (champs self uniquement)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-self', phone: '+225 0102030405' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'employee', { employeeId: '11111111-1111-1111-1111-111111111111' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/employees/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: '+225 0102030405', baseSalary: 999999 }, // baseSalary doit être ignoré
    })
    expect(res.statusCode).toBe(200)
    // L'UPDATE SQL ne doit contenir QUE phone (baseSalary filtré par EMPLOYEE_SELF_FIELDS)
    const updateCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(String(updateCall?.[0])).toContain('phone')
    expect(String(updateCall?.[0])).not.toContain('base_salary')
  })

  it('un hr_manager peut modifier baseSalary, audit_log trace les champs', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1', base_salary: 400000 }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/employees/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token}` },
      payload: { baseSalary: 400000 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('employee.updated')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.modifiedFields).toContain('base_salary')
    expect(changes.bySelf).toBe(false)
  })

  it('refuse baseSalary < SMIG (422)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/employees/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token}` },
      payload: { baseSalary: 50000 },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('DELETE /employees/:id — audit log + UUID validation (OWASP A09)', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'DELETE',
      url: '/employees/not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si l\'employé n\'existe pas ou est déjà archivé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT snapshot vide
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'DELETE',
      url: '/employees/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('archive correctement + trace audit_log employee.archived avec snapshot', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ first_name: 'Marie', last_name: 'Konaté', email: 'm@x.ci', job_title: 'Comptable' }] }) // snapshot
      .mockResolvedValueOnce({ rows: [] }) // UPDATE soft delete
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'DELETE',
      url: '/employees/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('employee.archived')
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.firstName).toBe('Marie')
    expect(changes.lastName).toBe('Konaté')
  })

  it('refuse DELETE par un hr_officer (admin/hr_manager uniquement, 403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'DELETE',
      url: '/employees/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
