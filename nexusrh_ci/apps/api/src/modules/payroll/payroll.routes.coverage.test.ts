/**
 * Couverture exhaustive — payroll.routes.ts
 *
 * Complète les tests existants (payroll.routes.test.ts + golden) en exerçant les
 * handlers et branches non couverts :
 *   - POST /calculate (avec/sans absence, employé introuvable, mois invalide)
 *   - resolveAbsenceForPayroll : maternité, accident_travail, maladie (maintien)
 *   - POST /periods/:month/close : fallbacks colonnes non migrées (catch),
 *     status pending_validation (409), mois invalide (400), tenant introuvable (404)
 *   - GET /periods/:month/workflow (timeline d'approbation, 404, levels par défaut)
 *   - GET /payslips (liste + filtres month/employeeId)
 *   - GET /payslips/:id/transparency (admin, employee IDOR, rôle interdit, 404)
 *   - GET /my-payslips (self-service + lookup email + sans employé)
 *   - GET /my-access-log
 *   - GET /periods
 *   - POST /simulate : branche absence + erreur moteur (422)
 *   - RBAC : hr_officer ne clôture pas, manager/employee refusés
 *
 * Isolation : pg routé par SQL, redis/config/migrations mockés.
 */
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
    ai: { apiKey: '', model: 'test', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'test', apiUrl: 'https://test' },
  },
}))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import payrollRoutes from './payroll.routes.js'
import * as engineModule from '../../services/payroll-engine-ci.js'

const SCHEMA = 'tenant_sotra'
const MONTH  = '2024-12'
const EMP_A  = '11111111-1111-1111-1111-111111111111'
const EMP_B  = '22222222-2222-2222-2222-222222222222'
const SLIP_ID = '33333333-3333-3333-3333-333333333333'
const PERIOD_ID = '44444444-4444-4444-4444-444444444444'

function tokenFor(app: FastifyInstance, role: string, opts: Partial<{
  sub: string; email: string; employeeId: string
}> = {}) {
  return app.jwt.sign({
    sub: opts.sub ?? 'u-' + role,
    tenantId: 't1',
    schemaName: SCHEMA,
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
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll/calculate — bulletin unitaire', () => {
  function empRow(over: Record<string, unknown> = {}) {
    return {
      id: EMP_A, base_salary: '300000', marital_status: 'married', children_count: 2,
      first_name: 'Kouassi', last_name: 'Jean-Paul', cnps_number: 'C1', nni: 'N1',
      mobile_money_provider: 'wave', mobile_money_phone: '+2250700000000',
      hire_date: '2018-01-01', ...over,
    }
  }

  it('hr_officer calcule un bulletin sans absence (200)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [empRow()] }
      if (q.includes('platform.tenants'))              return { rows: [{ at_rate: '0.030' }] }
      if (q.includes('.pay_periods'))                  return { rows: [{ id: PERIOD_ID }] }
      if (q.includes('.variable_elements'))            return { rows: [{ rule_code: 'PRIME_TRANSPORT', amount: '30000' }] }
      if (q.includes('.absences'))                     return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.currency).toBe('XOF')
    expect(body.employee.firstName).toBe('Kouassi')
    expect(body.absence).toBeNull()
    expect(body.result.netPayable).toBeGreaterThan(0)
  })

  it('employé introuvable → 404', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('introuvable')
  })

  it('mois invalide → 400', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [empRow()] }
      if (q.includes('platform.tenants'))              return { rows: [{ at_rate: '0.020' }] }
      if (q.includes('.pay_periods'))                  return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employeeId: EMP_A, month: '2024-13' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Format mois')
  })

  it('avec absence MALADIE (maintien selon ancienneté) → absence renvoyée', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [empRow({ hire_date: '2010-01-01' })] }
      if (q.includes('platform.tenants'))              return { rows: [{ at_rate: '0.020' }] }
      if (q.includes('.pay_periods'))                  return { rows: [{ id: PERIOD_ID }] }
      if (q.includes('.variable_elements'))            return { rows: [] }
      if (q.includes('.absences')) return { rows: [{
        absence_type_slug: 'maladie', start_date: '2024-12-02', end_date: '2024-12-06', days_count: 5,
      }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.absence).not.toBeNull()
    expect(body.absence.type).toBe('maladie_sans_at')
    expect(body.absence.maintienTaux).toBe(1.0) // ≥ 5 ans → 100 %
    expect(body.absence.absenceDays).toBeGreaterThan(0)
  })

  it('avec absence MATERNITÉ (priorité sur maladie)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [empRow({ hire_date: '2023-06-01' })] }
      if (q.includes('platform.tenants'))              return { rows: [{ at_rate: '0.020' }] }
      if (q.includes('.pay_periods'))                  return { rows: [{ id: PERIOD_ID }] }
      if (q.includes('.variable_elements'))            return { rows: [] }
      if (q.includes('.absences')) return { rows: [
        { absence_type_slug: 'maladie',   start_date: '2024-12-02', end_date: '2024-12-03', days_count: 2 },
        { absence_type_slug: 'maternite', start_date: '2024-12-09', end_date: '2024-12-20', days_count: 10 },
      ] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).absence.type).toBe('maternite')
  })

  it('avec absence ACCIDENT DU TRAVAIL (prioritaire sur maladie)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [empRow()] }
      if (q.includes('platform.tenants'))              return { rows: [{ at_rate: '0.020' }] }
      if (q.includes('.pay_periods'))                  return { rows: [{ id: PERIOD_ID }] }
      if (q.includes('.variable_elements'))            return { rows: [] }
      if (q.includes('.absences')) return { rows: [
        { absence_type_slug: 'maladie',          start_date: '2024-12-02', end_date: '2024-12-03', days_count: 2 },
        { absence_type_slug: 'accident_travail',  start_date: '2024-12-09', end_date: '2024-12-13', days_count: 5 },
      ] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).absence.type).toBe('accident_travail')
  })

  it('hire_date null → maintien maladie à 50 % (ancienneté 0)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".employees')) return { rows: [empRow({ hire_date: null })] }
      if (q.includes('platform.tenants'))              return { rows: [{ at_rate: '0.020' }] }
      if (q.includes('.pay_periods'))                  return { rows: [{ id: PERIOD_ID }] }
      if (q.includes('.variable_elements'))            return { rows: [] }
      if (q.includes('.absences')) return { rows: [{
        absence_type_slug: 'maladie', start_date: '2024-12-02', end_date: '2024-12-06', days_count: 5,
      }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).absence.maintienTaux).toBe(0.5)
  })

  it('manager refusé (403 RBAC)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/payroll/calculate',
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
      payload: { employeeId: EMP_A, month: MONTH },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll/periods/:month/close — branches restantes', () => {
  const TENANT = { id: 't-mono', has_subsidiaries: false, at_rate: '0.020', default_country_code: 'CIV' }

  it('tenant introuvable → 404', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Tenant introuvable')
  })

  it('body legalEntityId non-UUID → 400 (Zod)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { legalEntityId: 'pas-un-uuid' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('Validation')
  })

  it('mois invalide → 400', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [TENANT] }
      if (q.includes('.pay_periods'))     return { rows: [] }
      if (q.includes('.employees'))       return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/2024-99/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Format mois')
  })

  it('période déjà en pending_validation → 409 (idempotence)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [TENANT] }
      if (q.includes('.pay_periods'))     return { rows: [{ id: PERIOD_ID, status: 'pending_validation' }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).status).toBe('pending_validation')
  })

  it('hr_officer refusé pour la clôture (403 RBAC)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('période existante en statut OPEN → réutilise son id (pas de nouvel INSERT period)', async () => {
    const emp = {
      id: EMP_A, base_salary: '200000', marital_status: 'single', children_count: 0,
      mobile_money_provider: 'wave', mobile_money_phone: '+2250700000000',
      first_name: 'A', last_name: 'B', cnps_number: 'C1', nni: 'N1',
      hire_date: '2020-01-01', legal_entity_id: null,
    }
    let periodInsert = false
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants'))   return { rows: [TENANT] }
      if (q.includes('.absences'))          return { rows: [] }
      if (q.includes('.variable_elements')) return { rows: [] }
      if (q.includes('.employees'))         return { rows: [emp] }
      if (q.includes('.pay_slips'))         return { rows: [{ id: 'slip-1' }] }
      if (q.includes('.pay_periods')) {
        if (/^\s*INSERT/i.test(q)) { periodInsert = true; return { rows: [{ id: 'new-period' }] } }
        if (/^\s*UPDATE/i.test(q)) return { rows: [] }
        // SELECT existing → période OPEN déjà créée
        return { rows: [{ id: PERIOD_ID, status: 'open' }] }
      }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).periodId).toBe(PERIOD_ID)
    expect(periodInsert).toBe(false) // aucun INSERT de période
  })

  it('fallbacks colonnes non migrées : SELECT/INSERT period + INSERT slip retombent sur les requêtes legacy', async () => {
    // Force le rejet des requêtes "modernes" (legal_entity_id) pour exercer les .catch()
    const emp = {
      id: EMP_A, base_salary: '200000', marital_status: 'single', children_count: 0,
      mobile_money_provider: 'wave', mobile_money_phone: '+2250700000000',
      first_name: 'A', last_name: 'B', cnps_number: 'C1', nni: 'N1',
      hire_date: '2020-01-01', legal_entity_id: null,
    }
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [TENANT] }
      if (q.includes('.absences'))        return { rows: [] }
      if (q.includes('.variable_elements')) return { rows: [] }
      if (q.includes('.employees'))       return { rows: [emp] }
      if (q.includes('.pay_periods')) {
        // SELECT existing avec "IS NOT DISTINCT FROM" → rejette (colonne absente)
        if (/IS NOT DISTINCT FROM/.test(q)) throw new Error('column legal_entity_id does not exist')
        // SELECT existing legacy (fallback) → aucune période
        if (/^\s*SELECT/i.test(q)) return { rows: [] }
        // INSERT moderne avec legal_entity_id → rejette
        if (/^\s*INSERT/i.test(q) && q.includes('legal_entity_id')) throw new Error('column legal_entity_id does not exist')
        // INSERT legacy (fallback)
        if (/^\s*INSERT/i.test(q)) return { rows: [{ id: PERIOD_ID }] }
        // UPDATE final
        return { rows: [] }
      }
      if (q.includes('.pay_slips')) {
        // INSERT moderne avec legal_entity_id (dernier $20) → rejette
        if (q.includes('$20')) throw new Error('column legal_entity_id does not exist')
        // INSERT legacy (fallback)
        return { rows: [{ id: 'slip-legacy-1' }] }
      }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('pending_validation')
    expect(body.employeesCount).toBe(1)
    expect(body.paySlips).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll/periods/:month/reject — branches restantes', () => {
  it('période introuvable → 404', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.pay_periods')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/reject`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { reason: 'Erreur sur calcul — recommencer' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('période non pending_validation → 409', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.pay_periods')) return { rows: [{ id: PERIOD_ID, status: 'open' }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/reject`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { reason: 'Erreur sur calcul — recommencer' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('non éligible')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/periods/:month/workflow — état du workflow', () => {
  it('période introuvable → 404', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.pay_periods')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/payroll/periods/${MONTH}/workflow`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('renvoie timeline + niveaux requis (config) + approbations', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.pay_periods')) return { rows: [{
        id: PERIOD_ID, month: MONTH, status: 'pending_validation',
        initiated_at: '2024-12-31T10:00:00Z', initiated_by: 'u-init',
        rejection_reason: null, closed_at: null, closed_by: null,
        initiator_first_name: 'Awa', initiator_last_name: 'Koné',
      }] }
      if (q.includes('.workflow_configs')) return { rows: [{ levels_count: 2 }] }
      if (q.includes('.pay_period_approvals')) return { rows: [{
        level: 1, approver_id: 'u-app1', approver_role: 'hr_manager',
        approved_at: '2024-12-31T11:00:00Z', notes: 'RAS',
        first_name: 'Yao', last_name: 'Brou',
      }] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/payroll/periods/${MONTH}/workflow`,
      headers: { authorization: `Bearer ${tokenFor(app, 'readonly')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.requiredLevels).toBe(2)
    expect(body.currentLevel).toBe(1)
    expect(body.isComplete).toBe(false)
    expect(body.period.initiatorName).toBe('Awa Koné')
    expect(body.approvals[0].approverName).toBe('Yao Brou')
  })

  it('config workflow absente → niveaux par défaut (2) + aucune approbation', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('.pay_periods')) return { rows: [{
        id: PERIOD_ID, month: MONTH, status: 'pending_validation',
        initiated_at: null, initiated_by: null,
        rejection_reason: null, closed_at: null, closed_by: null,
        initiator_first_name: null, initiator_last_name: null,
      }] }
      if (q.includes('.workflow_configs')) return { rows: [] }
      if (q.includes('.pay_period_approvals')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: `/payroll/periods/${MONTH}/workflow`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.requiredLevels).toBe(2)
    expect(body.currentLevel).toBe(0)
    expect(body.period.initiatorName).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/payslips — liste', () => {
  it('liste tous les bulletins (sans filtre)', async () => {
    queryMock.mockImplementation(async () => ({ rows: [{ id: SLIP_ID, month: MONTH, first_name: 'A', last_name: 'B' }] }))
    const res = await app.inject({
      method: 'GET', url: '/payroll/payslips',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('filtre par month + employeeId (paramètres SQL injectés)', async () => {
    queryMock.mockImplementation(async () => ({ rows: [] }))
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips?month=${MONTH}&employeeId=${EMP_A}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const call = queryMock.mock.calls.find((c) => String(c[0]).includes('FROM "tenant_sotra".pay_slips'))
    expect(call).toBeDefined()
    expect(String(call![0])).toContain('ps.month = $1')
    expect(String(call![0])).toContain('ps.employee_id = $2')
    expect(call![1]).toEqual([MONTH, EMP_A])
  })

  it('employee refusé (403 RBAC)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/payroll/payslips',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/payslips/:id/transparency — drill-down complet', () => {
  function slipRow(over: Record<string, unknown> = {}) {
    return {
      id: SLIP_ID, employee_id: EMP_A, period_id: PERIOD_ID, month: MONTH,
      base_salary: '300000', gross_salary: '300000', net_payable: '270000',
      total_cnps_sal: '18900', total_cnps_pat: '28000', its: '4200',
      employer_cost: '328000', total_deductions: '23100',
      lines: [
        { code: '1000', label: 'Salaire de base', type: 'earning', amount: 300000 },
        { code: '2000', label: 'CNPS Retraite', type: 'employee_contribution', amount: -18900 },
        { code: '3000', label: 'CNPS Retraite Pat.', type: 'employer_contribution', amount: 23100 },
      ],
      first_name: 'Kouassi', last_name: 'Jean-Paul', cnps_number: 'C1', nni: 'N1', job_title: 'Chauffeur',
      period_status: 'closed', initiated_at: '2024-12-31T10:00:00Z', closed_at: '2024-12-31T12:00:00Z',
      generated_at: '2024-12-31T11:00:00Z', viewed_by_employee_at: null,
      payment_status: 'pending', payment_method: 'wave', payment_reference: null, paid_at: null,
      ...over,
    }
  }

  function routeTransparency(slip: Record<string, unknown> | null) {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('FROM "tenant_sotra".pay_slips ps') && q.includes('JOIN "tenant_sotra".employees')) {
        return { rows: slip ? [slip] : [] }
      }
      if (q.includes('ORDER BY month DESC LIMIT 3')) return { rows: [
        { month: '2024-11', gross_salary: '300000', net_payable: '270000', total_cnps_sal: '18900', its: '4200' },
      ] }
      if (q.includes('.audit_log')) return { rows: [
        { action: 'payroll.closed', entity: 'pay_period', created_at: '2024-12-31T12:00:00Z', changes: { month: MONTH }, first_name: 'Awa', last_name: 'Koné' },
      ] }
      if (q.includes('FROM "tenant_sotra".employees WHERE email')) return { rows: [{ id: EMP_A }] }
      return { rows: [] }
    })
  }

  it('admin voit n\'importe quel bulletin (200, totaux calculés)', async () => {
    routeTransparency(slipRow())
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.slip.id).toBe(SLIP_ID)
    expect(body.totals.earnings).toBe(300000)
    expect(body.totals.employeeContributions).toBe(18900)
    expect(body.totals.employerContributions).toBe(23100)
    expect(body.comparison).toHaveLength(1)
    expect(body.audit).toHaveLength(1)
    expect(body.audit[0].actorName).toBe('Awa Koné')
  })

  it('bulletin introuvable → 404', async () => {
    routeTransparency(null)
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('employee accède à SON bulletin (employeeId du token)', async () => {
    routeTransparency(slipRow())
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: EMP_A })}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('employee SANS employeeId → lookup par email puis accès accordé', async () => {
    routeTransparency(slipRow())
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { email: 'employe@sotra.ci' })}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('employee NE PEUT PAS voir le bulletin d\'un autre (403 IDOR)', async () => {
    routeTransparency(slipRow({ employee_id: EMP_B }))
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: EMP_A })}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('manager refusé (403 — paie hors périmètre manager)', async () => {
    routeTransparency(slipRow())
    const res = await app.inject({
      method: 'GET', url: `/payroll/payslips/${SLIP_ID}/transparency`,
      headers: { authorization: `Bearer ${tokenFor(app, 'manager')}` },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('Rôle non autorisé')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/my-payslips — self-service', () => {
  it('employee avec employeeId : marque les bulletins vus + renvoie la liste', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (/^\s*UPDATE/i.test(q)) return { rows: [] }
      if (q.includes('ORDER BY month DESC LIMIT 24')) return { rows: [
        { id: SLIP_ID, month: MONTH, net_payable: '270000' },
      ] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: '/payroll/my-payslips',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { employeeId: EMP_A })}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.currency).toBe('XOF')
    expect(body.data).toHaveLength(1)
  })

  it('employee sans employeeId : lookup par email', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('WHERE email')) return { rows: [{ id: EMP_A }] }
      if (/^\s*UPDATE/i.test(q)) return { rows: [] }
      if (q.includes('ORDER BY month DESC LIMIT 24')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: '/payroll/my-payslips',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { email: 'employe@sotra.ci' })}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })

  it('employé inconnu (aucun match email) → data vide', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('WHERE email')) return { rows: [] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: '/payroll/my-payslips',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { email: 'inconnu@sotra.ci' })}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/my-access-log — journal ARTCI', () => {
  it('renvoie le journal d\'accès (avec lookup email)', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const q = String(sql)
      if (q.includes('WHERE email')) return { rows: [{ id: EMP_A }] }
      if (/^\s*INSERT/i.test(q)) return { rows: [] }
      if (q.includes('ORDER BY al.created_at DESC LIMIT 20')) return { rows: [
        { id: 'a1', user_id: 'u-employee', action: 'READ', entity: 'payslip', entity_id: null, changes: {}, ip_address: '1.2.3.4', created_at: '2024-12-31T12:00:00Z' },
      ] }
      return { rows: [] }
    })
    const res = await app.inject({
      method: 'GET', url: '/payroll/my-access-log',
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', { email: 'employe@sotra.ci' })}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('GET /payroll/periods — liste des périodes', () => {
  it('renvoie les périodes', async () => {
    queryMock.mockImplementation(async () => ({ rows: [{ id: PERIOD_ID, month: MONTH, status: 'closed' }] }))
    const res = await app.inject({
      method: 'GET', url: '/payroll/periods',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_officer')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('POST /payroll/simulate — branches absence + erreur moteur', () => {
  const baseSim = {
    baseSalary: 250000, workedDays: 20, workingDaysMonth: 26,
    atRate: 0.02, maritalStatus: 'single' as const, childrenCount: 0,
  }

  it('simulation avec absence maladie (branche ctx.absence)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // audit
    const res = await app.inject({
      method: 'POST', url: '/payroll/simulate',
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {
        ...baseSim,
        absence: { type: 'maladie_sans_at', absenceDays: 6, maintienTaux: 0.75 },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).meta.mode).toBe('simulation')
  })

  it('le moteur lève une erreur "stub" → 422 (message remonté)', async () => {
    const spy = vi.spyOn(engineModule, 'calculatePayrollCI').mockImplementation(() => {
      throw new Error('Pack législatif "BEN-2024" (status=stub) — refus de calcul')
    })
    try {
      const res = await app.inject({
        method: 'POST', url: '/payroll/simulate',
        headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
        payload: baseSim,
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).error).toContain('stub')
    } finally {
      spy.mockRestore()
    }
  })

  it('le moteur lève une erreur générique → 422 (message masqué)', async () => {
    const spy = vi.spyOn(engineModule, 'calculatePayrollCI').mockImplementation(() => {
      throw new Error('division by zero interne')
    })
    try {
      const res = await app.inject({
        method: 'POST', url: '/payroll/simulate',
        headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
        payload: baseSim,
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).error).toContain('Erreur de calcul')
    } finally {
      spy.mockRestore()
    }
  })
})
