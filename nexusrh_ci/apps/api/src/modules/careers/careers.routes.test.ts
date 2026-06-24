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
import careersRoutes from './careers.routes.js'

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
  await app.register(careersRoutes, { prefix: '/careers' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

describe('POST /careers/skills — Zod (OWASP A03)', () => {
  it('refuse skill sans name (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { category: 'IT' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('crée la compétence et trace audit_log career.skill_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'sk-1', name: 'React' }] })
      .mockResolvedValueOnce({ rows: [] })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'React', category: 'IT' },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('career.skill_created')
  })
})

describe('GET /careers/employee-skills/:id — IDOR (OWASP A01)', () => {
  it('refuse un employeeId non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/careers/employee-skills/not-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un employee NE PEUT PAS voir les compétences d\'un collègue (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas propriétaire de l'id

    const token = tokenFor(app, 'employee', { email: 'me@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/careers/employee-skills/${EMP_B}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un employee voit ses propres compétences (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // ownership match
      .mockResolvedValueOnce({ rows: [] })              // SELECT skills

    const token = tokenFor(app, 'employee', { email: 'me@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/careers/employee-skills/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('un manager NE PEUT PAS voir les compétences hors équipe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas dans équipe

    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/careers/employee-skills/${EMP_B}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PUT /careers/employee-skills — Zod + IDOR manager (OWASP A01 + A03)', () => {
  it('refuse un level > 5 (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PUT', url: '/careers/employee-skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, skills: [{ skill_id: EMP_B, level: 10 }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un manager NE PEUT PAS modifier les compétences hors équipe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas équipe

    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'PUT', url: '/careers/employee-skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_B, skills: [{ skill_id: EMP_A, level: 3 }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('hr_manager met à jour 1 compétence et trace audit_log career.skills_updated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // INSERT/UPDATE skill
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PUT', url: '/careers/employee-skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, skills: [{ skill_id: EMP_B, level: 4, target_level: 5 }] },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('career.skills_updated')
  })
})

describe('POST /careers/evaluations — Zod + IDOR manager (OWASP A01 + A03)', () => {
  it('refuse score hors échelle 0-5 (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, global_score: 6 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un type d\'évaluation hors énum (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, type: 'random_type' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('un manager NE PEUT PAS créer une évaluation hors équipe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // pas équipe

    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_B, global_score: 4 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('hr_manager crée l\'évaluation et trace audit_log career.evaluation_created', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'eval-1' }] })  // SELECT evaluator
      .mockResolvedValueOnce({ rows: [{ id: 'ev-1', employee_id: EMP_A }] }) // INSERT eval
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, type: 'annual', global_score: 4, year: 2026 },
    })
    expect(res.statusCode).toBe(201)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('career.evaluation_created')
  })

  it('accepte year en chaîne et type « trial_end » de l\'UI (régression mismatch front↔back)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'eval-2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ev-2', employee_id: EMP_A }] })
      .mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      // year envoyé en chaîne par le formulaire (coerce), type fin d'essai
      payload: { employee_id: EMP_A, type: 'trial_end', global_score: 4, year: '2026' },
    })
    expect(res.statusCode).toBe(201)
  })
})

describe('PATCH /careers/evaluations/:id — IDOR + audit_log', () => {
  it('refuse id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/careers/evaluations/not-uuid',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'completed' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse status hors énum (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'super_validated' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('hr_manager modifie et trace audit_log career.evaluation_updated', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'eval-1', status: 'completed' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'completed', global_score: 4 },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('career.evaluation_updated')
  })
})
