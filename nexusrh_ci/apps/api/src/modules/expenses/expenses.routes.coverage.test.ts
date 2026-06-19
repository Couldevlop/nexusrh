import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux (mêmes patterns que expenses.routes.test.ts) ─────────────────
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

// emitIntegrationEvent (expense.approved) — best-effort, non bloquant
vi.mock('../../services/integrations.service.js', () => ({
  emitIntegrationEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import expensesRoutes from './expenses.routes.js'

const TENANT = 'tenant_sotra'
const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

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
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 6 * 1024 * 1024 } })
  await app.register(expensesRoutes, { prefix: '/expenses' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

// ── GET /expenses (liste RH) ───────────────────────────────────────────────────
describe('GET /expenses — liste, filtres et RBAC manager', () => {
  it('hr_manager liste toutes les notes (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r-1' }, { id: 'r-2' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/expenses?status=submitted&employee_id=' + UUID_A + '&limit=10&offset=5',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(2)
  })

  it('un manager voit uniquement les notes de son équipe (scope manager_id)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'mgr-emp' }] }) // SELECT employee id du manager
      .mockResolvedValueOnce({ rows: [{ id: 'r-eq' }] })    // SELECT notes équipe
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const teamSelect = queryMock.mock.calls.find((c) => String(c[0]).includes('e.manager_id'))
    expect(teamSelect).toBeDefined()
  })

  it('manager sans dossier employé : pas de filtre équipe ajouté, liste quand même (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })           // SELECT employee id → vide
      .mockResolvedValueOnce({ rows: [{ id: 'r' }] }) // SELECT notes
    const token = tokenFor(app, 'manager', { email: 'orphan@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('erreur DB sur la liste renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /expenses/my-expenses (IDOR : scope token.employeeId) ───────────────────
describe('GET /expenses/my-expenses — scope self-service', () => {
  it('employee avec employeeId : filtre direct sur son id (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r-1', lines: [] }] })
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'GET', url: '/expenses/my-expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('employee sans employeeId : résout via email (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A }] }) // SELECT id from email
      .mockResolvedValueOnce({ rows: [] })               // SELECT notes
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/expenses/my-expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('aucun dossier employé : renvoie data vide (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT id from email → vide
    const token = tokenFor(app, 'employee', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/expenses/my-expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('erreur DB renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'GET', url: '/expenses/my-expenses',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── GET /expenses/:id (scope par rôle) ──────────────────────────────────────────
describe('GET /expenses/:id — accès et scope par rôle', () => {
  it('hr_manager accède à toute note (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_email: 'x@sotra.ci' }] }) // report
      .mockResolvedValueOnce({ rows: [{ id: 'l-1' }] })                                 // lines
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.lines).toHaveLength(1)
  })

  it('note introuvable renvoie 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('employee accède à SA propre note (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_email: 'kouassi@sotra.ci' }] })
      .mockResolvedValueOnce({ rows: [] }) // lines
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('employee ne peut PAS accéder à la note d\'un autre (403 IDOR)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_email: 'autre@sotra.ci' }] })
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('manager accède à la note de son équipe directe (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_email: 'team@sotra.ci' }] }) // report
      .mockResolvedValueOnce({ rows: [{ id: 'e-1' }] })                                    // managerCanActOnReport → ok
      .mockResolvedValueOnce({ rows: [] })                                                 // lines
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('manager hors équipe : 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, employee_email: 'team@sotra.ci' }] }) // report
      .mockResolvedValueOnce({ rows: [] })                                                 // managerCanActOnReport → vide
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('erreur DB renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: `/expenses/${UUID_A}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /expenses (création) ───────────────────────────────────────────────────
describe('POST /expenses — création, garde-fous, catch', () => {
  it('employee sans dossier employé : 422', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT employee → vide
    const token = tokenFor(app, 'employee', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Note' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('hr_manager avec employee_id explicite et sans lignes : crée (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'r-1', total_amount: 0 }] }) // INSERT report
      .mockResolvedValueOnce({ rows: [] })                               // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Note RH', employee_id: UUID_B, month: '2026-02' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('plus de 50 lignes : rejet Zod (400) avant tout calcul', async () => {
    // Zod borne lines à .max(50) : 51 lignes → 400 (le garde-fou total > 500 M
    // est inatteignable car 50 × 10 M = 500 M, jamais STRICTEMENT supérieur).
    const lines = Array.from({ length: 51 }, () => ({ description: 'X', date: '2026-01-15', amount: 10_000_000 }))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Mega', employee_id: UUID_B, lines },
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB sur INSERT renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('insert fail'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'POST', url: '/expenses',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Note', employee_id: UUID_B, lines: [{ description: 'A', date: '2026-01-01', amount: 1000 }] },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /expenses/:id/submit ──────────────────────────────────────────────────
describe('PATCH /expenses/:id/submit — workflow brouillon→soumis', () => {
  it('employee soumet SA note brouillon (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ email: 'kouassi@sotra.ci' }] })        // ownership check
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'submitted' }] })  // UPDATE
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/submit`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('employee ne peut PAS soumettre la note d\'un autre (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ email: 'autre@sotra.ci' }] })
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/submit`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('employee : note introuvable → 403', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // ownership check vide
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/submit`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('hr_manager soumet sans ownership check (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'submitted' }] }) // UPDATE
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/submit`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('note non modifiable (pas en draft) : 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE 0 rows
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/submit`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/submit`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /expenses/:id/approve ─────────────────────────────────────────────────
describe('PATCH /expenses/:id/approve — succès, événement, erreurs', () => {
  it('manager approuve une note de son équipe + émet expense.approved (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'e-1' }] }) // managerCanActOnReport → ok
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'approved', total_amount: 12000, employee_id: 'emp-1' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('note non approvable (pas en submitted) : 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE 0 rows
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB sur UPDATE renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /expenses/:id/reject ──────────────────────────────────────────────────
describe('PATCH /expenses/:id/reject — validation body, succès, erreurs', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/expenses/not-uuid/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un motif au-delà de 1000 caractères (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'x'.repeat(1001) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('manager rejette une note de son équipe (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'e-1' }] }) // managerCanActOnReport → ok
      .mockResolvedValueOnce({ rows: [{ id: UUID_A, status: 'rejected', employee_id: 'emp-1' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Justificatif manquant' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('note non refusable (pas en submitted) : 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE 0 rows
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── PATCH /expenses/:id/pay ─────────────────────────────────────────────────────
describe('PATCH /expenses/:id/pay — remboursement', () => {
  it('refuse un id non-UUID (400)', async () => {
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/expenses/not-uuid/pay',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('note non remboursable (pas approved) : 400', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // UPDATE 0 rows
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/pay`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('erreur DB renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db'))
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: `/expenses/${UUID_A}/pay`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(500)
  })
})

// ── POST /expenses/:id/lines ────────────────────────────────────────────────────
describe('POST /expenses/:id/lines — ajout de ligne', () => {
  it('ajoute une ligne et recalcule le total (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: UUID_A, status: 'draft' }] }) // SELECT ownership
      .mockResolvedValueOnce({ rows: [{ id: 'l-1', amount: 5000 }] }) // INSERT line
      .mockResolvedValueOnce({ rows: [] })                            // UPDATE total
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Repas Plateau', date: '2026-01-15', amount: 5000, category: 'repas' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('erreur DB renvoie 500', async () => {
    queryMock.mockRejectedValueOnce(new Error('db'))
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'X', date: '2026-01-15', amount: 5000 },
    })
    expect(res.statusCode).toBe(500)
  })

  // OWASP A01 (IDOR) — un employé ne peut pas greffer une ligne sur le rapport d'un autre
  it('refuse un employé qui cible le rapport d’un autre (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ employee_id: 'someone-else', status: 'draft' }] }) // SELECT ownership
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Repas', date: '2026-01-15', amount: 5000 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuse un rapport introuvable (404)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT ownership → vide
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Repas', date: '2026-01-15', amount: 5000 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuse l’ajout sur un rapport non brouillon (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ employee_id: UUID_A, status: 'submitted' }] }) // SELECT ownership
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Repas', date: '2026-01-15', amount: 5000 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepte une ligne avec un justificatif (data URL) (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: UUID_A, status: 'draft' }] }) // SELECT ownership
      .mockResolvedValueOnce({ rows: [{ id: 'l-2', amount: 5000 }] })              // INSERT line
      .mockResolvedValueOnce({ rows: [] })                                         // UPDATE total
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        description: 'Repas', date: '2026-01-15', amount: 5000,
        receiptUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
    })
    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('expense_lines'))
    expect(insertCall?.[1]?.[5]).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('refuse un justificatif au format non autorisé (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: `/expenses/${UUID_A}/lines`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        description: 'Repas', date: '2026-01-15', amount: 5000,
        receiptUrl: 'javascript:alert(1)',
      },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── POST /expenses/receipts/upload ──────────────────────────────────────────────
function multipartBody(boundary: string, file?: { name: string; filename: string; type: string; content: string | Buffer }) {
  const parts: Buffer[] = []
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      'utf-8',
    ))
    parts.push(typeof file.content === 'string' ? Buffer.from(file.content, 'utf-8') : file.content)
    parts.push(Buffer.from('\r\n', 'utf-8'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
  return Buffer.concat(parts)
}

describe('POST /expenses/receipts/upload — justificatif (multipart)', () => {
  it('accepte un PNG et renvoie un data URL (200)', async () => {
    const boundary = '----rec1'
    const payload = multipartBody(boundary, { name: 'file', filename: 'recu.png', type: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses/receipts/upload',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.receiptUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('refuse un format non autorisé (400)', async () => {
    const boundary = '----rec2'
    const payload = multipartBody(boundary, { name: 'file', filename: 'x.exe', type: 'application/x-msdownload', content: 'MZ' })
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses/receipts/upload',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse une requête sans fichier (400)', async () => {
    const boundary = '----rec3'
    const payload = multipartBody(boundary)
    const token = tokenFor(app, 'employee', { employeeId: UUID_A })
    const res = await app.inject({
      method: 'POST', url: '/expenses/receipts/upload',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })
})
