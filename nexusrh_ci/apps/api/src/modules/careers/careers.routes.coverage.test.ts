import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux (mêmes patterns que careers.routes.test.ts) ───────────────────
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
const EVAL_ID = '33333333-3333-3333-3333-333333333333'

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

// ── GET /careers/skills ─────────────────────────────────────────────────────────
describe('GET /careers/skills', () => {
  it('refuse un utilisateur non authentifié (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/careers/skills' })
    expect(res.statusCode).toBe(401)
  })

  it('renvoie le référentiel de compétences actives (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'sk-1', name: 'React', is_active: true }] })
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /careers/skills ────────────────────────────────────────────────────────
describe('POST /careers/skills — RBAC + 500', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'POST', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'React' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('renvoie 500 si l\'INSERT échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'React' },
    })
    expect(res.statusCode).toBe(500)
  })

  it('crée une compétence sans catégorie (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'sk-2', name: 'Go' }] }) // INSERT
      .mockResolvedValue({ rows: [] }) // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/careers/skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Go' },
    })
    expect(res.statusCode).toBe(201)
  })
})

// ── GET /careers/employee-skills/:employeeId ────────────────────────────────────
describe('GET /careers/employee-skills/:employeeId — branches restantes', () => {
  it('admin consulte n\'importe quel employé sans contrôle de propriété (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ skill_name: 'React', level: 3 }] }) // SELECT skills
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: `/careers/employee-skills/${EMP_B}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('un manager voit les compétences de son équipe directe (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // userCanActOnEmployee : équipe
      .mockResolvedValueOnce({ rows: [] })              // SELECT skills
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/careers/employee-skills/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('renvoie 500 si le SELECT échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('select failed'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: `/careers/employee-skills/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PUT /careers/employee-skills ────────────────────────────────────────────────
describe('PUT /careers/employee-skills — branches restantes', () => {
  it('admin met à jour plusieurs compétences (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // upsert skill 1
      .mockResolvedValueOnce({ rows: [] }) // upsert skill 2
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PUT', url: '/careers/employee-skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, skills: [
        { skill_id: EMP_A, level: 2 },
        { skill_id: EMP_B, level: 4, target_level: 5 },
      ] },
    })
    expect(res.statusCode).toBe(200)
  })

  it('renvoie 500 si l\'upsert échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('upsert failed'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PUT', url: '/careers/employee-skills',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, skills: [{ skill_id: EMP_B, level: 3 }] },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /careers/evaluations ────────────────────────────────────────────────────
describe('GET /careers/evaluations', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('hr_manager liste avec filtres employee_id, year, status (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'ev-1' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: `/careers/evaluations?employee_id=${EMP_A}&year=2024&status=completed`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('un manager ne voit que les évaluations de son équipe (filtre manager_id)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // lookup mgr
      .mockResolvedValueOnce({ rows: [{ id: 'ev-1' }] }) // SELECT évaluations
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const evalCall = queryMock.mock.calls.find((c) => String(c[0]).includes('e.manager_id'))
    expect(evalCall).toBeDefined()
  })

  it('un manager sans fiche employée ne filtre pas par manager_id', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // lookup mgr : aucune fiche
      .mockResolvedValueOnce({ rows: [] }) // SELECT évaluations
    const token = tokenFor(app, 'manager', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('renvoie 500 si le SELECT échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('select failed'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /careers/evaluations ───────────────────────────────────────────────────
describe('POST /careers/evaluations — branches restantes', () => {
  it('renvoie 500 si l\'INSERT échoue', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'evtor-1' }] }) // SELECT evaluator
      .mockRejectedValueOnce(new Error('insert failed'))     // INSERT eval
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: { employee_id: EMP_A, global_score: 70 },
    })
    expect(res.statusCode).toBe(500)
  })

  it('admin crée une évaluation avec valeurs par défaut (evaluator inconnu)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT evaluator : aucun → evaluatorId null
      .mockResolvedValueOnce({ rows: [{ id: 'ev-2' }] }) // INSERT eval
      .mockResolvedValue({ rows: [] }) // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/careers/evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employee_id: EMP_A,
        comments: 'RAS',
        goals: ['objectif 1'],
        strengths: ['rigueur'],
        improvements: ['communication'],
        training_needs: ['Excel'],
      },
    })
    expect(res.statusCode).toBe(201)
  })
})

// ── PATCH /careers/evaluations/:id ──────────────────────────────────────────────
describe('PATCH /careers/evaluations/:id — branches restantes', () => {
  it('refuse un body sans aucun champ exploitable (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EVAL_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('manager : 404 si l\'évaluation cible est introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT employee_id : introuvable
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EVAL_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { global_score: 60 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('manager : 403 si l\'évaluation concerne un hors-équipe', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP_B }] }) // SELECT employee_id
      .mockResolvedValueOnce({ rows: [] })                       // userCanActOnEmployee : non
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EVAL_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { global_score: 60 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('manager autorisé met à jour son équipe (200, champs JSON + completed_at)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP_A }] }) // SELECT employee_id
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] })          // userCanActOnEmployee : équipe
      .mockResolvedValueOnce({ rows: [{ id: 'ev-1', status: 'completed' }] }) // UPDATE
      .mockResolvedValue({ rows: [] }) // audit best-effort
    const token = tokenFor(app, 'manager', { email: 'mgr@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EVAL_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'completed', goals: ['g1'], comments: 'ok' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('404 si l\'UPDATE ne retourne aucune ligne', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE : introuvable
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EVAL_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { global_score: 80 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('renvoie 500 si l\'UPDATE échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('update failed'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/careers/evaluations/${EVAL_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { global_score: 80 },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /careers/my-evaluations ─────────────────────────────────────────────────
describe('GET /careers/my-evaluations', () => {
  it('refuse non authentifié (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/careers/my-evaluations' })
    expect(res.statusCode).toBe(401)
  })

  it('renvoie liste vide si l\'employé connecté n\'a pas de fiche', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé : aucun
    const token = tokenFor(app, 'employee', { email: 'noone@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/careers/my-evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('renvoie les évaluations de l\'employé connecté (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // lookup employé
      .mockResolvedValueOnce({ rows: [{ id: 'ev-1', type: 'annual' }] }) // SELECT évals
    const token = tokenFor(app, 'employee', { email: 'me@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/careers/my-evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/careers/my-evaluations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /careers/my-skills ──────────────────────────────────────────────────────
describe('GET /careers/my-skills', () => {
  it('renvoie liste vide si pas de fiche employé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé : aucun
    const token = tokenFor(app, 'employee', { email: 'noone@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/careers/my-skills',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('renvoie les compétences de l\'employé connecté (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // lookup employé
      .mockResolvedValueOnce({ rows: [{ skill_name: 'React', level: 4 }] }) // SELECT skills
    const token = tokenFor(app, 'employee', { email: 'me@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/careers/my-skills',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/careers/my-skills',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /careers/nine-box ───────────────────────────────────────────────────────
describe('GET /careers/nine-box — RBAC strict', () => {
  it('refuse un hr_officer (admin/hr_manager seulement, 403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'GET', url: '/careers/nine-box',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('admin renvoie la matrice 9-box avec l\'année par défaut (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: EMP_A, performance: 80, potential: 70 }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/careers/nine-box',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('hr_manager filtre par année explicite (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/careers/nine-box?year=2023',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls.find((c) => String(c[0]).includes('evaluations'))
    expect(call?.[1]?.[0]).toBe(2023)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/careers/nine-box',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})
