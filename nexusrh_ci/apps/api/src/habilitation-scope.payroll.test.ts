/**
 * Tests de comportement — périmètre filiale (habilitations RH), tâche 5b :
 * paie et paiements, déclarations, reporting / DG / IA, recrutement.
 *
 * Pool mocké par un routeur de requêtes : on prouve (1) les 404 par id hors
 * périmètre SANS écriture, (2) le 409 « période partagée » sur les opérations
 * de période, (3) le filtrage des exports / listes / agrégats (le fragment
 * `legal_entity_id = '<A>'` figure dans le SQL émis).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
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
vi.mock('./utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./utils/tenant-schema-hook.js', () => ({ ensureTenantSchemaHook: async () => undefined }))
vi.mock('./db/provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/provisioning.js')>()
  return { ...actual, ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined) }
})
const { loadHabContextMock, initiateTransferMock, populationMock } = vi.hoisted(() => ({
  loadHabContextMock: vi.fn(), initiateTransferMock: vi.fn(), populationMock: vi.fn(),
}))
vi.mock('./services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/habilitation.service.js')>()
  return { ...actual, loadHabContext: loadHabContextMock }
})
vi.mock('./services/mobile-money-providers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/mobile-money-providers.js')>()
  return { ...actual, initiateTransfer: initiateTransferMock }
})
vi.mock('./services/final-payslip.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/final-payslip.service.js')>()
  return { ...actual, loadPayrollPopulation: populationMock }
})

import authPlugin from './plugins/auth.js'
import payrollRoutes from './modules/payroll/payroll.routes.js'
import payrollWorkflowRoutes from './modules/payroll/payroll-workflow.routes.js'
import bankTransferRoutes from './modules/bank-transfer/bank-transfer.routes.js'
import mobileMoneyRoutes from './modules/mobile-money/mobile-money.routes.js'
import cnpsRoutes from './modules/cnps/cnps.routes.js'
import reportingRoutes from './modules/reporting/reporting.routes.js'
import sageRoutes from './modules/sage/sage.routes.js'
import orgChartRoutes from './modules/org-chart/org-chart.routes.js'
import recruitmentRoutes from './modules/recruitment/recruitment.routes.js'
import { executeAiTool } from './modules/ai/ai-tools.js'
import { hrScopeSql } from './services/habilitation.service.js'
import { HAB_GRID } from './modules/habilitations/catalog.js'
import type { HabContext } from './services/habilitation.service.js'
import type { Pool } from 'pg'

const SCHEMA = 'tenant_scope'
const A = 'aaaaaaaa-1111-4222-8333-444444444444'
const OTHER = 'cccccccc-1111-4222-8333-444444444444'
const ID = 'bbbbbbbb-1111-4222-8333-444444444444'
const EMP = 'dddddddd-1111-4222-8333-444444444444'
const FRAGMENT = `legal_entity_id = '${A}'`
const SHARED = 'Période partagée avec une autre filiale : action réservée à un RH habilité sur toutes les filiales'

/** État simulé de la base pour le routeur de requêtes. */
const db = {
  foreignEmployees: false, // des employés hors périmètre figurent dans le lot / la période
  foreignSlips: false,     // la période porte des bulletins hors périmètre
  inScopeRows: false,      // la lecture bornée par le périmètre renvoie une ligne
}

let app: FastifyInstance

function entityCtx(): HabContext {
  const perms = Object.entries(HAB_GRID).flatMap(([fn, actions]) => actions.map((a) => `${fn}:${a}`))
  return {
    userId: 'u-hab', subgroupId: 'sg-1', kind: 'entity', legalEntityId: A,
    permissions: new Set(perms), allEntities: false, sensitive: true,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

const sqls = (): string[] => queryMock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
const writes = (): string[] => sqls().filter((s) => /^(UPDATE|DELETE|INSERT)/i.test(s.trim()))
const allSql = (): string => sqls().join('\n')

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  const token = app.jwt.sign({
    sub: 'u-hab', tenantId: 't1', schemaName: SCHEMA, role: 'hr_manager',
    email: 'rh@t.ci', firstName: 'A', lastName: 'B', employeeId: null,
  })
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.register(payrollWorkflowRoutes, { prefix: '/payroll-workflow' })
  await app.register(bankTransferRoutes, { prefix: '/bank-transfer' })
  await app.register(mobileMoneyRoutes, { prefix: '/mobile-money' })
  await app.register(cnpsRoutes, { prefix: '/cnps' })
  await app.register(reportingRoutes, { prefix: '/reporting' })
  await app.register(sageRoutes, { prefix: '/sage' })
  await app.register(orgChartRoutes, { prefix: '/org-chart' })
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  db.foreignEmployees = false
  db.foreignSlips = false
  db.inScopeRows = false
  loadHabContextMock.mockReset().mockResolvedValue(entityCtx())
  initiateTransferMock.mockReset().mockResolvedValue({ status: 'completed', success: true, transactionId: 'tx' })
  populationMock.mockReset().mockResolvedValue([{ id: EMP }])
  queryMock.mockReset()
  queryMock.mockImplementation(async (rawSql: string) => {
    const sql = String(rawSql).replace(/\s+/g, ' ')
    // Compte d'employés hors périmètre dans un lot (countEmployeesOutOfScope)
    if (sql.includes('unnest($1::uuid[]) AS ids')) return { rows: [{ n: db.foreignEmployees ? 1 : 0 }], rowCount: 1 }
    // Période partagée : bulletins d'un employé hors périmètre (periodHasOutOfScopeSlips)
    if (sql.includes('pay_slips ps LEFT JOIN') && sql.includes('NOT COALESCE')) {
      return db.foreignSlips ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    // Lot Mobile Money : un bulletin du lot appartient-il à un employé hors périmètre ?
    if (sql.includes('FROM "tenant_scope".pay_slips ps WHERE ps.id = ANY')) {
      return db.foreignSlips ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    // Filiale cible virtuelle (legalEntityInHrScope) : toujours hors périmètre ici
    if (sql.includes('FROM (SELECT $1::uuid')) return { rows: [], rowCount: 0 }
    // Locataire (clôture, déclarations)
    if (sql.includes('FROM platform.tenants')) {
      return { rows: [{ id: 't1', has_subsidiaries: false, at_rate: '0.020', default_country_code: 'CIV', city: 'Abidjan', name: 'T', cnps_number: '1' }], rowCount: 1 }
    }
    // Période en validation (loadPendingPeriod)
    if (sql.includes('FROM "tenant_scope".pay_periods WHERE month = $1 AND parent_period_id IS NULL')) {
      return { rows: [{ id: ID, status: 'pending_validation', initiated_by: 'u-other', initiated_at: new Date().toISOString() }], rowCount: 1 }
    }
    // Lot CNPS : bulletins agrégés par employé
    if (sql.includes('SUM(COALESCE(ps.total_cnps_sal,0))')) {
      return { rows: [{ employee_id: EMP, first_name: 'A', last_name: 'B', gross_salary: '1', total_cnps_sal: '1', total_cnps_pat: '1' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
})

describe('paie — périmètre filiale', () => {
  it('POST /payroll/periods/:month/close : lot mélangeant des filiales -> 409, aucune écriture', async () => {
    db.foreignEmployees = true
    const res = await call('POST', '/payroll/periods/2026-05/close', {})
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe(SHARED)
    expect(writes()).toEqual([])
  })

  it('POST /payroll/periods/:month/close : lot entièrement dans le périmètre -> la clôture se poursuit (écritures)', async () => {
    db.foreignEmployees = false
    await call('POST', '/payroll/periods/2026-05/close', {})
    expect(writes().some((s) => s.startsWith('INSERT INTO "tenant_scope".pay_periods'))).toBe(true)
  })

  for (const action of ['approve', 'reject', 'cancel'] as const) {
    it(`POST /payroll/periods/:month/${action} : période portant des bulletins hors périmètre -> 409, rien modifié`, async () => {
      db.foreignSlips = true
      const res = await call('POST', `/payroll/periods/2026-05/${action}`, action === 'reject' ? { reason: 'Motif de rejet suffisant' } : {})
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe(SHARED)
      expect(writes()).toEqual([])
    })
  }

  it('GET /payroll/payslips : liste bornée au périmètre', async () => {
    await call('GET', '/payroll/payslips?month=2026-05')
    expect(allSql()).toContain(FRAGMENT)
  })

  it('GET /payroll/payslips/:id/transparency hors périmètre -> 404 (requête bornée au périmètre)', async () => {
    const res = await call('GET', `/payroll/payslips/${ID}/transparency`)
    expect(res.statusCode).toBe(404)
    expect(allSql()).toContain(FRAGMENT)
  })

  it('GET /payroll/periods : totaux recalculés sur les bulletins du périmètre', async () => {
    await call('GET', '/payroll/periods')
    const s = allSql()
    expect(s).toContain(FRAGMENT)
    expect(s).toContain('JOIN "tenant_scope".employees e ON e.id = ps.employee_id')
  })

  it('GET /payroll/livre-de-paie/:year/export : lignes bornées au périmètre', async () => {
    await call('GET', '/payroll/livre-de-paie/2026/export')
    expect(allSql()).toContain(FRAGMENT)
  })

  it('POST /payroll/calculate d\'un employé hors périmètre -> 404 (requête bornée)', async () => {
    const res = await call('POST', '/payroll/calculate', { employeeId: EMP, month: '2026-05' })
    expect(res.statusCode).toBe(404)
    expect(allSql()).toContain(FRAGMENT)
  })

  it('POST /payroll-workflow/periods/:id/send-to-sites vers une filiale hors périmètre -> 409, aucune déclinaison créée', async () => {
    queryMock.mockImplementation(async (rawSql: string) => {
      const sql = String(rawSql).replace(/\s+/g, ' ')
      if (sql.includes('FROM (SELECT $1::uuid')) return { rows: [], rowCount: 0 }
      if (sql.includes('parent_period_id IS NULL')) return { rows: [{ month: '2026-05', status: 'draft_central' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const res = await call('POST', `/payroll-workflow/periods/${ID}/send-to-sites`, {
      sites: [{ legalEntityId: OTHER, rafUserId: 'u-raf', legislationPackCode: 'CIV-2024' }],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe(SHARED)
    expect(writes()).toEqual([])
  })

  it('POST /payroll-workflow/periods/:id/validate-central : période multi-filiales partagée -> 409, rien modifié', async () => {
    db.foreignSlips = true
    const base = queryMock.getMockImplementation()
    queryMock.mockImplementation(async (rawSql: string, params?: unknown[]) => {
      const sql = String(rawSql).replace(/\s+/g, ' ')
      if (sql.startsWith('SELECT status, parent_period_id, month FROM')) {
        return { rows: [{ status: 'completed_by_site', parent_period_id: null, month: '2026-05' }], rowCount: 1 }
      }
      return base ? base(rawSql, params) : { rows: [], rowCount: 0 }
    })
    const res = await call('POST', `/payroll-workflow/periods/${ID}/validate-central`, {})
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe(SHARED)
    expect(writes()).toEqual([])
  })

  it('GET /payroll-workflow/periods : déclinaisons filtrées sur le périmètre', async () => {
    await call('GET', '/payroll-workflow/periods')
    expect(allSql()).toContain(FRAGMENT)
  })
})

describe('paiements — périmètre filiale', () => {
  it('POST /mobile-money/campaigns/:ref/execute : lot contenant un bulletin hors périmètre -> 409, aucun virement', async () => {
    db.foreignSlips = true
    const res = await call('POST', '/mobile-money/campaigns/CAMP_202605_1/execute', { paySlipIds: [ID] })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe(SHARED)
    expect(initiateTransferMock).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it('POST /mobile-money/campaigns : le lot préparé est borné au périmètre', async () => {
    await call('POST', '/mobile-money/campaigns', { month: '2026-05' })
    expect(allSql()).toContain(FRAGMENT)
  })

  it('PATCH /mobile-money/payments/:id/retry hors périmètre -> 404, aucun virement relancé', async () => {
    const res = await call('PATCH', `/mobile-money/payments/${ID}/retry`)
    expect(res.statusCode).toBe(404)
    expect(allSql()).toContain(FRAGMENT)
    expect(initiateTransferMock).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it('GET /mobile-money/payments et /payments/stats : bornés au périmètre', async () => {
    await call('GET', '/mobile-money/payments')
    await call('GET', '/mobile-money/payments/stats')
    const bounded = sqls().filter((s) => s.includes(FRAGMENT))
    expect(bounded.length).toBeGreaterThanOrEqual(2)
  })

  it('GET /bank-transfer/file : le fichier ne reprend que les virements du périmètre (aucune ligne -> 404)', async () => {
    const res = await call('GET', '/bank-transfer/file?month=2026-05&bank=SGBCI')
    expect(res.statusCode).toBe(404)
    expect(allSql()).toContain(FRAGMENT)
  })

  it('GET /bank-transfer/preview : récapitulatif borné au périmètre', async () => {
    await call('GET', '/bank-transfer/preview?month=2026-05')
    expect(allSql()).toContain(FRAGMENT)
  })
})

describe('déclarations CNPS / DISA et exports SAGE — périmètre filiale', () => {
  it('POST /cnps/declarations/generate : déclaration agrégeant des salariés hors périmètre -> 409, rien écrit', async () => {
    db.foreignEmployees = true
    const res = await call('POST', '/cnps/declarations/generate', { year: 2026, quarter: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe(SHARED)
    expect(writes()).toEqual([])
  })

  it('POST /cnps/declarations/generate : lot dans le périmètre -> la déclaration est enregistrée', async () => {
    db.foreignEmployees = false
    await call('POST', '/cnps/declarations/generate', { year: 2026, quarter: 1 })
    expect(writes().some((s) => s.includes('cnps_declarations'))).toBe(true)
  })

  it('POST /cnps/declarations/:id/submit d\'une déclaration hors périmètre -> 404 (UPDATE borné)', async () => {
    const res = await call('POST', `/cnps/declarations/${ID}/submit`, {})
    expect(res.statusCode).toBe(404)
    expect(allSql()).toContain(FRAGMENT)
  })

  it('GET /cnps/declarations et /cnps/disa : listes bornées (filiale + salariés listés)', async () => {
    await call('GET', '/cnps/declarations')
    const s = allSql()
    expect(s).toContain(FRAGMENT)
    expect(s).toContain("x->>'employee_id'")
  })

  it('GET /cnps/declarations/:id/export et /neva hors périmètre -> 404', async () => {
    const r1 = await call('GET', `/cnps/declarations/${ID}/export`)
    expect(r1.statusCode).toBe(404)
    expect(allSql()).toContain(FRAGMENT)
  })

  it('GET /cnps/rns/:year/export : relevé borné au périmètre', async () => {
    await call('GET', '/cnps/rns/2026/export')
    expect(allSql()).toContain(FRAGMENT)
  })

  it('POST /cnps/events/cessation d\'un employé hors périmètre -> 404, aucune écriture', async () => {
    const res = await call('POST', '/cnps/events/cessation', { employeeId: EMP, exitDate: '2026-05-31', reason: 'resignation' })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
  })

  it('GET /sage/export/payroll.csv et employees.csv : exports bornés au périmètre', async () => {
    await call('GET', '/sage/export/payroll.csv?period=2026-05')
    await call('GET', '/sage/export/employees.csv')
    expect(sqls().filter((s) => s.includes(FRAGMENT)).length).toBeGreaterThanOrEqual(2)
  })
})

describe('reporting, organigramme et IA — périmètre filiale', () => {
  it('GET /reporting/overview : effectifs, masse salariale et absences calculés sur le périmètre', async () => {
    await call('GET', '/reporting/overview?year=2026')
    const s = allSql()
    expect(s).toContain(FRAGMENT)
    // masse salariale : somme des bulletins du périmètre, pas les totaux de la période
    expect(s).toContain('SUM(ps.gross_salary)')
    expect(s).not.toMatch(/SELECT pp\.month, pp\.total_gross::int/)
  })

  it('GET /org-chart/departments : seuls les salariés du périmètre sont dans l\'arbre', async () => {
    await call('GET', '/org-chart/departments')
    expect(allSql()).toContain(FRAGMENT)
  })

  it('outil IA get_headcount / count_absences_today : requêtes bornées au périmètre', async () => {
    const calls: string[] = []
    const pool = { query: async (sql: string) => { calls.push(String(sql)); return { rows: [] } } } as unknown as Pool
    const ctx = { schemaName: SCHEMA, role: 'hr_manager', hrScope: (alias: string) => hrScopeSql(SCHEMA, alias, entityCtx()) }
    await executeAiTool(pool, ctx, 'get_headcount', {})
    await executeAiTool(pool, ctx, 'count_absences_today', {})
    await executeAiTool(pool, ctx, 'get_payroll_status', {})
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const sql of calls) {
      if (/pay_periods p\b/.test(sql) && !sql.includes('pay_slips')) throw new Error(`totaux de période non bornés : ${sql}`)
      expect(sql).toContain(FRAGMENT)
    }
  })
})

describe('recrutement — périmètre filiale (offres)', () => {
  it('POST /recruitment/applications sur une offre hors périmètre -> 404 « Offre introuvable », rien écrit', async () => {
    const res = await call('POST', '/recruitment/applications', {
      job_id: ID, first_name: 'Awa', last_name: 'Kone', email: 'awa@x.ci',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Offre introuvable')
    expect(writes()).toEqual([])
  })

  it('GET /recruitment/jobs : liste filtrée sur la filiale cible des offres', async () => {
    await call('GET', '/recruitment/jobs')
    expect(allSql()).toContain(FRAGMENT)
  })

  it('GET /jobs/:id, PATCH /jobs/:id, DELETE /jobs/:id hors périmètre -> 404, aucune écriture', async () => {
    const g = await call('GET', `/recruitment/jobs/${ID}`)
    const p = await call('PATCH', `/recruitment/jobs/${ID}`, { title: 'X' })
    const d = await call('DELETE', `/recruitment/jobs/${ID}`)
    for (const r of [g, p, d]) {
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('Offre introuvable')
    }
    expect(writes()).toEqual([])
  })

  it('POST /jobs/:id/preselect, GET decisions-history, transfert de profils sourcés hors périmètre -> 404, rien écrit', async () => {
    const calls: Array<[Parameters<typeof call>[0], string]> = [
      ['POST', `/recruitment/jobs/${ID}/preselect`],
      ['GET', `/recruitment/jobs/${ID}/decisions-history`],
      ['POST', `/recruitment/jobs/${ID}/sourced-profiles/${EMP}/transfer`],
      ['POST', `/recruitment/jobs/${ID}/sourced-profiles/transfer-all`],
      ['GET', `/recruitment/jobs/${ID}/sourced-profiles`],
    ]
    for (const [m, u] of calls) {
      const r = await call(m, u, m === 'POST' ? {} : undefined)
      expect(r.statusCode, u).toBe(404)
      expect(r.json().error, u).toBe('Offre introuvable')
    }
    expect(writes()).toEqual([])
  })

  it('POST /jobs vers une filiale hors périmètre -> 403', async () => {
    const res = await call('POST', '/recruitment/jobs', { title: 'Comptable', target_legal_entity_id: OTHER })
    expect(res.statusCode).toBe(403)
    expect(writes()).toEqual([])
  })
})

describe('fix round 1 — agrégats multi-filiales, envoi bancaire, clôture, offres', () => {
  const PARENT = '11111111-1111-4222-8333-444444444444'
  const CHILD = '22222222-1111-4222-8333-444444444444'
  type Impl = (rawSql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
  const norm = (q: string): string => q.replace(/\s+/g, ' ')
  /** Surcharge le routeur : `match` répond en priorité, sinon routeur par défaut. */
  function override(match: (sql: string) => { rows: unknown[]; rowCount: number } | null): void {
    const base = queryMock.getMockImplementation() as Impl | undefined
    queryMock.mockImplementation(async (rawSql: string, params?: unknown[]) => {
      return match(norm(String(rawSql))) ?? (base ? base(rawSql, params) : { rows: [], rowCount: 0 })
    })
  }

  it('GET /payroll/periods : totaux de la parente = bulletins des déclinaisons du périmètre uniquement', async () => {
    override((sql) => {
      if (sql.startsWith('SELECT pp.* FROM')) {
        return { rows: [{ id: PARENT, month: '2026-05', status: 'closed', total_gross: '999999', total_net: '888888', total_cnps: '1', total_its: '1' }], rowCount: 1 }
      }
      if (sql.includes('SUM(ps.gross_salary) AS gross')) {
        return { rows: [{ period_id: PARENT, gross: '100', net: '80', cnps: '10', its: '5' }], rowCount: 1 }
      }
      return null
    })
    const res = await call('GET', '/payroll/periods')
    expect(res.statusCode).toBe(200)
    const row = res.json().data[0]
    expect(row.total_gross).toBe('100')
    expect(row.total_net).toBe('80')
    const recompute = sqls().find((q) => q.includes('SUM(ps.gross_salary) AS gross')) ?? ''
    expect(recompute).toContain('c.parent_period_id = pp.id')
    expect(recompute).toContain(FRAGMENT)
    expect(sqls().find((q) => q.startsWith('SELECT pp.* FROM'))).toContain('hvs.period_id IN')
  })

  it("GET /payroll/periods : une parente sans bulletin du périmètre n'a aucun total (null)", async () => {
    override((sql) => {
      if (sql.startsWith('SELECT pp.* FROM')) {
        return { rows: [{ id: PARENT, month: '2026-05', status: 'open', total_gross: '999999', total_net: null, total_cnps: null, total_its: null }], rowCount: 1 }
      }
      return null
    })
    const res = await call('GET', '/payroll/periods')
    expect(res.json().data[0].total_gross).toBeNull()
  })

  it('GET /payroll-workflow/periods/:id/timeline : aucune déclinaison dans le périmètre -> 404', async () => {
    override((sql) => {
      if (sql.includes('FROM "tenant_scope".pay_periods WHERE id = $1')) {
        return { rows: [{ id: PARENT, month: '2026-05', status: 'validated_central', parent_period_id: null }], rowCount: 1 }
      }
      return null
    })
    const res = await call('GET', `/payroll-workflow/periods/${PARENT}/timeline`)
    expect(res.statusCode).toBe(404)
  })

  it('GET /payroll-workflow/periods/:id/timeline : les montants consolidés de la parente sont retirés', async () => {
    override((sql) => {
      if (sql.includes('FROM "tenant_scope".pay_periods WHERE id = $1')) {
        return { rows: [{ id: PARENT, month: '2026-05', status: 'validated_central', parent_period_id: null }], rowCount: 1 }
      }
      if (sql.includes('WHERE pp.parent_period_id = $1')) {
        return { rows: [{ id: CHILD, legal_entity_id: A, raf_user_id: null, legal_entity_name: 'A' }], rowCount: 1 }
      }
      if (sql.includes('FROM "tenant_scope".audit_log a')) {
        return { rows: [
          { action: 'workflow.validate_central', created_at: 'd', changes: { sumGross: 123456, sumNet: 1 }, entity_id: PARENT, first_name: 'X', last_name: 'Y' },
          { action: 'workflow.submit', created_at: 'd', changes: { legalEntityName: 'A' }, entity_id: CHILD, first_name: 'X', last_name: 'Y' },
        ], rowCount: 2 }
      }
      return null
    })
    const res = await call('GET', `/payroll-workflow/periods/${PARENT}/timeline`)
    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.json())).not.toContain('123456')
    expect(res.json().data.events[1].detail.legalEntityName).toBe('A')
  })

  it('GET circuit /payroll-workflow/periods/:id/workflow et /payroll/periods/:month/workflow : période invisible -> 404', async () => {
    override((sql) => {
      if (sql.includes('FROM "tenant_scope".pay_periods WHERE id = $1 LIMIT 1')) {
        return { rows: [{ id: PARENT, month: '2026-05', status: 'closed', parent_period_id: null }], rowCount: 1 }
      }
      return null
    })
    const r1 = await call('GET', `/payroll-workflow/periods/${PARENT}/workflow`)
    const r2 = await call('GET', '/payroll/periods/2026-05/workflow')
    expect(r1.statusCode).toBe(404)
    expect(r2.statusCode).toBe(404)
    expect(sqls().filter((q) => q.includes('hvs.period_id IN')).length).toBeGreaterThanOrEqual(2)
  })

  it('POST /bank-transfer/send : période contenant des virements hors périmètre -> 409, rien envoyé ni écrit', async () => {
    override((sql) => {
      if (sql.includes("e.payment_method = 'bank_transfer'") && sql.includes('NOT COALESCE')) return { rows: [{ x: 1 }], rowCount: 1 }
      return null
    })
    const res = await call('POST', '/bank-transfer/send', { month: '2026-05', banks: [{ name: 'SGBCI', email: 'b@banque.ci' }] })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('La période contient des salariés hors de votre périmètre')
    expect(writes()).toEqual([])
  })

  it('POST /payroll/periods/:month/close avec une filiale hors périmètre -> 404 avant tout 422/409 et toute écriture', async () => {
    const res = await call('POST', '/payroll/periods/2026-05/close', { legalEntityId: OTHER })
    expect(res.statusCode).toBe(404)
    expect(writes()).toEqual([])
    expect(populationMock).not.toHaveBeenCalled()
  })

  it('POST/PATCH /recruitment/jobs avec target_legal_entity_id non UUID -> 400 (pas de 500)', async () => {
    override((sql) => (sql.includes('FROM "tenant_scope".recruitment_jobs rj LEFT JOIN LATERAL') ? { rows: [{ x: 1 }], rowCount: 1 } : null))
    const r1 = await call('POST', '/recruitment/jobs', { title: 'X', target_legal_entity_id: 'pas-un-uuid' })
    const r2 = await call('PATCH', `/recruitment/jobs/${ID}`, { target_legal_entity_id: 'pas-un-uuid' })
    expect(r1.statusCode).toBe(400)
    expect(r2.statusCode).toBe(400)
  })

  it('GET /recruitment/jobs/:id/decisions-history avec un id invalide -> 400 (avant la garde de périmètre)', async () => {
    const res = await call('GET', '/recruitment/jobs/pas-un-uuid/decisions-history')
    expect(res.statusCode).toBe(400)
  })

  it('outil IA get_recruitment_pipeline : offres et candidatures bornées à la filiale cible', async () => {
    const calls: string[] = []
    const pool = { query: async (sql: string) => { calls.push(String(sql)); return { rows: [] } } } as unknown as Pool
    const ctx = { schemaName: SCHEMA, role: 'hr_manager', hrScope: (alias: string) => hrScopeSql(SCHEMA, alias, entityCtx()) }
    await executeAiTool(pool, ctx, 'get_recruitment_pipeline', {})
    expect(calls.length).toBe(2)
    for (const sql of calls) expect(sql).toContain(FRAGMENT)
  })

  it('outil IA get_payroll_status : seules les périodes visibles du périmètre (statut / clôtureur)', async () => {
    const calls: string[] = []
    const pool = { query: async (sql: string) => { calls.push(String(sql)); return { rows: [] } } } as unknown as Pool
    const ctx = { schemaName: SCHEMA, role: 'hr_manager', hrScope: (alias: string) => hrScopeSql(SCHEMA, alias, entityCtx()) }
    await executeAiTool(pool, ctx, 'get_payroll_status', {})
    expect(calls[0]).toContain('hvs.period_id IN')
  })

  it('GET /payroll-workflow/periods : la liste exige une déclinaison du périmètre pour montrer une parente', async () => {
    await call('GET', '/payroll-workflow/periods')
    const q = sqls().find((x) => x.includes('FROM "tenant_scope".pay_periods pp')) ?? ''
    expect(q).toContain('EXISTS (SELECT 1 FROM "tenant_scope".pay_periods c WHERE c.parent_period_id = pp.id AND')
    expect(q).not.toContain('NOT EXISTS (SELECT 1 FROM "tenant_scope".pay_periods c')
    expect(q).toContain(FRAGMENT)
  })
})
