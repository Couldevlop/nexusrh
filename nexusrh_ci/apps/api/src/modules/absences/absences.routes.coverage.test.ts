import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux (mêmes patterns que absences.routes.test.ts) ─────────────────
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

// emitIntegrationEvent (absence.approved) — best-effort, non bloquant
vi.mock('../../services/integrations.service.js', () => ({
  emitIntegrationEvent: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import absencesRoutes from './absences.routes.js'

const TENANT_SCHEMA = 'tenant_sotra'
const UUID_AT = '11111111-1111-1111-1111-111111111111'

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
  await app.register(absencesRoutes, { prefix: '/absences' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { queryMock.mockReset() })

// ── GET /absences (liste RH) ────────────────────────────────────────────────────
describe('GET /absences — liste, filtres, RBAC manager', () => {
  it('hr_manager liste avec filtres employeeId, status, year (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'a-1' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET',
      url: '/absences?employeeId=emp-1&status=approved&year=2024',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('manager : filtre automatique sur son équipe (manager_id)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'mgr-emp' }] }) // SELECT id du manager
      .mockResolvedValueOnce({ rows: [{ id: 'a-eq' }] })    // SELECT absences équipe
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/absences',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const teamSelect = queryMock.mock.calls.find((c) => String(c[0]).includes('e.manager_id'))
    expect(teamSelect).toBeDefined()
  })

  it('manager sans dossier employé : pas de filtre équipe, liste quand même (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })             // SELECT id manager → vide
      .mockResolvedValueOnce({ rows: [{ id: 'a' }] })  // SELECT absences
    const token = tokenFor(app, 'manager', { email: 'orphan@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/absences',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

// ── GET /absences/my-absences ───────────────────────────────────────────────────
describe('GET /absences/my-absences — scope self-service', () => {
  it('employee avec employeeId : filtre direct (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'a-1' }] })
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'GET', url: '/absences/my-absences',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('employee sans employeeId : résolution via email (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-resolved' }] }) // SELECT id from email
      .mockResolvedValueOnce({ rows: [] })                       // SELECT absences
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/absences/my-absences',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('aucun dossier employé : data vide (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT id from email → vide
    const token = tokenFor(app, 'employee', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/absences/my-absences',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
})

// ── GET /absences/balances ──────────────────────────────────────────────────────
describe('GET /absences/balances — soldes congés CI', () => {
  it('employee : soldes via employeeId du token (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ acquired: 25, taken: 5, remaining: 20 }] })
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'GET', url: '/absences/balances',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('RH avec employeeId en query (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/absences/balances?employeeId=emp-9',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('employee sans employeeId : résolution via email (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-resolved' }] }) // SELECT id from email
      .mockResolvedValueOnce({ rows: [] })                       // SELECT balances
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/absences/balances',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('aucun dossier employé : data vide (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT id from email → vide
    const token = tokenFor(app, 'employee', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'GET', url: '/absences/balances',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
})

// ── GET /absences/types ─────────────────────────────────────────────────────────
describe('GET /absences/types — types CI', () => {
  it('liste les types actifs (200)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'at-1', label: 'Congés payés' }] })
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'GET', url: '/absences/types',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
})

// ── POST /absences ──────────────────────────────────────────────────────────────
describe('POST /absences — création, jours ouvrables, demi-journée', () => {
  it('employee sans dossier employé : 422', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT id from email → vide
    const token = tokenFor(app, 'employee', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'POST', url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: { absenceTypeId: UUID_AT, startDate: '2026-01-05', endDate: '2026-01-09' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('employee sans employeeId : résolution via email puis création (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-resolved' }] }) // SELECT id from email
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-05', end_date: '2026-01-09' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'POST', url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: { absenceTypeId: UUID_AT, startDate: '2026-01-05', endDate: '2026-01-09' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('demi-journée : days = 0.5 (201)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-05', end_date: '2026-01-05' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST', url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: { absenceTypeId: UUID_AT, startDate: '2026-01-05', endDate: '2026-01-05', halfDay: true },
    })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('absences'))
    // params: [employeeId, typeId, start, end, days, half_day, reason]
    expect(insert?.[1]?.[4]).toBe(0.5)
    expect(insert?.[1]?.[5]).toBe(true)
  })
})

// ── PATCH /absences/:id/approve — workflow multi-niveaux ────────────────────────
describe('PATCH /absences/:id/approve — workflow multi-niveaux', () => {
  it('workflow 2 niveaux : premier passage reste submitted (niveau 1/2)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 2 }] }) // workflow_configs
      .mockResolvedValueOnce({ rows: [{ validation_level: 0, status: 'submitted', employee_id: 'emp-1', days: 3, absence_type_id: 'at-1' }] }) // SELECT absence
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-01', status: 'submitted' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.fullyApproved).toBe(false)
    expect(body.message).toContain('1/2')
  })

  it('absence déjà rejetée → 422', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ validation_level: 0, status: 'rejected', employee_id: 'emp-1', days: 2, absence_type_id: 'at-1' }] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('rejetée')
  })

  it('workflow_configs absent : défaut 1 niveau → approuve directement (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // workflow_configs vide → défaut 1
      .mockResolvedValueOnce({ rows: [{ validation_level: 0, status: 'submitted', employee_id: 'emp-1', days: 3, absence_type_id: 'at-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-01', status: 'approved' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).fullyApproved).toBe(true)
  })
})

// ── PATCH /absences/:id/reject — succès ─────────────────────────────────────────
describe('PATCH /absences/:id/reject — succès et auto-approbation interdite', () => {
  it('absence introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT absence vide
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH', url: '/absences/unknown/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('manager peut rejeter une absence de son équipe directe (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-team', days: 3, absence_type_id: 'at-1', start_date: '2026-02-01' }] }) // SELECT absence
      .mockResolvedValueOnce({ rows: [{ id: 'emp-team' }] }) // managerCanActOnAbsence → ok
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', status: 'rejected' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'manager', { employeeId: 'manager-1', email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Sous-effectif' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('absence.rejected')
  })

  it('manager sans employeeId : auto-approbation interdite → 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-self', days: 2, absence_type_id: 'at-1', start_date: '2026-02-01' }] }) // SELECT absence
    const token = tokenFor(app, 'manager', { email: 'manager@sotra.ci' }) // employeeId null
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── PATCH /absences/:id/cancel — annulation self-service par l'employé ───────────
describe('PATCH /absences/:id/cancel — annulation par l\'employé', () => {
  it('employee annule sa propre demande en attente (200) + restaure le solde + audit', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-1', days: 3, absence_type_id: 'at-1', start_date: '2026-03-01', status: 'pending' }] }) // SELECT absence
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', status: 'cancelled' }] }) // UPDATE absence
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'employee', { sub: 'u-emp', employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/cancel',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.status).toBe('cancelled')
    const balanceCall = queryMock.mock.calls.find((c) => String(c[0]).includes('absence_balances'))
    expect(balanceCall?.[1]?.[0]).toBe(3) // jours restaurés
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall?.[1]?.[1]).toBe('absence.cancelled')
  })

  it('employee sans employeeId : résolution via email puis annulation (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-resolved' }] }) // SELECT id from email
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-resolved', days: 1, absence_type_id: 'at-1', start_date: '2026-03-01', status: 'submitted' }] }) // SELECT absence
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', status: 'cancelled' }] }) // UPDATE absence
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // audit_log
    const token = tokenFor(app, 'employee', { email: 'kouassi@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/cancel',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('OWASP A01 (IDOR) : annulation de l\'absence d\'un autre employé → 404', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-autre', days: 3, absence_type_id: 'at-1', start_date: '2026-03-01', status: 'pending' }] }) // SELECT absence d'un autre
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/cancel',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
    // pas d'UPDATE déclenché
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('UPDATE'))).toBe(false)
  })

  it('absence déjà approuvée : annulation refusée → 409', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ employee_id: 'emp-1', days: 3, absence_type_id: 'at-1', start_date: '2026-03-01', status: 'approved' }] }) // SELECT absence
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/cancel',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(409)
  })

  it('absence introuvable → 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT absence vide
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/unknown/cancel',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('employee sans dossier employé : 422', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT id from email → vide
    const token = tokenFor(app, 'employee', { email: 'ghost@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/cancel',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(422)
  })
})

// ── PATCH /absences/:id/approve — manager sur sa propre absence (auto-interdite) ─
describe('PATCH /absences/:id/approve — auto-approbation interdite', () => {
  it('manager ne peut pas approuver sa propre absence → 403', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] }) // workflow_configs
      .mockResolvedValueOnce({ rows: [{ validation_level: 0, status: 'submitted', employee_id: 'manager-1', days: 3, absence_type_id: 'at-1' }] }) // SELECT absence = la sienne
    const token = tokenFor(app, 'manager', { employeeId: 'manager-1', email: 'manager@sotra.ci' })
    const res = await app.inject({
      method: 'PATCH', url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})
