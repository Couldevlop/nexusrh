/**
 * Recette paie — un bulletin n'est visible du salarié qu'une fois sa période
 * entièrement validée et clôturée (pay_periods.status = 'closed').
 *
 * Constat : l'employé voyait dans « Mon espace → Bulletins » (liste, PDF,
 * « Comprendre ») un bulletin dont la période était encore « En validation ».
 *
 * La base est simulée par un petit faux pg qui APPLIQUE les filtres présents
 * dans le SQL (jointure pay_periods + statut passé en paramètre) : si une route
 * oublie le filtre, le bulletin non publié remonte et le test échoue.
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
vi.mock('./payslip-pdf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./payslip-pdf.js')>()
  return { ...actual, renderPayslipPdf: vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70])) }
})

import authPlugin from '../../plugins/auth.js'
import payrollRoutes from './payroll.routes.js'

const EMP_A = '11111111-1111-1111-1111-111111111111'
const EMP_B = '22222222-2222-2222-2222-222222222222'
const P_CLOSED = 'aaaaaaaa-0000-0000-0000-000000000001'
const P_PENDING = 'aaaaaaaa-0000-0000-0000-000000000002'
const SLIP_A_CLOSED = '33333333-3333-3333-3333-000000000001'   // A, 2026-09, période clôturée
const SLIP_A_PENDING = '33333333-3333-3333-3333-000000000002'  // A, 2026-10, en validation
const SLIP_B_CLOSED = '33333333-3333-3333-3333-000000000003'   // B, 2026-09, période clôturée

interface Slip { id: string; employee_id: string; period_id: string; month: string; net_payable: string }

const periods = new Map<string, string>()
let slips: Slip[] = []

function setPeriodStatus(id: string, status: string) { periods.set(id, status) }

function slipRow(s: Slip) {
  return {
    ...s, base_salary: '250000', gross_salary: '250000', total_cnps_sal: '15750', total_cnps_pat: '30000',
    its: '2000', employer_cost: '280000', total_deductions: '17750', lines: [], currency: 'XOF',
    status: 'draft', payment_method: 'wave', payment_status: 'pending', payment_reference: null,
    generated_at: '2026-10-25T10:00:00Z', viewed_by_employee_at: null, paid_at: null,
    file_url: null, indemnite_absence: 0, bordereau_cnps: null,
    first_name: 'Yao', last_name: 'Kouadio', cnps_number: 'C1', nni: 'N1', job_title: 'Comptable',
    period_status: periods.get(s.period_id) ?? null, initiated_at: null, closed_at: null,
  }
}

/** Le statut de période exigé par le SQL ($n de « pp.status = $n »), ou null si aucun filtre. */
function requiredStatus(sql: string, params: unknown[]): string | null {
  const m = /pp\.status = \$(\d+)/.exec(sql)
  return m ? String(params[Number(m[1]) - 1]) : null
}
function published(s: Slip, status: string | null): boolean {
  return status === null || periods.get(s.period_id) === status
}

const updates: Array<{ sql: string; params: unknown[] }> = []

async function fakeDb(sqlIn: unknown, paramsIn?: unknown) {
  const sql = String(sqlIn)
  const params = (paramsIn as unknown[] | undefined) ?? []
  const status = requiredStatus(sql, params)
  if (/^\s*UPDATE/i.test(sql)) { updates.push({ sql, params }); return { rows: [] } }
  if (sql.includes('WHERE email')) return { rows: [] }
  // GET /my-payslips
  if (sql.includes('LIMIT 24')) {
    return { rows: slips.filter((s) => s.employee_id === params[0] && published(s, status)).map(slipRow) }
  }
  // PDF self-service : bulletin ciblé ET restreint à l'employé du token
  if (sql.includes('ps.id = $1 AND ps.employee_id = $2')) {
    return { rows: slips.filter((s) => s.id === params[0] && s.employee_id === params[1] && published(s, status)).map(slipRow) }
  }
  // Transparence : bulletin + statut de période
  if (sql.includes('period_status') && sql.includes('WHERE ps.id = $1')) {
    return { rows: slips.filter((s) => s.id === params[0]).map(slipRow) }
  }
  // Comparaison des 3 mois précédents
  if (sql.includes('LIMIT 3')) {
    return { rows: slips.filter((s) => s.employee_id === params[0] && s.id !== params[1]
      && s.month < String(params[2]) && published(s, status)).map(slipRow) }
  }
  // Cumuls annuels du PDF
  if (sql.includes('SUM(ps.gross_salary)') || sql.includes('SUM(gross_salary)')) {
    const rows = slips.filter((s) => s.employee_id === params[0] && s.month <= String(params[2]) && published(s, status))
    const n = rows.reduce((t, s) => t + Number(s.net_payable), 0)
    return { rows: [{ g: String(rows.length * 250000), c: '0', i: '0', n: String(n) }] }
  }
  // Liste RH GET /payslips
  if (sql.includes('e.cnps_number') && sql.includes('WHERE 1=1')) {
    return { rows: slips.filter((s) => params.length === 0 || params.includes(s.month) || params.includes(s.employee_id)).map(slipRow) }
  }
  return { rows: [] }
}

function tokenFor(app: FastifyInstance, role: string, employeeId: string | null) {
  return app.jwt.sign({
    sub: 'u-' + role, tenantId: 't1', schemaName: 'tenant_sotra', role,
    email: `${role}@sotra.ci`, firstName: 'T', lastName: 'U', employeeId,
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

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockImplementation(fakeDb)
  updates.length = 0
  periods.clear()
  setPeriodStatus(P_CLOSED, 'closed')
  setPeriodStatus(P_PENDING, 'pending_validation')
  slips = [
    { id: SLIP_A_CLOSED, employee_id: EMP_A, period_id: P_CLOSED, month: '2026-09', net_payable: '230000' },
    { id: SLIP_A_PENDING, employee_id: EMP_A, period_id: P_PENDING, month: '2026-10', net_payable: '232250' },
    { id: SLIP_B_CLOSED, employee_id: EMP_B, period_id: P_CLOSED, month: '2026-09', net_payable: '400000' },
  ]
})

const asEmployee = (role = 'employee', emp: string = EMP_A) => ({ authorization: `Bearer ${tokenFor(app, role, emp)}` })

describe('GET /payroll/my-payslips — bulletins publiés uniquement', () => {
  it('période en validation : le bulletin (et son net) n\'apparaît pas', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/my-payslips', headers: asEmployee() })
    expect(res.statusCode).toBe(200)
    const ids = (JSON.parse(res.body).data as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toEqual([SLIP_A_CLOSED])
    expect(res.body).not.toContain('232250')
  })

  it('n\'horodate « vu » que les bulletins publiés', async () => {
    await app.inject({ method: 'GET', url: '/payroll/my-payslips', headers: asEmployee() })
    expect(updates).toHaveLength(1)
    expect(updates[0]!.sql).toMatch(/pp\.status = \$2/)
    expect(updates[0]!.params).toEqual([EMP_A, 'closed'])
  })

  it('après clôture de la période, le bulletin devient visible', async () => {
    setPeriodStatus(P_PENDING, 'closed')
    const res = await app.inject({ method: 'GET', url: '/payroll/my-payslips', headers: asEmployee() })
    const ids = (JSON.parse(res.body).data as Array<{ id: string }>).map((r) => r.id).sort()
    expect(ids).toEqual([SLIP_A_CLOSED, SLIP_A_PENDING].sort())
  })

  it('statuts intermédiaires du circuit multi-filiales : toujours invisible', async () => {
    for (const st of ['open', 'draft_central', 'sent_to_sites', 'completed_by_site', 'validated_central']) {
      setPeriodStatus(P_PENDING, st)
      const res = await app.inject({ method: 'GET', url: '/payroll/my-payslips', headers: asEmployee() })
      const ids = (JSON.parse(res.body).data as Array<{ id: string }>).map((r) => r.id)
      expect(ids, st).toEqual([SLIP_A_CLOSED])
    }
  })

  it('un manager consultant SES bulletins est traité comme un salarié', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/my-payslips', headers: asEmployee('manager') })
    const ids = (JSON.parse(res.body).data as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toEqual([SLIP_A_CLOSED])
  })

  it('isolation : ne remonte jamais les bulletins d\'un autre salarié', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/my-payslips', headers: asEmployee('employee', EMP_B) })
    const ids = (JSON.parse(res.body).data as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toEqual([SLIP_B_CLOSED])
  })
})

describe('GET /payroll/my-payslips/:id/pdf — 404 tant que non publié', () => {
  it('bulletin en validation → 404 (pas 403)', async () => {
    const res = await app.inject({ method: 'GET', url: `/payroll/my-payslips/${SLIP_A_PENDING}/pdf`, headers: asEmployee() })
    expect(res.statusCode).toBe(404)
  })

  it('bulletin publié → PDF ; cumuls annuels limités aux bulletins publiés', async () => {
    const res = await app.inject({ method: 'GET', url: `/payroll/my-payslips/${SLIP_A_CLOSED}/pdf`, headers: asEmployee() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    const cum = queryMock.mock.calls.find((c) => String(c[0]).includes('SUM(ps.gross_salary)'))
    expect(cum?.[1]).toContain('closed')
  })

  it('après clôture → le PDF du mois devient téléchargeable', async () => {
    setPeriodStatus(P_PENDING, 'closed')
    const res = await app.inject({ method: 'GET', url: `/payroll/my-payslips/${SLIP_A_PENDING}/pdf`, headers: asEmployee() })
    expect(res.statusCode).toBe(200)
  })

  it('IDOR : bulletin publié d\'un autre salarié → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/payroll/my-payslips/${SLIP_B_CLOSED}/pdf`, headers: asEmployee() })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /payroll/payslips/:id/transparency (« Comprendre »)', () => {
  it('employé, son bulletin en validation → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/payroll/payslips/${SLIP_A_PENDING}/transparency`, headers: asEmployee() })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('232250')
  })

  it('employé, après clôture → 200', async () => {
    setPeriodStatus(P_PENDING, 'closed')
    const res = await app.inject({ method: 'GET', url: `/payroll/payslips/${SLIP_A_PENDING}/transparency`, headers: asEmployee() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).slip.netPayable).toBe(232250)
  })

  it('employé : la comparaison n\'inclut pas un mois précédent non publié', async () => {
    // Le mois précédent (09) repasse en validation, le mois courant (10) est clôturé.
    setPeriodStatus(P_PENDING, 'closed')
    setPeriodStatus(P_CLOSED, 'pending_validation')
    const res = await app.inject({ method: 'GET', url: `/payroll/payslips/${SLIP_A_PENDING}/transparency`, headers: asEmployee() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).comparison).toEqual([])
  })

  it('IDOR conservé : bulletin d\'un autre salarié → 403', async () => {
    const res = await app.inject({ method: 'GET', url: `/payroll/payslips/${SLIP_B_CLOSED}/transparency`, headers: asEmployee() })
    expect(res.statusCode).toBe(403)
  })

  it.each(['admin', 'hr_manager', 'hr_officer', 'readonly'])('%s voit le bulletin en validation (200)', async (role) => {
    const res = await app.inject({ method: 'GET', url: `/payroll/payslips/${SLIP_A_PENDING}/transparency`, headers: asEmployee(role, EMP_B) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).period.status).toBe('pending_validation')
    // Comparaison RH : historique complet, sans filtre de publication.
    const comp = queryMock.mock.calls.find((c) => String(c[0]).includes('LIMIT 3'))
    expect(String(comp?.[0])).not.toMatch(/pp\.status/)
  })
})

describe('GET /payroll/payslips — RH', () => {
  it('la liste RH inclut les bulletins de période en validation', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/payslips', headers: asEmployee('hr_manager', EMP_B) })
    expect(res.statusCode).toBe(200)
    const ids = (JSON.parse(res.body).data as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toContain(SLIP_A_PENDING)
  })

  it('reste interdite au salarié (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/payslips', headers: asEmployee() })
    expect(res.statusCode).toBe(403)
  })
})
