// Masquage des données sensibles — tour de correction 1 : réponses POST/PATCH
// employé, chiffrés jamais servis bruts, audits sans valeur personnelle,
// documents de contrat réservés à la case sensible, pré-tri, rétention, outil IA,
// soldes de tout compte, pré-remplissage d'embauche. Pool mocké par routeur SQL.
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
vi.mock('./services/employee-tenant-context.service.js', () => ({
  loadEmployeeTenantContext: vi.fn().mockResolvedValue({
    legislation: { legislationPack: { smigMensuel: 75000, currency: 'XOF', code: 'CIV_2024' } },
    customFields: [],
  }),
}))
vi.mock('./services/employee-archive.service.js', () => ({
  archiveEmployeeCascade: vi.fn().mockResolvedValue({ terminatedContracts: 0, cancelledDiscipline: 0, cancelledSignatures: 0 }),
}))
const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }))
vi.mock('./services/employee-create.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/employee-create.service.js')>()
  return { ...actual, insertEmployeeRecord: insertMock }
})

import authPlugin from './plugins/auth.js'
import employeesRoutes from './modules/employees/employees.routes.js'
import contractsRoutes from './modules/contracts/contracts.routes.js'
import recruitmentRoutes from './modules/recruitment/recruitment.routes.js'
import reportingRoutes from './modules/reporting/reporting.routes.js'
import offboardingRoutes from './modules/offboarding/offboarding.routes.js'
import signedContractsRoutes from './modules/contracts/signed-contracts.routes.js'
import { executeAiTool } from './modules/ai/ai-tools.js'
import { analyzeRetentionRisk } from './services/retention-analysis.service.js'
import { SENSITIVE_DOCUMENT_DENIED } from './utils/hr-scope.js'
import { HAB_GRID } from './modules/habilitations/catalog.js'
import type { HabContext } from './services/habilitation.service.js'
import type { Pool } from 'pg'

const SCHEMA = 'tenant_mask'
const ID = 'bbbbbbbb-1111-4222-8333-444444444444'
const APP = 'dddddddd-1111-4222-8333-444444444444'

let app: FastifyInstance

function ctx(sensitive: boolean): HabContext {
  const perms = Object.entries(HAB_GRID)
    .filter(([fn]) => sensitive || !['payroll', 'payroll_multi', 'declarations', 'payments'].includes(fn))
    .flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: 'u-hab', subgroupId: 'sg-1', kind: 'siege', legalEntityId: null,
    permissions: new Set(perms), allEntities: true, sensitive,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

function token(role = 'hr_manager'): string {
  return app.jwt.sign({
    sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'rh@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token()}` }, payload })

const EMP_ROW = {
  id: ID, first_name: 'Awa', last_name: 'Koné', email: 'awa@t.ci', employee_number: 'E1',
  base_salary: '450000', cnps_number: 'CI123', mobile_money_phone: '0707000000',
  nni: 'cipher-nni', iban: 'cipher-iban',
  custom_fields: { groupe_sanguin: 'O+', taille: '1m80' },
}
const CUSTOM_DEFS = [
  { key: 'groupe_sanguin', label: 'Groupe sanguin', type: 'text', sensitive: true },
  { key: 'taille', label: 'Taille', type: 'text', sensitive: false },
]

const auditCalls = () => queryMock.mock.calls.filter((c) => /INSERT INTO "tenant_mask"\.audit_log/.test(String(c[0])))
const auditChanges = (action: string): string => {
  const c = auditCalls().find((x) => (x[1] as unknown[]).includes(action))
  expect(c, `audit ${action}`).toBeDefined()
  return String((c![1] as unknown[])[4])
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.register(contractsRoutes, { prefix: '/contracts' })
  await app.register(signedContractsRoutes, { prefix: '/contracts/signed' })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.register(reportingRoutes, { prefix: '/reporting' })
  await app.register(offboardingRoutes, { prefix: '/offboarding' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  insertMock.mockReset()
  insertMock.mockResolvedValue({ ...EMP_ROW })
  queryMock.mockReset()
  queryMock.mockImplementation(async (rawSql: string) => {
    const sql = String(rawSql).replace(/\s+/g, ' ')
    if (/employee_custom_fields FROM platform\.tenants/.test(sql)) return { rows: [{ employee_custom_fields: CUSTOM_DEFS }], rowCount: 1 }
    if (/^UPDATE "tenant_mask"\.employees/.test(sql)) return { rows: [{ ...EMP_ROW }], rowCount: 1 }
    if (/count\(\*\)::int AS c/.test(sql)) return { rows: [{ c: 1 }], rowCount: 1 }
    if (/e\.\*/.test(sql)) return { rows: [{ ...EMP_ROW, iban: null, nni: 'cipher-nni' }], rowCount: 1 }
    if (/SELECT first_name, last_name, employee_number/.test(sql)) return { rows: [{ first_name: 'Awa', last_name: 'Koné', employee_number: 'E1' }], rowCount: 1 }
    if (/FROM "tenant_mask"\.contracts/.test(sql) && /e\.first_name/.test(sql)) {
      return { rows: [{ id: 'c1', base_salary: 450000, employee_cnps: 'CI123', mobile_money_number: '0707', first_name: 'Awa' }], rowCount: 1 }
    }
    if (/FROM "tenant_mask"\.contracts c WHERE c\.employee_id/.test(sql)) return { rows: [{ id: 'c1', base_salary: 450000 }], rowCount: 1 }
    if (/FROM "tenant_mask"\.employees WHERE email/.test(sql)) return { rows: [{ id: ID }], rowCount: 1 }
    if (/FROM "tenant_mask"\.cnps_declarations/.test(sql)) {
      return { rows: [{ year: 2026, quarter: 1, masse_salariale: 9000000, total_cotisations: 900000, total_cotisations_salariales: 1, total_cotisations_patronales: 2, employees_count: 3 }], rowCount: 1 }
    }
    if (/pay_periods/.test(sql)) return { rows: [{ month: '2026-01', total_gross: 500000, total_net: 400000, total_cnps: 30000, total_its: 20000, employees_count: 1 }], rowCount: 1 }
    if (/FROM "tenant_mask"\.offboarding_cases o/.test(sql) && /e\.base_salary/.test(sql)) {
      return { rows: [{ departure_type: 'licenciement', departure_date: '2026-03-01', notice_served: false, status: 'open', employee_id: ID, base_salary: '450000', hire_date: '2020-01-01', legal_entity_id: null, professional_category: null }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
})

describe('POST/PATCH employé : même ordre que la liste', () => {
  it('PATCH masqué : champ personnalisé sensible retiré, montants et chiffrés à null', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const res = await call('PATCH', `/employees/${ID}`, { jobTitle: 'Comptable' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.custom_fields).toEqual({ taille: '1m80' })
    expect(d.base_salary).toBeNull()
    expect(d.nni).toBeNull()
    expect(d.iban).toBeNull()
    expect(d.maskedFields).toEqual(expect.arrayContaining(['base_salary', 'nni', 'iban']))
  })

  it('PATCH sensitive ou contexte null : valeurs conservées mais NNI/IBAN chiffrés jamais servis', async () => {
    for (const c of [ctx(true), null]) {
      loadHabContextMock.mockResolvedValue(c)
      const d = (await call('PATCH', `/employees/${ID}`, { jobTitle: 'Comptable' })).json().data
      expect(d.base_salary).toBe('450000')
      expect(d.custom_fields).toEqual({ groupe_sanguin: 'O+', taille: '1m80' })
      expect('nni' in d).toBe(false)
      expect('iban' in d).toBe(false)
    }
  })

  it('POST masqué : même résultat', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const res = await call('POST', '/employees', { firstName: 'Awa', lastName: 'Koné', baseSalary: 450000 })
    expect(res.statusCode).toBe(201)
    const d = res.json().data
    expect(d.custom_fields).toEqual({ taille: '1m80' })
    expect(d.base_salary).toBeNull()
    expect(d.nni).toBeNull()
  })

  it('POST contexte null : chiffrés retirés, salaire intact', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const d = (await call('POST', '/employees', { firstName: 'Awa', lastName: 'Koné', baseSalary: 450000 })).json().data
    expect(d.base_salary).toBe('450000')
    expect('nni' in d).toBe(false)
    expect('iban' in d).toBe(false)
  })

  it('liste : le NNI chiffré n est jamais servi, même sans masque', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const row = (await call('GET', '/employees')).json().data[0]
    expect('nni' in row).toBe(false)
    expect(row.base_salary).toBe('450000')
  })
})

describe('audits sans valeur personnelle', () => {
  it('employee.created (POST et embauche) : noms de champs, jamais le salaire', async () => {
    loadHabContextMock.mockResolvedValue(null)
    await call('POST', '/employees', { firstName: 'Awa', lastName: 'Koné', baseSalary: 450000 })
    const changes = auditChanges('employee.created')
    expect(changes).toContain('changedFields')
    expect(changes).not.toContain('450000')
  })

  it('employee.archived : matricule et nom seulement (pas d email ni de poste)', async () => {
    loadHabContextMock.mockResolvedValue(null)
    const res = await call('DELETE', `/employees/${ID}`)
    expect(res.statusCode).toBe(200)
    const changes = JSON.parse(auditChanges('employee.archived'))
    expect(changes.employeeNumber).toBe('E1')
    expect(changes.firstName).toBe('Awa')
    expect(changes.lastName).toBe('Koné')
    expect('email' in changes).toBe(false)
    expect('jobTitle' in changes).toBe(false)
  })
})

describe('contrats', () => {
  it('/contracts/:id masqué : alias CNPS/téléphone à null, NNI absent', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const d = (await call('GET', `/contracts/${ID}`)).json().data
    expect(d.base_salary).toBeNull()
    expect(d.employee_cnps).toBeNull()
    expect(d.mobile_money_number).toBeNull()
    expect('nni' in d).toBe(false)
    expect(d.maskedFields).toEqual(expect.arrayContaining(['base_salary', 'employee_cnps', 'mobile_money_number']))
    loadHabContextMock.mockResolvedValue(null)
    const open = (await call('GET', `/contracts/${ID}`)).json().data
    expect(open.employee_cnps).toBe('CI123')
    expect('nni' in open).toBe(false)
  })

  it('/contracts/my-contract : libre-service, jamais masqué (même RH sans la case)', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const res = await call('GET', '/contracts/my-contract')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.base_salary).toBe(450000)
    expect('maskedFields' in res.json().data).toBe(false)
  })
})

describe('reporting CNPS, solde de tout compte, pré-remplissage d embauche', () => {
  it('/reporting/cnps-analytics : masse salariale et cotisations masquées', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const d = (await call('GET', '/reporting/cnps-analytics')).json().data
    expect(d.declarations[0].masse_salariale).toBeNull()
    expect(d.declarations[0].total_cotisations).toBeNull()
    expect(d.declarations[0].maskedFields).toContain('masse_salariale')
    expect(d.declarations[0].employees_count).toBe(3)
    expect(d.monthlyHistory[0].total_gross).toBeNull()
    loadHabContextMock.mockResolvedValue(null)
    const open = (await call('GET', '/reporting/cnps-analytics')).json().data
    expect(open.declarations[0].masse_salariale).toBe(9000000)
  })

  it('POST /offboarding/:id/settlement : montants masqués dans la réponse, audit sans total', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const res = await call('POST', `/offboarding/${ID}/settlement`, {})
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.total).toBeNull()
    expect(d.indemniteLicenciement).toBeNull()
    expect(d.lines.every((l: { amount: number | null }) => l.amount === null)).toBe(true)
    expect(d.maskedFields).toEqual(expect.arrayContaining(['total', 'lines']))
    expect(auditChanges('offboarding.settlement')).not.toMatch(/\d{5,}/)
  })

  it('hire-prefill : baseSalary masqué, intact avec contexte null', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const poolMod = await import('./db/pool.js')
    const client = { query: vi.fn(async (sql: string) => (/FROM "tenant_mask"\.applications a/.test(sql)
      ? { rows: [{ id: APP, first_name: 'Y', last_name: 'Z', email: null, phone: null, internal_employee_id: null, employee_id: null,
          offer_details: { salary: 700000, type: 'cdi_ci' }, job_title: 'Dev', job_department_id: null, job_legal_entity_id: null, job_contract_type: 'cdi', job_level: null }] }
      : { rows: [] })), release: vi.fn() }
    const spy = vi.spyOn(poolMod.pool, 'connect').mockResolvedValue(client as never)
    const masked = (await call('GET', `/recruitment/applications/${APP}/hire-prefill`)).json().data
    expect(masked.baseSalary).toBeNull()
    expect(masked.maskedFields).toEqual(['baseSalary'])
    loadHabContextMock.mockResolvedValue(null)
    const open = (await call('GET', `/recruitment/applications/${APP}/hire-prefill`)).json().data
    expect(open.baseSalary).toBe(700000)
    spy.mockRestore()
  })
})

describe('documents de contrat : réservés à la case données sensibles', () => {
  const DENIED = { error: SENSITIVE_DOCUMENT_DENIED }

  it('message exact', () => {
    expect(SENSITIVE_DOCUMENT_DENIED).toBe("Vos habilitations ne vous permettent pas d'accéder à ce document.")
  })

  it('génération du contrat à l embauche, proposition (lecture, édition, PDF) et contrat signé : 403 sans la case', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const gen = await call('POST', `/recruitment/applications/${APP}/contract`, { type: 'cdi_ci' })
    expect(gen.statusCode).toBe(403)
    expect(gen.json()).toEqual(DENIED)
    for (const [m, u, p] of [
      ['GET', `/recruitment/applications/${APP}/contract-proposal`, undefined],
      ['PUT', `/recruitment/applications/${APP}/contract-proposal`, { markdown: 'Contrat' }],
      ['GET', `/recruitment/applications/${APP}/contract-proposal/pdf`, undefined],
      ['GET', `/recruitment/contract-proposals/documents/${APP}/file`, undefined],
      ['GET', `/contracts/signed/documents/${APP}/file`, undefined],
    ] as const) {
      const res = await call(m, u, p as Record<string, unknown> | undefined)
      expect(res.statusCode, `${m} ${u}`).toBe(403)
      expect(res.json()).toEqual(DENIED)
    }
  })

  it('avec la case sensible ou contexte null : pas de 403 d habilitation', async () => {
    for (const c of [ctx(true), null]) {
      loadHabContextMock.mockResolvedValue(c)
      const res = await call('GET', `/recruitment/applications/${APP}/contract-proposal`)
      expect(res.statusCode).not.toBe(403)
    }
  })
})

describe('pré-tri et candidatures', () => {
  const CRIT = { criteria: { maxExpectedSalary: 500000 } }

  it('aperçu avec un critère de prétention salariale : 403 sans la case, pas d oracle', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    const res = await call('POST', `/recruitment/jobs/${ID}/screening/preview`, CRIT)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: SENSITIVE_DOCUMENT_DENIED })
  })

  it('aperçu sans critère salarial : autorisé ; avec la case : autorisé', async () => {
    loadHabContextMock.mockResolvedValue(ctx(false))
    expect((await call('POST', `/recruitment/jobs/${ID}/screening/preview`, { criteria: { minExperienceYears: 2 } })).statusCode).toBe(200)
    loadHabContextMock.mockResolvedValue(ctx(true))
    expect((await call('POST', `/recruitment/jobs/${ID}/screening/preview`, CRIT)).statusCode).toBe(200)
  })

  it('motifs « Prétention salariale » : montant retiré des candidatures masquées', async () => {
    const row = { id: 'a1', first_name: 'Y', expected_salary: 600000, cv_blob: null,
      screening_failed_rules: ['Prétention salariale trop élevée : 600000 FCFA > 500000 max', 'Expérience insuffisante'] }
    queryMock.mockImplementation(async (rawSql: string) => {
      const sql = String(rawSql).replace(/\s+/g, ' ')
      if (/FROM "tenant_mask"\.applications a/.test(sql)) return { rows: [{ ...row }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    loadHabContextMock.mockResolvedValue(ctx(false))
    const masked = (await call('GET', '/recruitment/applications')).json().data[0]
    expect(masked.expected_salary).toBeNull()
    expect(JSON.stringify(masked.screening_failed_rules)).not.toContain('600000')
    expect(masked.screening_failed_rules).toContain('Expérience insuffisante')
    expect(masked.maskedFields).toEqual(expect.arrayContaining(['expected_salary', 'screening_failed_rules']))
    loadHabContextMock.mockResolvedValue(null)
    expect((await call('GET', '/recruitment/applications')).json().data[0].screening_failed_rules[0]).toContain('600000')
  })

  it('POST /applications : réponse passée au masque', async () => {
    queryMock.mockImplementation(async (rawSql: string) => {
      const sql = String(rawSql).replace(/\s+/g, ' ')
      if (/INSERT INTO "tenant_mask"\.applications/.test(sql)) return { rows: [{ id: 'a2', first_name: 'Y', expected_salary: 600000 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    loadHabContextMock.mockResolvedValue(ctx(false))
    const res = await call('POST', '/recruitment/applications', { job_id: ID, first_name: 'Y', last_name: 'Z', email: 'y@z.ci' })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.expected_salary).toBeNull()
  })
})

describe('rétention et outil IA', () => {
  const fakePool = (): Pool => ({
    query: vi.fn(async (sql: string) => (/FROM "tenant_mask"\.employees/.test(sql)
      ? { rows: [{ id: ID, hire_date: '2015-01-01', base_salary: '80000', legal_entity_id: null }] }
      : { rows: [] })),
  }) as unknown as Pool

  it('analyse de rétention : montant dans le facteur SMIG sauf si masqué', async () => {
    const open = await analyzeRetentionRisk(fakePool(), SCHEMA, ID)
    expect(open!.factors.join(' ')).toMatch(/80 000/)
    const hidden = await analyzeRetentionRisk(fakePool(), SCHEMA, ID, { hideAmounts: true })
    expect(hidden!.factors).toContain('Rémunération proche du SMIG')
    expect(hidden!.factors.join(' ')).not.toMatch(/\d{2}\s?\d{3}/)
  })

  it('outil get_payroll_status : totaux masqués quand maskSensitive', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ month: '2026-01', status: 'closed', closed_at: null, total_gross: '500000', total_net: '400000', closed_by_name: null }] })) } as unknown as Pool
    const base = { schemaName: SCHEMA, role: 'hr_manager', hrScope: () => 'TRUE' }
    const masked = await executeAiTool(pool, { ...base, maskSensitive: true }, 'get_payroll_status', {}) as { periods: Array<Record<string, unknown>> }
    expect(masked.periods[0]!.totalGrossFcfa).toBeNull()
    expect(masked.periods[0]!.totalNetFcfa).toBeNull()
    expect(masked.periods[0]!.maskedFields).toEqual(['totalGrossFcfa', 'totalNetFcfa'])
    const open = await executeAiTool(pool, base, 'get_payroll_status', {}) as { periods: Array<Record<string, unknown>> }
    expect(open.periods[0]!.totalGrossFcfa).toBe(500000)
    expect('maskedFields' in open.periods[0]!).toBe(false)
  })
})
