import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux (mêmes patterns que contracts.routes.test.ts) ─────────────────
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
const EMP_A = '11111111-1111-1111-1111-111111111111'

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

beforeEach(() => { queryMock.mockReset() })

const validBody = {
  employee_id: EMP_A,
  type: 'cdi' as const,
  start_date: '2026-01-01',
  base_salary: 350000,
  job_title: 'Comptable',
  job_level: 'agent_maitrise',
}

// ── GET /contracts ──────────────────────────────────────────────────────────────
describe('GET /contracts — liste', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('liste sans filtre (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c-1' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('liste avec filtres status, employee_id, type (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'GET',
      url: `/contracts?status=active&employee_id=${EMP_A}&type=cdi`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls[0]
    expect(call?.[1]).toEqual(['active', EMP_A, 'cdi'])
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'GET', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /contracts/:id ──────────────────────────────────────────────────────────
describe('GET /contracts/:id — détail', () => {
  it('renvoie le contrat (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c-1', type: 'cdi' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('404 si introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/contracts/c-x',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /contracts ─────────────────────────────────────────────────────────────
describe('POST /contracts — branches restantes', () => {
  it('refuse un hr_officer (admin/hr_manager seulement, 403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })
    expect(res.statusCode).toBe(403)
  })

  it('calcule une période d\'essai de 30 jours pour un cadre (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'c-1', trial_end_date: '2026-01-31' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, job_level: 'cadre superieur' },
    })
    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO'))
    // 5e paramètre = trial_end_date calculé (start + 30j)
    expect(insertCall?.[1]?.[4]).toBe('2026-01-31')
  })

  it('respecte le trial_end_date fourni explicitement (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'c-2' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, trial_end_date: '2026-03-15' },
    })
    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO'))
    expect(insertCall?.[1]?.[4]).toBe('2026-03-15')
  })

  it('persiste tous les champs optionnels fournis (working_hours, end_date, clauses…) (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'c-3' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...validBody,
        type: 'cdd',
        end_date: '2027-01-01',
        trial_end_date: '2026-02-01',
        working_hours: 35,
        convention: 'Transport urbain CI',
        cnps_affiliation: false,
        ohada_clause: false,
        non_competition_clause: true,
        telecommuting_days: 2,
      },
    })
    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO'))
    expect(insertCall?.[1]?.[6]).toBe(35) // working_hours fourni (pas le défaut 40)
  })

  it('crée un contrat minimal sans job_title ni working_hours (défauts appliqués) (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'c-4' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employee_id: EMP_A,
        type: 'cdi',
        start_date: '2026-01-01',
        base_salary: 200000,
      },
    })
    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO'))
    expect(insertCall?.[1]?.[6]).toBe(40) // working_hours défaut
  })

  it('renvoie 500 si l\'INSERT échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert failed'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/contracts',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /contracts/:id ────────────────────────────────────────────────────────
describe('PATCH /contracts/:id', () => {
  it('refuse un hr_officer (403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'PATCH', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { base_salary: 400000 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse un body sans champ autorisé (400)', async () => {
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { champ_inconnu: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('met à jour plusieurs champs autorisés (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c-1', base_salary: 400000 }] }) // UPDATE
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { base_salary: 400000, status: 'active', job_title: 'Chef comptable' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('404 si le contrat est introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE : aucune ligne
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/contracts/c-x',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'suspended' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('renvoie 500 si l\'UPDATE échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('update failed'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'PATCH', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'active' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /contracts/:id/terminate ───────────────────────────────────────────────
describe('POST /contracts/:id/terminate — branches restantes', () => {
  it('utilise le commentaire par défaut quand comment absent (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-1' }] }) // UPDATE contracts
      .mockResolvedValueOnce({ rows: [] }) // UPDATE employees
      .mockResolvedValueOnce({ rows: [] }) // INSERT hr_events
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-1/terminate',
      headers: { authorization: `Bearer ${token}` },
      payload: { termination_date: '2026-06-30', termination_reason: 'dismissal' },
    })
    expect(res.statusCode).toBe(200)
    const hrEventsCall = queryMock.mock.calls.find((c) => String(c[0]).includes('hr_events'))
    expect(String(hrEventsCall?.[1]?.[2])).toContain('Motif : dismissal')
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-1/terminate',
      headers: { authorization: `Bearer ${token}` },
      payload: { termination_date: '2026-06-30', termination_reason: 'other' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /contracts/:id/renew ───────────────────────────────────────────────────
describe('POST /contracts/:id/renew — renouvellement CDD', () => {
  it('refuse un hr_officer (403)', async () => {
    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-1/renew',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_end_date: '2027-01-01' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404 si le contrat original est introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT orig
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-x/renew',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_end_date: '2027-01-01' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('400 si le contrat n\'est pas un CDD', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c-1', type: 'cdi' }] }) // SELECT orig
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-1/renew',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_end_date: '2027-01-01' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('renouvelle un CDD avec nouveau salaire (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'c-1', type: 'cdd' }] }) // SELECT orig
      .mockResolvedValueOnce({ rows: [{ id: 'c-1', type: 'cdd', end_date: '2027-01-01' }] }) // UPDATE
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-1/renew',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_end_date: '2027-01-01', base_salary: 400000 },
    })
    expect(res.statusCode).toBe(200)
    const updCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updCall?.[1]?.[1]).toBe(400000)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'POST', url: '/contracts/c-1/renew',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_end_date: '2027-01-01' },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /contracts/employee/:employeeId ─────────────────────────────────────────
describe('GET /contracts/employee/:employeeId', () => {
  it('refuse un employee (403)', async () => {
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: `/contracts/employee/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('renvoie les contrats d\'un employé (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'c-1' }, { id: 'c-2' }] })
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: `/contracts/employee/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(2)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'GET', url: `/contracts/employee/${EMP_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /contracts/my-contract ──────────────────────────────────────────────────
describe('GET /contracts/my-contract — self-service', () => {
  it('404 si l\'employé connecté n\'a pas de fiche', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // lookup employé : aucun
    const token = tokenFor(app, 'employee', { email: 'noone@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/contracts/my-contract',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('404 si aucun contrat actif', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // lookup employé
      .mockResolvedValueOnce({ rows: [] })              // SELECT contrat actif : aucun
    const token = tokenFor(app, 'employee', { email: 'me@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/contracts/my-contract',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('renvoie le contrat actif de l\'employé connecté (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: EMP_A }] }) // lookup employé
      .mockResolvedValueOnce({ rows: [{ id: 'c-1', status: 'active' }] }) // SELECT contrat actif
    const token = tokenFor(app, 'employee', { email: 'me@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/contracts/my-contract',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'employee')
    const res = await app.inject({
      method: 'GET', url: '/contracts/my-contract',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── DELETE /contracts/:id ───────────────────────────────────────────────────────
describe('DELETE /contracts/:id — branches restantes', () => {
  it('supprime même si le snapshot est vide (changes null) (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT snapshot : aucune ligne
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValue({ rows: [] })     // audit best-effort
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'DELETE', url: '/contracts/c-gone',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    const changes = JSON.parse(auditCall?.[1]?.[3] as string)
    expect(changes.employeeId).toBeNull()
  })

  it('renvoie 500 si la base échoue', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'admin')
    const res = await app.inject({
      method: 'DELETE', url: '/contracts/c-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})
