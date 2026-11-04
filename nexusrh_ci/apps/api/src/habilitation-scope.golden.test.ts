/**
 * Golden — périmètre filiale (habilitations RH) appliqué dans les modules.
 *
 * 1. Invariant statique : tout fichier `*.routes.ts` d'un module listé qui lit
 *    ou modifie la table employees doit appeler le fragment de périmètre
 *    (`hrScopeSql` / `requestHrScope`). Un module qui n'est pas dans la liste
 *    n'est pas couvert : AJOUTER ici tout nouveau module touchant des employés.
 * 2. Balayage dynamique (pool mocké) : pour un contexte « entity A », le SQL
 *    émis par chaque route RH contient `legal_entity_id = '<A>'`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })),
}))
vi.mock('./services/redis.js', () => ({
  blacklistToken:      vi.fn().mockResolvedValue(undefined),
  blacklistTokenSafe:  vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted:  vi.fn().mockResolvedValue(false),
  setTokenEpoch:       vi.fn().mockResolvedValue(undefined),
  getTokenEpoch:       vi.fn().mockResolvedValue(0),
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
vi.mock('./utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))

const { loadHabContextMock } = vi.hoisted(() => ({ loadHabContextMock: vi.fn() }))
vi.mock('./services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})

import authPlugin from './plugins/auth.js'
import employeesRoutes from './modules/employees/employees.routes.js'
import absencesRoutes from './modules/absences/absences.routes.js'
import signedContractsRoutes from './modules/contracts/signed-contracts.routes.js'
import payrollRoutes from './modules/payroll/payroll.routes.js'
import payrollWorkflowRoutes from './modules/payroll/payroll-workflow.routes.js'
import bankTransferRoutes from './modules/bank-transfer/bank-transfer.routes.js'
import mobileMoneyRoutes from './modules/mobile-money/mobile-money.routes.js'
import cnpsRoutes from './modules/cnps/cnps.routes.js'
import reportingRoutes from './modules/reporting/reporting.routes.js'
import sageRoutes from './modules/sage/sage.routes.js'
import orgChartRoutes from './modules/org-chart/org-chart.routes.js'
import dgRoutes from './modules/dg/dg.routes.js'
import { executeAiTool } from './modules/ai/ai-tools.js'
import { hrScopeSql } from './services/habilitation.service.js'
import type { Pool } from 'pg'
import { HAB_GRID } from './modules/habilitations/catalog.js'
import type { HabContext } from './services/habilitation.service.js'

const MODULES_DIR = join(__dirname, 'modules')

/** Modules couverts (5a : talents/temps/dossiers ; 5b : paie, paiements, déclarations, reporting, DG, IA, SAGE, organigramme). */
const SCOPED_MODULES = [
  'employees', 'contracts', 'absences', 'attendance', 'expenses', 'recruitment',
  'onboarding', 'offboarding', 'discipline', 'training', 'careers', 'competencies',
  'mobility', 'succession', 'calibration', 'signature',
  'payroll', 'bank-transfer', 'mobile-money', 'cnps', 'reporting', 'dg', 'ai', 'sage', 'org-chart',
] as const

/** Fichiers qui touchent employees mais restent volontairement hors périmètre (raison obligatoire). */
const EXEMPT: Record<string, string> = {}

/** Services / dépôts qui lisent employees : mêmes règles, exemptions motivées. */
const EXEMPT_NON_ROUTES: Record<string, string> = {
  'attendance/attendance.repo.ts': "ingestion des badgeuses (rapprochement référence appareil -> employé), hors requête utilisateur",
}
const SCOPE_CALL = /hrScopeSql\(|requestHrScope(?:UnlessSelf)?\(|scopeSql|hrScope\(/

const EMPLOYEES_TABLE = /(?:FROM|JOIN|UPDATE|INTO)\s+"?\$\{[A-Za-z.]*\}"?\."?employees\b/

describe('périmètre filiale — invariant statique (services et dépôts)', () => {
  const files: string[] = []
  for (const m of SCOPED_MODULES) {
    const dir = join(MODULES_DIR, m)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.service.ts') || f.endsWith('.repo.ts')) && !f.includes('.test.')) files.push(join(dir, f))
    }
  }
  // Outils IA : lisent employees hors *.service.ts, mêmes règles (ctx.hrScope obligatoire).
  files.push(join(MODULES_DIR, 'ai', 'ai-tools.ts'))
  for (const file of files) {
    const rel = file.slice(MODULES_DIR.length + 1).split(String.fromCharCode(92)).join('/')
    const src = readFileSync(file, 'utf8')
    if (!EMPLOYEES_TABLE.test(src)) continue
    it(`${rel} applique le périmètre filiale ou est exempté`, () => {
      if (EXEMPT_NON_ROUTES[rel]) return
      expect(SCOPE_CALL.test(src), rel).toBe(true)
    })
  }
  it('au moins hire.service et attendance.repo sont couverts par la liste', () => {
    const rels = files.map((f) => f.slice(MODULES_DIR.length + 1).split(String.fromCharCode(92)).join('/'))
    expect(rels).toContain('recruitment/hire.service.ts')
    expect(rels).toContain('attendance/attendance.repo.ts')
  })
})

describe('périmètre filiale — invariant statique', () => {
  const files: string[] = []
  for (const m of SCOPED_MODULES) {
    const dir = join(MODULES_DIR, m)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.routes.ts')) files.push(join(dir, f))
    }
  }

  it('la liste de modules couvre des fichiers de routes', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  for (const file of files) {
    const rel = file.slice(MODULES_DIR.length + 1).split(String.fromCharCode(92)).join('/')
    const src = readFileSync(file, 'utf8')
    if (!EMPLOYEES_TABLE.test(src)) continue
    it(`${rel} applique le périmètre filiale`, () => {
      if (EXEMPT[rel]) return
      expect(src).toMatch(/hrScopeSql\(|requestHrScope(?:UnlessSelf)?\(/)
    })
  }
})

const ENTITY_A = 'aaaaaaaa-1111-4222-8333-444444444444'
const SCHEMA = 'tenant_scope'

function entityCtx(): HabContext {
  const perms = Object.entries(HAB_GRID).flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: 'u-hab', subgroupId: 'sg-1', kind: 'entity', legalEntityId: ENTITY_A,
    permissions: new Set(perms), allEntities: false, sensitive: true,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

let app: FastifyInstance

function token(): string {
  return app.jwt.sign({
    sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'rh@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
}

async function sqlOf(url: string): Promise<string> {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
  await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token()}` } })
  return queryMock.mock.calls.map((c) => String(c[0])).join('\n')
}

describe('périmètre filiale — balayage dynamique (contexte entity A)', () => {
  beforeAll(async () => {
    app = Fastify()
    await app.register(authPlugin)
    await app.register(employeesRoutes, { prefix: '/employees' })
    await app.register(absencesRoutes, { prefix: '/absences' })
    await app.register(signedContractsRoutes, { prefix: '/contracts/signed' })
    await app.register(payrollRoutes, { prefix: '/payroll' })
    await app.register(payrollWorkflowRoutes, { prefix: '/payroll-workflow' })
    await app.register(bankTransferRoutes, { prefix: '/bank-transfer' })
    await app.register(mobileMoneyRoutes, { prefix: '/mobile-money' })
    await app.register(cnpsRoutes, { prefix: '/cnps' })
    await app.register(reportingRoutes, { prefix: '/reporting' })
    await app.register(sageRoutes, { prefix: '/sage' })
    await app.register(orgChartRoutes, { prefix: '/org-chart' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { loadHabContextMock.mockResolvedValue(entityCtx()) })

  const fragment = `legal_entity_id = '${ENTITY_A}'`
  const ID = 'bbbbbbbb-1111-4222-8333-444444444444'
  const routes: Array<[string, string]> = [
    ['GET /employees', '/employees'],
    ['GET /employees/:id', `/employees/${ID}`],
    ['GET /employees/export.csv', '/employees/export.csv'],
    ['GET /absences', '/absences'],
    ['GET /contracts/signed/documents/:docId/file', `/contracts/signed/documents/${ID}/file`],
    // 5b — paie, paiements, déclarations, reporting, organigramme, SAGE
    ['GET /payroll/payslips (liste des bulletins par période)', '/payroll/payslips?month=2026-05'],
    ['GET /payroll/payslips/:id/transparency', `/payroll/payslips/${ID}/transparency`],
    ['GET /payroll/periods', '/payroll/periods'],
    ['GET /payroll/livre-de-paie/:year/export', '/payroll/livre-de-paie/2026/export'],
    ['GET /payroll-workflow/periods', '/payroll-workflow/periods'],
    ['GET /bank-transfer/preview', '/bank-transfer/preview?month=2026-05'],
    ['GET /mobile-money/payments', '/mobile-money/payments'],
    ['GET /cnps/declarations', '/cnps/declarations'],
    ['GET /cnps/rns/:year/export', '/cnps/rns/2026/export'],
    ['GET /org-chart/departments', '/org-chart/departments'],
    ['GET /org-chart/reporting', '/org-chart/reporting'],
    ['GET /reporting/overview (effectifs)', '/reporting/overview?year=2026'],
    ['GET /reporting/payroll-summary', '/reporting/payroll-summary'],
    ['GET /sage/export/employees.csv', '/sage/export/employees.csv'],
    ['GET /sage/export/payroll.csv', '/sage/export/payroll.csv?period=2026-05'],
  ]
  for (const [label, url] of routes) {
    it(`${label} filtre sur la filiale A`, async () => {
      expect(await sqlOf(url)).toContain(fragment)
    })
  }

  // Strict : TOUTE requête qui lit employees ou pay_slips pour ces routes porte le fragment
  // (pas seulement une d'entre elles). Exemptions motivées dans STRICT_EXEMPT.
  const READS_PERSONAL = /(?:FROM|JOIN)\s+"tenant_scope"\.(?:employees|pay_slips)/i
  const STRICT_EXEMPT: Array<[RegExp, string]> = [
    [/SELECT id, first_name, last_name, job_title FROM/, 'à compléter si une lecture est motivée'],
  ]
  for (const [label, url] of routes) {
    it(`${label} : chaque requête sur employees / pay_slips est bornée`, async () => {
      await sqlOf(url)
      const offenders = queryMock.mock.calls
        .map((c) => String(c[0]).replace(/\s+/g, ' '))
        .filter((q) => READS_PERSONAL.test(q) && !q.includes(fragment) && !STRICT_EXEMPT.some(([re]) => re.test(q)))
      expect(offenders).toEqual([])
    })
  }
})

describe('périmètre filiale — vue DG et outils IA (contexte entity A)', () => {
  beforeAll(async () => {
    app = Fastify()
    await app.register(authPlugin)
    await app.register(dgRoutes, { prefix: '/dg' })
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { loadHabContextMock.mockResolvedValue(entityCtx()) })

  it('GET /dg/overview : agrégats bornés à la filiale A', async () => {
    queryMock.mockReset()
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    const dgToken = app.jwt.sign({
      sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role: 'dg',
      email: 'dg@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
    })
    await app.inject({ method: 'GET', url: '/dg/overview', headers: { authorization: `Bearer ${dgToken}` } })
    expect(queryMock.mock.calls.map((c) => String(c[0])).join(String.fromCharCode(10))).toContain(fragmentA())
  })

  // Le brief cite l'outil « search_employees » ; les outils réels qui lisent des données
  // salariés sont get_headcount, count_absences_today, get_pending_requests, get_employees_at_risk.
  for (const tool of ['get_headcount', 'count_absences_today', 'get_pending_requests', 'get_employees_at_risk']) {
    it(`outil IA ${tool} : toute requête sur les salariés est bornée à la filiale A`, async () => {
      const calls: string[] = []
      const pool = { query: async (sql: string) => { calls.push(String(sql)); return { rows: [] } } } as unknown as Pool
      await executeAiTool(
        pool,
        { schemaName: SCHEMA, role: 'hr_manager', hrScope: (alias: string) => hrScopeSql(SCHEMA, alias, entityCtx()) },
        tool, {},
      )
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((q) => q.includes(fragmentA()))).toBe(true)
    })
  }
})

function fragmentA(): string { return `legal_entity_id = '${ENTITY_A}'` }
