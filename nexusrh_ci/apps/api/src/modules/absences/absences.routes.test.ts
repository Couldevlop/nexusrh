import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux ──────────────────────────────────────────────────────────────
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
// Congés payés : calculs purs réels, accès base neutralisés (mocks pg séquentiels)
vi.mock('../../services/paid-leave.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/paid-leave.service.js')>()
  const { CIV_2024 } = await import('../../services/legislation-packs.js')
  const policy = actual.effectiveLeavePolicy(CIV_2024.leaveRules, null)
  return {
    ...actual,
    loadLeavePolicy: vi.fn(async () => policy),
    loadLeavePolicyForEmployee: vi.fn(async () => policy),
    refreshPaidLeaveBalance: vi.fn(async () => ({ year: 2026, mode: 'monthly' as const, accrued: 0, carriedOver: 0,
      acquired: 0, taken: 0, pending: 0, remaining: 0, monthsServed: 0 })),
    checkPaidLeaveRequest: vi.fn(async () => null),
    averageRemuneration: vi.fn(async () => null),
  }
})
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

import authPlugin from '../../plugins/auth.js'
import absencesRoutes from './absences.routes.js'

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

// ── Setup ──────────────────────────────────────────────────────────────────────
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(absencesRoutes, { prefix: '/absences' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
})

// Mock pg routé par fragment SQL (l'ordre des requêtes du circuit de validation
// varie selon le cas : configuration, hiérarchie, demande, mise à jour…).
function routeSql(routes: Array<[string, unknown[]]>) {
  queryMock.mockImplementation(async (sql: string) => {
    const hit = routes.find(([needle]) => String(sql).includes(needle))
    return { rows: hit ? hit[1] : [] }
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────
describe('POST /absences — validation Zod (OWASP A03)', () => {
  it('refuse un body sans absenceTypeId (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST',
      url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: { startDate: '2026-01-01', endDate: '2026-01-05' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('invalides')
  })

  it('refuse un format de date invalide (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST',
      url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        absenceTypeId: '11111111-1111-1111-1111-111111111111',
        startDate: '01/02/2026', endDate: '05/02/2026',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse un absenceTypeId non-UUID (400)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST',
      url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        absenceTypeId: 'pas-un-uuid',
        startDate: '2026-01-01', endDate: '2026-01-05',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('ABS-003 — refuse une date de début postérieure à la fin (400, aucune création)', async () => {
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST', url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        absenceTypeId: '11111111-1111-1111-1111-111111111111',
        startDate: '2026-01-10', endDate: '2026-01-05', // début > fin
      },
    })
    expect(res.statusCode).toBe(400)
    // aucun INSERT ne doit avoir été tenté
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('absences'))).toBe(false)
  })

  it('accepte un body valide et persiste, logue audit_log absence.created', async () => {
    routeSql([
      ['absence_types', [{ code: 'CP', calculation_mode: 'working_days' }]],
      ['INSERT INTO "tenant_sotra".absences', [{ id: 'abs-1', start_date: '2027-03-01', end_date: '2027-03-05' }]],
    ])

    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST',
      url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        absenceTypeId: '11111111-1111-1111-1111-111111111111',
        startDate: '2027-03-01', endDate: '2027-03-05',
        reason: 'Vacances',
      },
    })
    expect(res.statusCode).toBe(201)
    // Vérifie qu'un INSERT audit_log a bien été appelé avec action='absence.created'
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.[1]?.[1]).toBe('absence.created')
  })
})

describe('POST /absences — solde de congés payés', () => {
  const payload = {
    absenceTypeId: '11111111-1111-1111-1111-111111111111',
    startDate: '2027-03-01', endDate: '2027-03-05',
  }
  const balance = { year: 2026, mode: 'monthly' as const, accrued: 2.2, carriedOver: 0,
    acquired: 2.2, taken: 0, pending: 0, remaining: 2.2, monthsServed: 1 }

  it('solde insuffisant en mode blocage → 422, aucune demande créée', async () => {
    const pl = await import('../../services/paid-leave.service.js')
    vi.mocked(pl.checkPaidLeaveRequest).mockResolvedValueOnce({
      balance, requested: 5, available: 2.2, insufficient: true, blocked: true,
    })
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({ method: 'POST', url: '/absences', headers: { authorization: `Bearer ${token}` }, payload })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('2.2 j disponible')
    expect(queryMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('absences'))).toBe(false)
  })

  it('solde insuffisant en mode avertissement → 201 + warning', async () => {
    const pl = await import('../../services/paid-leave.service.js')
    vi.mocked(pl.checkPaidLeaveRequest).mockResolvedValueOnce({
      balance, requested: 5, available: 2.2, insufficient: true, blocked: false,
    })
    routeSql([
      ['absence_types', [{ code: 'CP', calculation_mode: 'working_days' }]],
      ['INSERT INTO "tenant_sotra".absences', [{ id: 'abs-2', start_date: '2027-03-01', end_date: '2027-03-05' }]],
    ])
    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({ method: 'POST', url: '/absences', headers: { authorization: `Bearer ${token}` }, payload })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).warning).toContain('dépassé')
  })
})

describe('PATCH /absences/:id/approve — RBAC manager (OWASP A01)', () => {
  it('un manager NE PEUT PAS approuver l\'absence d\'un employé hors équipe (403)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] }) // workflow_configs
      .mockResolvedValueOnce({ rows: [{
        validation_level: 0, status: 'submitted',
        employee_id: 'emp-2', days: 5, absence_type_id: 'at-1',
      }] }) // SELECT absence
      .mockResolvedValueOnce({ rows: [] }) // SELECT employees (vérif manager) — retourne vide

    const token = tokenFor(app, 'manager', { employeeId: 'manager-1' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe directe')
  })

  it('le N+1 vise l\'absence de son équipe directe : elle part à la RH (pas encore approuvée)', async () => {
    routeSql([
      ['workflow_configs', [{ levels_count: 1, config: {} }]],
      ['SELECT id, manager_id FROM', [{ id: 'emp-team', manager_id: 'manager-1' }, { id: 'manager-1', manager_id: null }]],
      ['SELECT validation_level', [{
        validation_level: 0, status: 'submitted', created_at: new Date().toISOString(),
        employee_id: 'emp-team', days: 3, absence_type_id: 'at-1', approval_trail: [],
      }]],
      ['UPDATE "tenant_sotra".absences', [{ id: 'abs-1', start_date: '2026-01-01', status: 'submitted' }]],
    ])

    const token = tokenFor(app, 'manager', { employeeId: 'manager-1' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.fullyApproved).toBe(false)
    expect(body.message).toContain('validation RH')
    const update = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE "tenant_sotra".absences'))
    expect(update?.[1]?.[0]).toBe(1) // validation_level : visa N+1 franchi
    expect(update?.[1]?.[1]).toBe('submitted')
  })

  it('un hr_manager décide une absence arrivée à l\'étape RH (N\'IMPORTE QUEL employé du tenant)', async () => {
    routeSql([
      ['workflow_configs', [{ levels_count: 1, config: {} }]],
      ['SELECT validation_level', [{
        validation_level: 0, status: 'submitted', created_at: new Date().toISOString(),
        employee_id: 'emp-quiconque', days: 3, absence_type_id: 'at-1', approval_trail: [],
      }]], // sans N+1 : l'étape courante est directement la RH
      ['UPDATE "tenant_sotra".absences', [{ id: 'abs-1', start_date: '2026-01-01' }]],
    ])

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('renvoie 404 si l\'absence n\'existe pas', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] })
      .mockResolvedValueOnce({ rows: [] }) // pas d'absence

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/unknown/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuse une seconde approbation (déjà approved → 422)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{
        validation_level: 1, status: 'approved',
        employee_id: 'emp-1', days: 2, absence_type_id: 'at-1',
      }] })

    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('PATCH /absences/:id/reject — RBAC manager + audit_log', () => {
  it('un manager NE PEUT PAS rejeter une absence hors équipe (403)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        employee_id: 'emp-foreign', days: 4, absence_type_id: 'at-1', start_date: '2026-02-01',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // SELECT employees vide

    const token = tokenFor(app, 'manager', { employeeId: 'manager-1' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Période chargée' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('un hr_officer rejette correctement et déclenche audit_log absence.rejected', async () => {
    routeSql([
      ['SELECT employee_id, days', [{
        employee_id: 'emp-1', days: 2, absence_type_id: 'at-1', start_date: '2026-03-01',
        validation_level: 0, status: 'submitted', created_at: new Date().toISOString(), approval_trail: [],
      }]],
      ['UPDATE "tenant_sotra".absences', [{ id: 'abs-1', status: 'rejected' }]],
    ])

    const token = tokenFor(app, 'hr_officer')
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/reject',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Solde insuffisant' },
    })
    expect(res.statusCode).toBe(200)
    const auditCall = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.[1]?.[1]).toBe('absence.rejected')
  })
})

// ── OWASP A01-2 — IDOR sur les soldes de congés ────────────────────────────────
describe('GET /absences/balances — IDOR employeeId (OWASP A01-2)', () => {
  it('un employee NE PEUT PAS lire les soldes d\'un collègue via ?employeeId (forcé sur le sien)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT absence_balances
    const token = tokenFor(app, 'employee', { employeeId: 'emp-moi' })
    const res = await app.inject({
      method: 'GET', url: '/absences/balances?employeeId=emp-collegue',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // La requête doit porter sur SON dossier, jamais sur celui passé en query.
    const balancesCall = queryMock.mock.calls.find((c) => String(c[0]).includes('absence_balances'))
    expect(balancesCall).toBeDefined()
    expect(balancesCall?.[1]?.[0]).toBe('emp-moi')
    expect(balancesCall?.[1]?.[0]).not.toBe('emp-collegue')
  })

  it('un readonly NE PEUT PAS cibler un employé arbitraire (param ignoré)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT employees par email (pas d'employeeId au token)
      .mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'readonly')
    const res = await app.inject({
      method: 'GET', url: '/absences/balances?employeeId=emp-cible',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // Aucune requête ne doit référencer emp-cible
    expect(queryMock.mock.calls.some((c) => JSON.stringify(c[1] ?? []).includes('emp-cible'))).toBe(false)
  })

  it('un manager NE PEUT PAS lire les soldes hors de son équipe directe (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // SELECT employees ... manager_id → vide
    const token = tokenFor(app, 'manager', { employeeId: 'mgr-1' })
    const res = await app.inject({
      method: 'GET', url: '/absences/balances?employeeId=emp-hors-equipe',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('équipe directe')
  })

  it('un manager PEUT lire les soldes d\'un subordonné direct (200)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'emp-equipe' }] }) // vérif manager_id
      .mockResolvedValueOnce({ rows: [{ remaining: 12 }] })    // SELECT balances
    const token = tokenFor(app, 'manager', { employeeId: 'mgr-1' })
    const res = await app.inject({
      method: 'GET', url: '/absences/balances?employeeId=emp-equipe',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('un hr_manager conserve la portée tenant (?employeeId honoré)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const token = tokenFor(app, 'hr_manager')
    const res = await app.inject({
      method: 'GET', url: '/absences/balances?employeeId=emp-9',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const balancesCall = queryMock.mock.calls.find((c) => String(c[0]).includes('absence_balances'))
    expect(balancesCall?.[1]?.[0]).toBe('emp-9')
  })
})
