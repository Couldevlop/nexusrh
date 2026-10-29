/**
 * Soumission CONTRÔLÉE d'une période-filiale par son RAF.
 *
 *   - GET  /periods/:id/readiness       : manques par salarié + validation des variables
 *   - GET  /periods/:id/variables       : feuille de variables
 *   - PUT  /periods/:id/variables/:emp  : saisie (invalide la validation de la ligne)
 *   - POST /periods/:id/variables/:emp/validate : « variables saisies » / « aucune variable »
 *   - POST /periods/:id/submit-by-raf   : refusée tant que la readiness n'est pas verte
 *   - GET  /periods?scope=raf           : uniquement les périodes-filles du RAF
 *
 * Mocks SQL séquentiels (mockResolvedValueOnce) pour les refus, routés par
 * SQL pour le parcours complet de génération.
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
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import workflowRoutes from './payroll-workflow.routes.js'
import { variablesFingerprint } from '../../services/raf-readiness.service.js'

const SCHEMA  = 'tenant_raf'
const PARENT  = '11111111-1111-1111-1111-111111111111'
const CHILD   = '22222222-2222-2222-2222-222222222222'
const LE_BFA  = '33333333-3333-3333-3333-333333333333'
const EMP     = '44444444-4444-4444-4444-444444444444'
const RAF     = '55555555-5555-5555-5555-555555555555'
const OTHER   = '66666666-6666-6666-6666-666666666666'

function tokenFor(app: FastifyInstance, role: string, sub: string) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@raf.ci`, firstName: 'R', lastName: 'F', employeeId: null,
  })
}

function child(over: Record<string, unknown> = {}) {
  return {
    id: CHILD, month: '2026-10', status: 'sent_to_sites', raf_user_id: RAF,
    parent_period_id: PARENT, legal_entity_id: LE_BFA, legislation_pack_code: 'BFA-2024', ...over,
  }
}

function employee(over: Record<string, unknown> = {}) {
  return {
    id: EMP, first_name: 'Issa', last_name: 'Ouédraogo', base_salary: '50000',
    marital_status: 'married', children_count: 0, cnps_number: 'CNSS-BF-01',
    payment_method: 'mobile_money', mobile_money_phone: '+22670000000', mobile_money_provider: 'orange',
    has_iban: false, hire_date: null, legal_entity_id: LE_BFA, exit_date: null,
    offboarding_id: null, departure_type: null, settlement: null, nni: null, ...over,
  }
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(workflowRoutes, { prefix: '/payroll-workflow' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

const sqlCalls = (): string[] => queryMock.mock.calls.map(c => String(c[0]))

describe('GET /payroll-workflow/periods/:id/readiness', () => {
  it('liste les manques par salarié (enfants = 0 accepté, SMIG BFA 45 000)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })                                   // période
      .mockResolvedValueOnce({ rows: [
        employee(),                                                                // complet (50 000 ≥ 45 000)
        employee({ id: 'e-2', cnps_number: null, marital_status: null, children_count: null }),
        employee({ id: 'e-3', payment_method: 'bank_transfer', has_iban: false, base_salary: '40000' }),
        employee({ id: 'e-0', base_salary: '0', cnps_number: null }),               // hors paie
      ] })                                                                         // population
      .mockResolvedValueOnce({ rows: [] })                                          // variable_elements
      .mockResolvedValueOnce({ rows: [] })                                          // validations
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${CHILD}/readiness`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
    })
    expect(res.statusCode).toBe(200)
    const { data } = JSON.parse(res.body)
    expect(data.smig).toBe(45_000)
    expect(data.totalEmployees).toBe(3)
    const byId = new Map<string, { missing: string[] }>(data.employees.map((e: { id: string; missing: string[] }) => [e.id, e]))
    expect(byId.get(EMP)!.missing).toEqual([])
    expect(byId.get('e-2')!.missing).toEqual(['marital_status', 'children_count', 'cnps_number'])
    expect(byId.get('e-3')!.missing).toEqual(['iban', 'below_smig'])
    expect(byId.has('e-0')).toBe(false)
    expect(data.variablesValidated).toBe(false)
    expect(data.ready).toBe(false)
  })

  it('IDOR : un autre RAF est refusé (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child()] })
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${CHILD}/readiness`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', OTHER)}` },
    })
    expect(res.statusCode).toBe(403)
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('période mère refusée (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child({ id: PARENT, parent_period_id: null, legal_entity_id: null, raf_user_id: null })] })
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${PARENT}/readiness`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', OTHER)}` },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('période mère')
  })

  it('identifiant invalide (400) et rôle non autorisé (403)', async () => {
    const bad = await app.inject({
      method: 'GET', url: '/payroll-workflow/periods/not-a-uuid/readiness',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', OTHER)}` },
    })
    expect(bad.statusCode).toBe(400)
    const emp = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${CHILD}/readiness`,
      headers: { authorization: `Bearer ${tokenFor(app, 'employee', OTHER)}` },
    })
    expect(emp.statusCode).toBe(403)
  })
})

describe('POST /payroll-workflow/periods/:id/submit-by-raf — contrôle obligatoire', () => {
  const le = { at_rate: '0.020', name: 'Filiale Ouaga', city: 'Ouagadougou' }

  it('refusée si un dossier salarié est incomplet (400 + liste structurée), aucun bulletin', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })                                  // période
      .mockResolvedValueOnce({ rows: [le] })                                        // filiale
      .mockResolvedValueOnce({ rows: [employee({ cnps_number: null })] })           // population
      .mockResolvedValueOnce({ rows: [] })                                          // variable_elements
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP, mode: 'none', variables_hash: variablesFingerprint({}), validated_at: null, validated_by: RAF }] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.code).toBe('RAF_NOT_READY')
    expect(body.readiness.employees[0].missing).toEqual(['cnps_number'])
    expect(sqlCalls().some(q => q.includes('pay_slips'))).toBe(false)
  })

  it('refusée si les variables du mois ne sont pas validées (400)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })
      .mockResolvedValueOnce({ rows: [le] })
      .mockResolvedValueOnce({ rows: [employee()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })                                          // aucune validation
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.readiness.dataComplete).toBe(true)
    expect(body.readiness.variablesValidated).toBe(false)
    expect(body.error).toContain('variables du mois')
  })

  it('refusée si les variables ont changé après la validation (invalidation)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })
      .mockResolvedValueOnce({ rows: [le] })
      .mockResolvedValueOnce({ rows: [employee()] })
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP, rule_code: 'PRIME_RENDEMENT', amount: '15000' }] })
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP, mode: 'entered', variables_hash: variablesFingerprint({ PRIME_RENDEMENT: 10000 }), validated_at: null, validated_by: RAF }] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).readiness.employees[0].validation.valid).toBe(false)
  })

  it('refuse une période mère (400)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child({ id: PARENT, parent_period_id: null, legal_entity_id: null })] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${PARENT}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', OTHER)}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('IDOR : un autre RAF ne peut pas soumettre (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child()] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', OTHER)}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('acceptée quand tout est complet et validé → bulletins (absences injustifiées retenues)', async () => {
    const values = { PRIME_RENDEMENT: 10000, ABSENCE_INJ: 2 }
    const run = async (vals: Record<string, number>): Promise<{ status: number; gross: number }> => {
      queryMock.mockReset()
      queryMock.mockImplementation(async (sql: unknown) => {
        const q = String(sql)
        if (q.includes(`FROM "${SCHEMA}".pay_periods WHERE id = $1`) && !/UPDATE/i.test(q)) return { rows: [child()] }
        if (q.includes('.legal_entities')) return { rows: [le] }
        if (q.includes('payroll_variable_validations')) {
          return { rows: [{ employee_id: EMP, mode: 'entered', variables_hash: variablesFingerprint(vals), validated_at: null, validated_by: RAF }] }
        }
        if (q.includes('.employees')) return { rows: [employee()] }
        if (q.includes('.variable_elements')) {
          return { rows: Object.entries(vals).map(([rule_code, amount]) => ({ employee_id: EMP, rule_code, amount: String(amount), subject_social: null, subject_tax: null })) }
        }
        if (/UPDATE/i.test(q) && q.includes('.pay_periods')) return { rows: [{ id: CHILD, status: 'completed_by_site' }] }
        return { rows: [] }
      })
      const res = await app.inject({
        method: 'POST', url: `/payroll-workflow/periods/${CHILD}/submit-by-raf`,
        headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
      })
      const body = JSON.parse(res.body)
      return { status: res.statusCode, gross: body.summary?.totalGross ?? 0 }
    }
    const withAbsence = await run(values)
    expect(withAbsence.status).toBe(200)
    expect(sqlCalls().some(q => q.includes('INSERT INTO') && q.includes('pay_slips'))).toBe(true)
    const withoutAbsence = await run({ PRIME_RENDEMENT: 10000 })
    expect(withoutAbsence.status).toBe(200)
    // 2 jours d'absence injustifiée retenus sur la base (50 000 / jours ouvrables × 2)
    expect(withoutAbsence.gross).toBeGreaterThan(withAbsence.gross)
  })
})

describe('Feuille de variables RAF', () => {
  it('GET /variables : lignes + codes + readiness (admin)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })
      .mockResolvedValueOnce({ rows: [employee()] })
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP, rule_code: 'PRIME_PANIER', amount: '5000' }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/payroll-workflow/periods/${CHILD}/variables`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager', OTHER)}` },
    })
    expect(res.statusCode).toBe(200)
    const { data } = JSON.parse(res.body)
    expect(data.editable).toBe(true)
    expect(data.codes.map((c: { code: string }) => c.code)).toContain('ABSENCE_INJ')
    expect(data.rows[0].values).toEqual({ PRIME_PANIER: 5000 })
    expect(data.readiness.validatedCount).toBe(0)
  })

  it('PUT : enregistre dans variable_elements et invalide la validation de la ligne', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })                 // période
      .mockResolvedValueOnce({ rows: [employee()] })              // population (salarié)
      .mockResolvedValueOnce({ rows: [] })                        // DELETE codes à 0
      .mockResolvedValueOnce({ rows: [] })                        // INSERT … ON CONFLICT
      .mockResolvedValueOnce({ rows: [] })                        // DELETE validation
      .mockResolvedValueOnce({ rows: [] })                        // audit
    const res = await app.inject({
      method: 'PUT', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
      payload: { values: { HEURES_SUPP_FERIE: 12000, ABSENCE_INJ: 1 } },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.validationReset).toBe(true)
    const calls = queryMock.mock.calls
    const insert = calls.find(c => String(c[0]).includes('INSERT INTO "tenant_raf".variable_elements'))!
    expect(insert[1]).toEqual([EMP, CHILD, '2026-10', ['HEURES_SUPP_FERIE', 'ABSENCE_INJ'], expect.any(Array), [12000, 1]])
    expect(calls.some(c => String(c[0]).includes('DELETE FROM "tenant_raf".payroll_variable_validations'))).toBe(true)
  })

  it('PUT : valeurs invalides (négatif, décimal, absences > 31 j, code inconnu) → 400', async () => {
    for (const values of [{ PRIME_RENDEMENT: -1 }, { PRIME_RENDEMENT: 10.5 }, { ABSENCE_INJ: 40 }, { AVANCE: 1000 }]) {
      const res = await app.inject({
        method: 'PUT', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}`,
        headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
        payload: { values },
      })
      expect(res.statusCode).toBe(400)
    }
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('PUT : IDOR autre RAF (403) / salarié hors filiale (404) / période soumise (409)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child()] })
    const other = await app.inject({
      method: 'PUT', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', OTHER)}` },
      payload: { values: { PRIME_PANIER: 1000 } },
    })
    expect(other.statusCode).toBe(403)

    queryMock.mockResolvedValueOnce({ rows: [child()] }).mockResolvedValueOnce({ rows: [] })
    const outside = await app.inject({
      method: 'PUT', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
      payload: { values: { PRIME_PANIER: 1000 } },
    })
    expect(outside.statusCode).toBe(404)

    queryMock.mockResolvedValueOnce({ rows: [child({ status: 'completed_by_site' })] })
    const done = await app.inject({
      method: 'PUT', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
      payload: { values: { PRIME_PANIER: 1000 } },
    })
    expect(done.statusCode).toBe(409)
  })

  it('validate : « aucune variable » refusé si des variables existent (409)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })
      .mockResolvedValueOnce({ rows: [employee()] })
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP, rule_code: 'PRIME_PANIER', amount: '5000' }] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}/validate`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
      payload: { mode: 'none' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('validate : « variables saisies » mémorise l\'empreinte courante', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [child()] })
      .mockResolvedValueOnce({ rows: [employee()] })
      .mockResolvedValueOnce({ rows: [{ employee_id: EMP, rule_code: 'PRIME_PANIER', amount: '5000' }] })
      .mockResolvedValueOnce({ rows: [] })                        // INSERT validation
      .mockResolvedValueOnce({ rows: [] })                        // audit
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}/validate`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', RAF)}` },
      payload: { mode: 'entered' },
    })
    expect(res.statusCode).toBe(200)
    const insert = queryMock.mock.calls.find(c => String(c[0]).includes('INSERT INTO "tenant_raf".payroll_variable_validations'))!
    expect(insert[1]).toEqual([CHILD, EMP, 'entered', variablesFingerprint({ PRIME_PANIER: 5000 }), RAF])
  })

  it('validate : IDOR autre RAF (403)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child()] })
    const res = await app.inject({
      method: 'POST', url: `/payroll-workflow/periods/${CHILD}/variables/${EMP}/validate`,
      headers: { authorization: `Bearer ${tokenFor(app, 'raf_site', OTHER)}` },
      payload: { mode: 'none' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /payroll-workflow/periods?scope=raf', () => {
  it('admin : uniquement les périodes-filles dont il est le RAF (jamais la mère)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [child({ raf_user_id: OTHER })] })
    const res = await app.inject({
      method: 'GET', url: '/payroll-workflow/periods?scope=raf',
      headers: { authorization: `Bearer ${tokenFor(app, 'admin', OTHER)}` },
    })
    expect(res.statusCode).toBe(200)
    const [sql, params] = queryMock.mock.calls[0]! as [string, unknown[]]
    expect(sql).toContain('pp.raf_user_id = $1')
    expect(sql).toContain('pp.legal_entity_id IS NOT NULL')
    expect(sql).toContain('pp.parent_period_id IS NOT NULL')
    expect(params).toEqual([OTHER])
  })
})
