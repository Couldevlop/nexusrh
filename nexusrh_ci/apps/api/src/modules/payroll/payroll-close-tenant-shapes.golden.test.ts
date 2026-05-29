/**
 * Golden test E2E — Clôture de paie selon la FORME du tenant.
 *
 * Le handler `POST /payroll/periods/:month/close` est le point de bascule entre
 * les deux topologies clientes de NexusRH CI :
 *
 *   • Tenant SANS filiale (has_subsidiaries = false) :
 *       clôture mono-entité → tous les employés actifs du tenant, pack/at_rate
 *       résolus au niveau tenant (resolvePayrollContext → source 'tenant_global').
 *       `legalEntityId` est interdit/ignoré, la requête employés N'EST PAS scopée.
 *
 *   • Tenant AVEC filiales (has_subsidiaries = true) :
 *       `legalEntityId` est OBLIGATOIRE (400 sinon) → la clôture est scopée à la
 *       filiale, le moteur reçoit l'at_rate + le pack législatif de CETTE filiale
 *       (resolvePayrollContext → source 'legal_entity').
 *
 * Ce test verrouille ce branchement bout-à-bout : routage, scoping SQL, mapping
 * des paramètres vers le moteur et agrégation des totaux. Le moteur CI réel
 * (`calculatePayrollCI`) et le résolveur réel (`resolvePayrollContext`) servent
 * d'ORACLE : on recalcule les bulletins attendus exactement comme le handler et
 * on compare les totaux FCFA renvoyés par la route. La justesse interne du moteur
 * est par ailleurs couverte par golden.fixtures (1070 cas).
 *
 * Isolation : pg routé par SQL (aucune connexion), redis/config/migrations mockés.
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
// Oracle : on importe les VRAIS moteur + résolveur (non mockés) — exactement les
// instances utilisées par le handler.
import { calculatePayrollCI } from '../../services/payroll-engine-ci.js'
import { resolvePayrollContext } from '../../services/payroll-context-resolver.js'

const SCHEMA = 'tenant_sotra'
const MONTH  = '2024-12'
const LE_CI  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PERIOD_ID = '11111111-1111-1111-1111-111111111111'

// ── Réplique exacte de getWorkingDays() du handler (lundi–samedi, hors dimanche) ──
function getWorkingDays(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate()
  let count = 0
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() !== 0) count++
  }
  return count
}
const WDM = getWorkingDays(2024, 12)

interface EmpRow {
  id: string; base_salary: string; marital_status: string; children_count: number
  mobile_money_provider: string; mobile_money_phone: string
  first_name: string; last_name: string; cnps_number: string; nni: string
  hire_date: string | null; legal_entity_id: string | null
}

function emp(p: Partial<EmpRow> & { id: string; base_salary: string }): EmpRow {
  return {
    marital_status: 'single', children_count: 0,
    mobile_money_provider: 'wave', mobile_money_phone: '+2250700000000',
    first_name: 'Test', last_name: 'Employe', cnps_number: 'C1', nni: 'N1',
    hire_date: '2020-01-01', legal_entity_id: null,
    ...p,
  }
}

// ── Oracle : recalcule un bulletin comme le handler (sans absence → prorata plein) ──
function oracleSlip(
  e: EmpRow,
  tenantInfo: Parameters<typeof resolvePayrollContext>[0]['tenant'],
  legalEntityInfo: Parameters<typeof resolvePayrollContext>[0]['legalEntity'],
) {
  const resolved = resolvePayrollContext({
    tenant:      tenantInfo,
    employee:    { id: e.id, legalEntityId: e.legal_entity_id },
    legalEntity: legalEntityInfo,
  })
  return calculatePayrollCI({
    baseSalary:       parseInt(e.base_salary),
    workedDays:       WDM,
    workingDaysMonth: WDM,
    atRate:           resolved.atRate,
    maritalStatus:    e.marital_status,
    childrenCount:    e.children_count,
    variableElements: {},
    legislationPack:  resolved.legislationPack,
  })
}

function oracleTotals(
  emps: EmpRow[],
  tenantInfo: Parameters<typeof resolvePayrollContext>[0]['tenant'],
  legalEntityInfo: Parameters<typeof resolvePayrollContext>[0]['legalEntity'],
) {
  return emps.reduce(
    (acc, e) => {
      const r = oracleSlip(e, tenantInfo, legalEntityInfo)
      acc.grossSalary += r.grossSalary
      acc.netPayable  += r.netPayable
      acc.cnps        += r.totalCnpsSal + r.totalCnpsPat
      acc.its         += r.its
      return acc
    },
    { grossSalary: 0, netPayable: 0, cnps: 0, its: 0 },
  )
}

// ── Mock pg routé par SQL (insensible à l'ordre/au nombre de requêtes) ───────────
function routeQueries(opts: {
  tenant: { id: string; has_subsidiaries: boolean; at_rate: string; default_country_code: string | null }
  legalEntityRows?: Array<{ id: string; at_rate: string | null; legislation_pack_code: string | null; country_code: string | null; name: string }>
  employees: EmpRow[]
  existing?: Array<{ id: string; status: string }>
}) {
  let slipSeq = 0
  queryMock.mockImplementation(async (sql: unknown) => {
    const q = String(sql)
    if (q.includes('platform.tenants'))            return { rows: [opts.tenant] }
    if (q.includes('.legal_entities'))             return { rows: opts.legalEntityRows ?? [] }
    if (q.includes('.variable_elements'))          return { rows: [] }
    if (q.includes('.absences'))                   return { rows: [] }   // aucune absence
    if (q.includes('.pay_slips'))                  return { rows: [{ id: `slip-${++slipSeq}` }] }
    if (q.includes('.pay_periods')) {
      if (/^\s*UPDATE/i.test(q)) return { rows: [] }
      if (/INSERT\s+INTO/i.test(q)) return { rows: [{ id: PERIOD_ID }] }
      return { rows: opts.existing ?? [] }                              // SELECT existing
    }
    if (q.includes('.employees'))                  return { rows: opts.employees }
    return { rows: [] }
  })
}

function tokenFor(app: FastifyInstance, role: string) {
  return app.jwt.sign({
    sub: `u-${role}`, tenantId: 't1', schemaName: SCHEMA, role,
    email: `${role}@sotra.ci`, firstName: 'A', lastName: 'B', employeeId: null,
  })
}

function employeesSqlCall() {
  return queryMock.mock.calls.find((c) => /FROM\s+"[^"]+"\.employees/i.test(String(c[0])))
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
describe('Clôture paie — Tenant SANS filiale (mono-entité)', () => {
  const TENANT = { id: 't-mono', has_subsidiaries: false, at_rate: '0.020', default_country_code: 'CIV' }
  const TENANT_INFO = { id: 't-mono', hasSubsidiaries: false, atRate: 0.02, defaultCountryCode: 'CIV' }
  // Profils variés : prorata plein, SMIG, haut salaire (plafonds CNPS + tranches ITS)
  const EMPLOYEES = [
    emp({ id: 'e1', base_salary: '200000', marital_status: 'married', children_count: 2 }),
    emp({ id: 'e2', base_salary: '60000' }),                       // SMIG
    emp({ id: 'e3', base_salary: '1500000', marital_status: 'married', children_count: 3 }),
  ]

  it('clôture tout le tenant → 200 pending_validation + totaux = oracle moteur CI', async () => {
    routeQueries({ tenant: TENANT, employees: EMPLOYEES })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('pending_validation')
    expect(body.employeesCount).toBe(3)
    expect(body.paySlips).toHaveLength(3)
    expect(body.totals.currency).toBe('XOF')

    const expected = oracleTotals(EMPLOYEES, TENANT_INFO, null)
    expect(body.totals.grossSalary).toBe(expected.grossSalary)
    expect(body.totals.netPayable).toBe(expected.netPayable)
    expect(body.totals.cnps).toBe(expected.cnps)
    expect(body.totals.its).toBe(expected.its)
    // Tous les montants sont des entiers FCFA (zéro décimale)
    expect(body.totals.grossSalary % 1).toBe(0)
    expect(body.totals.netPayable % 1).toBe(0)
  })

  it('la requête employés N\'EST PAS scopée par filiale', async () => {
    routeQueries({ tenant: TENANT, employees: EMPLOYEES })
    await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: {},
    })
    const call = employeesSqlCall()
    expect(call).toBeDefined()
    expect(String(call![0])).not.toContain('legal_entity_id =')
    expect((call![1] as unknown[]) ?? []).toHaveLength(0)
  })

  it('refuse une période déjà clôturée (422)', async () => {
    routeQueries({ tenant: TENANT, employees: EMPLOYEES, existing: [{ id: PERIOD_ID, status: 'closed' }] })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error).toContain('déjà clôturée')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('Clôture paie — Tenant AVEC filiales (multi-entités)', () => {
  const TENANT = { id: 't-grp', has_subsidiaries: true, at_rate: '0.020', default_country_code: 'CIV' }
  const TENANT_INFO = { id: 't-grp', hasSubsidiaries: true, atRate: 0.02, defaultCountryCode: 'CIV' }
  // Filiale BTP : at_rate 3% (≠ tenant 2%) → prouve que le moteur applique le taux filiale
  const LE_ROW = { id: LE_CI, at_rate: '0.030', legislation_pack_code: 'CIV-2024', country_code: 'CIV', name: 'Filiale Abidjan' }
  const LE_INFO = { id: LE_CI, atRate: 0.03, legislationPackCode: 'CIV-2024', countryCode: 'CIV' }
  const EMPLOYEES = [
    emp({ id: 'f1', base_salary: '500000', marital_status: 'married', children_count: 2, legal_entity_id: LE_CI }),
    emp({ id: 'f2', base_salary: '350000', legal_entity_id: LE_CI }),
  ]

  it('SANS legalEntityId → 400 (legalEntityId requis pour scoper la clôture)', async () => {
    routeQueries({ tenant: TENANT, employees: EMPLOYEES })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('legalEntityId requis')
  })

  it('filiale inconnue / inactive → 404', async () => {
    routeQueries({ tenant: TENANT, legalEntityRows: [], employees: EMPLOYEES })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'hr_manager')}` },
      payload: { legalEntityId: LE_CI },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Filiale introuvable')
  })

  it('avec legalEntityId valide → 200, clôture scopée + totaux au taux AT filiale', async () => {
    routeQueries({ tenant: TENANT, legalEntityRows: [LE_ROW], employees: EMPLOYEES })
    const res = await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { legalEntityId: LE_CI },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('pending_validation')
    expect(body.employeesCount).toBe(2)
    expect(body.paySlips).toHaveLength(2)

    // Totaux calculés avec le pack + at_rate de la FILIALE (0.03), pas du tenant
    const expected = oracleTotals(EMPLOYEES, TENANT_INFO, LE_INFO)
    expect(body.totals.grossSalary).toBe(expected.grossSalary)
    expect(body.totals.netPayable).toBe(expected.netPayable)
    expect(body.totals.cnps).toBe(expected.cnps)
    expect(body.totals.its).toBe(expected.its)
  })

  it('la requête employés EST scopée par legal_entity_id', async () => {
    routeQueries({ tenant: TENANT, legalEntityRows: [LE_ROW], employees: EMPLOYEES })
    await app.inject({
      method: 'POST', url: `/payroll/periods/${MONTH}/close`,
      headers: { authorization: `Bearer ${tokenFor(app, 'admin')}` },
      payload: { legalEntityId: LE_CI },
    })
    const call = employeesSqlCall()
    expect(call).toBeDefined()
    expect(String(call![0])).toContain('legal_entity_id = $1')
    expect((call![1] as unknown[])[0]).toBe(LE_CI)
  })

  it('le taux AT filiale (3%) produit une part CNPS patronale > celle au taux tenant (2%)', () => {
    // Garde-fou métier : confirme que la distinction filiale/tenant a un effet réel
    const atFiliale = oracleSlip(EMPLOYEES[0]!, TENANT_INFO, LE_INFO)
    const atTenant  = oracleSlip(EMPLOYEES[0]!, TENANT_INFO, { ...LE_INFO, atRate: 0.02 })
    expect(atFiliale.cnpsAtPat).toBeGreaterThan(atTenant.cnpsAtPat)
  })
})
