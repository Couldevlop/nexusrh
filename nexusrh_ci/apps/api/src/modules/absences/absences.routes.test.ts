import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// ── Mocks globaux ──────────────────────────────────────────────────────────────
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
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-01', end_date: '2026-01-05' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'employee', { employeeId: 'emp-1' })
    const res = await app.inject({
      method: 'POST',
      url: '/absences',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        absenceTypeId: '11111111-1111-1111-1111-111111111111',
        startDate: '2026-01-05', endDate: '2026-01-09',
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

  it('un manager PEUT approuver l\'absence de son équipe directe', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] }) // workflow_configs
      .mockResolvedValueOnce({ rows: [{
        validation_level: 0, status: 'submitted',
        employee_id: 'emp-team', days: 3, absence_type_id: 'at-1',
      }] }) // SELECT absence
      .mockResolvedValueOnce({ rows: [{ id: 'emp-team' }] }) // SELECT employees — manager match
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-01', status: 'approved' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

    const token = tokenFor(app, 'manager', { employeeId: 'manager-1' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/absences/abs-1/approve',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).fullyApproved).toBe(true)
  })

  it('un hr_manager peut approuver l\'absence de N\'IMPORTE QUEL employé du tenant', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ levels_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{
        validation_level: 0, status: 'submitted',
        employee_id: 'emp-quiconque', days: 3, absence_type_id: 'at-1',
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', start_date: '2026-01-01' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

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
    queryMock
      .mockResolvedValueOnce({ rows: [{
        employee_id: 'emp-1', days: 2, absence_type_id: 'at-1', start_date: '2026-03-01',
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'abs-1', status: 'rejected' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE balances
      .mockResolvedValueOnce({ rows: [] }) // INSERT audit_log

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
