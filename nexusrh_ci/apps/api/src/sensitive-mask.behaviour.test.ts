// Masquage des données sensibles (habilitations) : par famille de routes,
// contexte sans `sensitive` -> valeurs à null (+ maskedFields) ; contexte null
// -> valeurs intactes. Pool mocké par routeur SQL, vrai authPlugin.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn(), connect: vi.fn() })) }))
vi.mock('./services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  setTokenEpoch: vi.fn().mockResolvedValue(undefined),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('./config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))
vi.mock('./utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('./services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from './plugins/auth.js'
import employeesRoutes from './modules/employees/employees.routes.js'
import contractsRoutes from './modules/contracts/contracts.routes.js'
import recruitmentRoutes from './modules/recruitment/recruitment.routes.js'
import reportingRoutes from './modules/reporting/reporting.routes.js'
import { HAB_GRID } from './modules/habilitations/catalog.js'
import type { HabContext } from './services/habilitation.service.js'

const SCHEMA = 'tenant_mask'
const ID = 'bbbbbbbb-1111-4222-8333-444444444444'

let app: FastifyInstance

function ctx(sensitive: boolean): HabContext {
  const perms = Object.entries(HAB_GRID)
    .filter(([fn]) => sensitive || !['payroll', 'declarations', 'payments'].includes(fn))
    .flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: 'u-hab', subgroupId: 'sg-1', kind: 'siege', legalEntityId: null,
    permissions: new Set(perms), allEntities: true, sensitive,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

const EMP = {
  id: ID, first_name: 'Awa', last_name: 'Koné', email: 'awa@t.ci', employee_number: 'E1',
  base_salary: '450000', cnps_number: 'CI123', mobile_money_phone: '0707000000', hire_date: null,
}

async function get(url: string) {
  const token = app.jwt.sign({
    sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'rh@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.register(reportingRoutes, { prefix: '/reporting' })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockImplementation(async (rawSql: string) => {
    const sql = String(rawSql).replace(/\s+/g, ' ')
    if (/count\(\*\)::int AS c/.test(sql)) return { rows: [{ c: 1 }], rowCount: 1 }
    if (/e\.\*/.test(sql)) return { rows: [{ ...EMP }], rowCount: 1 }
    if (/e\.employee_number, e\.last_name/.test(sql)) return { rows: [{ ...EMP, department: 'IT', contract_type: 'cdi', is_active: true }], rowCount: 1 }
    if (/FROM "tenant_mask"\.contracts/.test(sql)) return { rows: [{ id: 'c1', employee_id: ID, base_salary: 450000, first_name: 'Awa' }], rowCount: 1 }
    if (/FROM "tenant_mask"\.applications a/.test(sql)) return { rows: [{ id: 'a1', first_name: 'Y', expected_salary: 600000, cv_blob: null }], rowCount: 1 }
    if (/AS avg_salary/.test(sql)) return { rows: [{ department: 'IT', count: 1, avg_salary: 450000 }], rowCount: 1 }
    if (/base_salary < 100000/.test(sql)) return { rows: [{ range: '> 1M', count: 1 }], rowCount: 1 }
    if (/pay_periods/.test(sql)) return { rows: [{ month: '2026-01', total_gross: 500000, total_net: 400000, total_cnps: 30000, total_its: 20000, employees_count: 1 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
})

describe('employés', () => {
  it('liste : contexte sans sensitive -> salaire/CNPS/téléphone null + maskedFields', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const row = (await get('/employees')).json().data[0]
    expect(row.base_salary).toBeNull()
    expect(row.cnps_number).toBeNull()
    expect(row.mobile_money_phone).toBeNull()
    expect(row.maskedFields).toEqual(expect.arrayContaining(['base_salary', 'cnps_number', 'mobile_money_phone']))
    expect(row.first_name).toBe('Awa')
  })

  it('liste : la recherche ne cible pas le n° CNPS quand il est masqué', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    await get('/employees?search=CI12')
    expect(queryMock.mock.calls.every((c) => !String(c[0]).includes('e.cnps_number LIKE'))).toBe(true)
  })

  it('liste : contexte sensitive -> valeurs intactes, aucun maskedFields', async () => {
    loadHabContextMock.mockResolvedValue(ctx(true))
    const row = (await get('/employees')).json().data[0]
    expect(row.base_salary).toBe('450000')
    expect(row.cnps_number).toBe('CI123')
    expect('maskedFields' in row).toBe(false)
  })

  it('liste : contexte null (historique) -> valeurs intactes', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const row = (await get('/employees')).json().data[0]
    expect(row.base_salary).toBe('450000')
    expect('maskedFields' in row).toBe(false)
  })

  it('détail : masqué sans sensitive, intact avec contexte null', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const masked = (await get(`/employees/${ID}`)).json().data
    expect(masked.base_salary).toBeNull()
    expect(masked.cnps_number).toBeNull()
    expect(masked.maskedFields).toContain('base_salary')
    loadHabContextMock.mockResolvedValue(null)
    const open = (await get(`/employees/${ID}`)).json().data
    expect(open.base_salary).toBe('450000')
    expect(open.cnps_number).toBe('CI123')
  })

  it('détail : son propre dossier n est jamais masqué', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    queryMock.mockImplementation(async (rawSql: string) => {
      const sql = String(rawSql).replace(/\s+/g, ' ')
      if (/e\.\*/.test(sql)) return { rows: [{ ...EMP, email: 'rh@t.ci' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const emp = (await get(`/employees/${ID}`)).json().data
    expect(emp.base_salary).toBe('450000')
  })

  it('export CSV : cellules « Réservé » sans sensitive, valeurs avec contexte null', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const csv = (await get('/employees/export.csv')).body
    expect(csv).toContain('Réservé')
    expect(csv).not.toContain('450000')
    expect(csv).not.toContain('CI123')
    loadHabContextMock.mockResolvedValue(null)
    const open = (await get('/employees/export.csv')).body
    expect(open).toContain('450000')
    expect(open).not.toContain('Réservé')
  })
})

describe('contrats', () => {
  it('liste : base_salary null sans sensitive, intact avec contexte null', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const masked = (await get('/contracts')).json().data[0]
    expect(masked.base_salary).toBeNull()
    expect(masked.maskedFields).toEqual(['base_salary'])
    loadHabContextMock.mockResolvedValue(null)
    expect((await get('/contracts')).json().data[0].base_salary).toBe(450000)
  })
})

describe('reporting', () => {
  it('overview : masse salariale et salaire moyen masqués, effectifs conservés', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const d = (await get('/reporting/overview')).json().data
    expect(d.departments[0].avg_salary).toBeNull()
    expect(d.departments[0].count).toBe(1)
    expect(d.payrollEvolution[0].total_gross).toBeNull()
    expect(d.payrollEvolution[0].maskedFields).toContain('total_gross')
    expect(d.annualTotals.totalGross).toBeNull()
    expect(d.annualTotals.maskedFields).toContain('totalGross')
  })

  it('overview : contexte null -> montants intacts', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const d = (await get('/reporting/overview')).json().data
    expect(d.departments[0].avg_salary).toBe(450000)
    expect(d.payrollEvolution[0].total_gross).toBe(500000)
    expect(d.annualTotals.totalGross).toBe(500000)
    expect('maskedFields' in d.annualTotals).toBe(false)
  })

  it('payroll-summary : distribution retirée sans sensitive, présente sinon', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const m = (await get('/reporting/payroll-summary')).json().data
    expect(m.salaryDistribution).toEqual([])
    expect(m.maskedFields).toEqual(['salaryDistribution'])
    expect(m.periods[0].total_net).toBeNull()
    loadHabContextMock.mockResolvedValue(null)
    const o = (await get('/reporting/payroll-summary')).json().data
    expect(o.salaryDistribution).toHaveLength(1)
    expect(o.periods[0].total_net).toBe(400000)
  })
})

describe('candidatures', () => {
  it('prétention salariale : null sans sensitive, intacte avec contexte null', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const masked = (await get('/recruitment/applications')).json().data[0]
    expect(masked.expected_salary).toBeNull()
    expect(masked.maskedFields).toEqual(['expected_salary'])
    loadHabContextMock.mockResolvedValue(null)
    const open = (await get('/recruitment/applications')).json().data[0]
    expect(open.expected_salary).toBe(600000)
    expect('maskedFields' in open).toBe(false)
  })
})
