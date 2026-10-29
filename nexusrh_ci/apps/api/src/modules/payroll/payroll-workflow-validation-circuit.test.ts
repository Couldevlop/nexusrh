/**
 * Paie MULTI-FILIALES — circuit de validation nominatif (mêmes règles que la
 * paie mono-entité, service payroll-validation).
 *
 * Étape où le circuit s'applique : la consolidation centrale (validate-central)
 * INITIE le circuit sur la période parente ; chaque niveau est validé par son
 * valideur désigné (puis l'équipe RH après l'échéance) ; le dernier niveau
 * clôture la parente ET les filles. Rejet (commentaire obligatoire) et
 * annulation de l'initiation (initiateur, avant toute validation) défont la
 * paie en transaction : bulletins de toutes les filiales supprimés, parente et
 * filles renvoyées aux sites ; refus si un bulletin est payé ; paie clôturée
 * immuable. Les bulletins des filiales ne sont publiés au salarié qu'à la
 * clôture finale.
 *
 * Base simulée : routeur SQL en mémoire (BEGIN / ROLLBACK restaurent l'état).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, releaseMock } = vi.hoisted(() => ({ queryMock: vi.fn(), releaseMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({
    query: queryMock, end: vi.fn(),
    connect: vi.fn(async () => ({ query: queryMock, release: releaseMock })),
  })),
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
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))

import authPlugin from '../../plugins/auth.js'
import workflowRoutes from './payroll-workflow.routes.js'
import payrollRoutes from './payroll.routes.js'

const SCHEMA = 'tenant_multi'
const MONTH = '2026-10'
const PARENT = '11111111-1111-4111-8111-111111111111'
const CHILD_1 = '22222222-2222-4222-8222-222222222221'
const CHILD_2 = '22222222-2222-4222-8222-222222222222'
const EMP_A = '33333333-3333-4333-8333-333333333331'
const EMP_B = '33333333-3333-4333-8333-333333333332'
const DAY = 86_400_000

const USERS = [
  { id: 'u-init', first_name: 'Awa', last_name: 'Koné', role: 'hr_manager', is_active: true },
  { id: 'u-paie', first_name: 'Yao', last_name: 'Brou', role: 'hr_officer', is_active: true },
  { id: 'u-drh', first_name: 'Fanta', last_name: 'Traoré', role: 'hr_manager', is_active: true },
  { id: 'u-admin', first_name: 'Ali', last_name: 'Diallo', role: 'admin', is_active: true },
  { id: 'u-raf1', first_name: 'Raf', last_name: 'Un', role: 'raf_site', is_active: true },
  { id: 'u-raf2', first_name: 'Raf', last_name: 'Deux', role: 'raf_site', is_active: true },
]

interface Period {
  id: string; month: string; status: string; parent_period_id: string | null; raf_user_id: string | null
  initiated_by: string | null; initiated_at: string | null; validated_by: string | null; validated_central_at: string | null
  completed_by_site_at: string | null; rejection_reason: string | null
  total_gross: string | null; total_net: string | null; total_cnps: string | null; total_its: string | null
  closed_at: string | null; closed_by: string | null
}
interface Slip {
  id: string; period_id: string; employee_id: string; month: string; net_payable: string
  status: string; payment_status: string | null; paid_at: string | null; has_payment: boolean
}
interface Approval { period_id: string; level: number; approver_id: string; approver_role: string; approved_at: string; notes: string | null }
interface Db {
  periods: Period[]; slips: Slip[]; approvals: Approval[]
  levels: number; validators: Array<{ userId: string | null; functionLabel?: string | null; slaDays?: number }>
  log: string[]; audits: Array<{ action: string; changes: Record<string, unknown> }>; sql: string[]
  snapshot: string | null
}
let db: Db

function period(over: Partial<Period>): Period {
  return {
    id: PARENT, month: MONTH, status: 'validated_central', parent_period_id: null, raf_user_id: null,
    initiated_by: null, initiated_at: null, validated_by: null, validated_central_at: null,
    completed_by_site_at: null, rejection_reason: null,
    total_gross: '500000', total_net: '450000', total_cnps: '70000', total_its: '6000',
    closed_at: null, closed_by: null, ...over,
  }
}
function slip(id: string, periodId: string, employeeId: string, over: Partial<Slip> = {}): Slip {
  return { id, period_id: periodId, employee_id: employeeId, month: MONTH, net_payable: '225000', status: 'generated', payment_status: 'pending', paid_at: null, has_payment: false, ...over }
}

/** Paie consolidée (en validation) initiée par u-init il y a `initiatedDaysAgo` jours. */
function seedPending(initiatedDaysAgo = 0.5) {
  const at = new Date(Date.now() - initiatedDaysAgo * DAY).toISOString()
  db.periods = [
    period({ initiated_by: 'u-init', initiated_at: at, validated_by: 'u-init', validated_central_at: at }),
    period({ id: CHILD_1, parent_period_id: PARENT, raf_user_id: 'u-raf1', completed_by_site_at: at, validated_by: 'u-init', validated_central_at: at }),
    period({ id: CHILD_2, parent_period_id: PARENT, raf_user_id: 'u-raf2', completed_by_site_at: at, validated_by: 'u-init', validated_central_at: at }),
  ]
  db.slips = [slip('slip-a', CHILD_1, EMP_A), slip('slip-b', CHILD_2, EMP_B)]
}

const byId = (id: unknown) => db.periods.find(p => p.id === String(id))
const parentOf = () => byId(PARENT)!
const childrenOf = (id: unknown) => db.periods.filter(p => p.parent_period_id === String(id))

function route() {
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql)
    const p = params ?? []
    const t = q.trim()
    db.sql.push(q)
    if (t === 'BEGIN') { db.snapshot = JSON.stringify({ periods: db.periods, slips: db.slips, approvals: db.approvals }); db.log.push(t); return { rows: [] } }
    if (t === 'COMMIT') { db.snapshot = null; db.log.push(t); return { rows: [] } }
    if (t === 'ROLLBACK') {
      if (db.snapshot) Object.assign(db, JSON.parse(db.snapshot) as Pick<Db, 'periods' | 'slips' | 'approvals'>)
      db.snapshot = null; db.log.push(t); return { rows: [] }
    }
    if (q.includes('.audit_log')) {
      db.audits.push({ action: String(p[1]), changes: JSON.parse(String(p[4] ?? '{}')) as Record<string, unknown> })
      db.log.push(`audit:${String(p[1])}`)
      return { rows: [] }
    }
    if (q.includes('.notifications')) { db.log.push(`notify:${String(p[0])}:${String(p[1])}`); return { rows: [] } }
    if (q.includes('.workflow_configs')) return { rows: [{ levels_count: db.levels, config: { validators: db.validators } }] }
    if (q.includes('.pay_period_approvals')) {
      if (/^\s*INSERT/i.test(q)) {
        if (db.approvals.some(a => a.period_id === p[0] && (a.level === Number(p[1]) || a.approver_id === p[2]))) {
          throw Object.assign(new Error('duplicate'), { code: '23505' })
        }
        db.approvals.push({ period_id: String(p[0]), level: Number(p[1]), approver_id: String(p[2]), approver_role: String(p[3]), approved_at: new Date().toISOString(), notes: (p[4] as string | null) ?? null })
        return { rows: [] }
      }
      if (/^\s*DELETE/i.test(q)) { db.log.push('delete:approvals'); db.approvals = db.approvals.filter(a => a.period_id !== p[0]); return { rows: [], rowCount: 0 } }
      const wanted = Array.isArray(p[0]) ? (p[0] as string[]) : [String(p[0])]
      const rows = db.approvals.filter(a => wanted.includes(a.period_id))
      if (q.includes('count(')) return { rows: [{ cnt: rows.length }] }
      return { rows: rows.map(a => {
        const u = USERS.find(x => x.id === a.approver_id)
        return { ...a, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null }
      }) }
    }
    if (q.includes('.pay_slips')) {
      if (/^\s*UPDATE/i.test(q)) return { rows: [] }
      if (/^\s*DELETE/i.test(q)) {
        const ids = p[0] as string[]
        db.log.push(`delete:slips:${ids.join(',')}`)
        db.slips = db.slips.filter(s => !ids.includes(s.id))
        return { rows: [], rowCount: ids.length }
      }
      if (q.includes('FOR UPDATE OF ps')) {
        db.log.push(`lock:slips:${String(p[0])}`)
        return { rows: db.slips.filter(s => s.period_id === p[0]).map(s => ({ id: s.id, status: s.status, payment_status: s.payment_status, paid_at: s.paid_at, has_payment: s.has_payment })) }
      }
      // GET /payroll/my-payslips : filtre « pp.status = $2 » appliqué comme en SQL
      if (q.includes('LIMIT 24')) {
        return { rows: db.slips
          .filter(s => s.employee_id === p[0] && byId(s.period_id)?.status === p[1])
          .map(s => ({ ...s, gross_salary: '250000', its: '0', total_cnps_sal: '15750', generated_at: null, viewed_by_employee_at: null, payment_method: 'wave', payment_reference: null, currency: 'XOF' })) }
      }
      return { rows: [] }
    }
    if (q.includes('.expense_reports')) { db.log.push(`expenses:${(p[0] as string[]).join(',')}`); return { rows: [], rowCount: 1 } }
    if (q.includes('.offboarding_cases')) { db.log.push(`settlement:${(p[0] as string[]).join(',')}`); return { rows: [], rowCount: 0 } }
    // Valideurs candidats aux alertes : équipe RH active + valideur désigné
    if (q.includes('.users') && q.includes('role = ANY')) {
      const roles = p[0] as string[]
      return { rows: USERS.filter(u => u.is_active && (roles.includes(u.role) || u.id === p[1])).map(u => ({ ...u, email: `${u.id}@sotra.ci` })) }
    }
    if (q.includes('.users') && !q.includes('.pay_periods')) {
      const ids = (p[0] as string[] | undefined) ?? []
      return { rows: USERS.filter(u => ids.includes(u.id)) }
    }
    if (q.includes('.pay_periods')) {
      if (/^\s*UPDATE/i.test(q)) {
        if (q.includes("status = 'sent_to_sites'") && q.includes('parent_period_id IS NULL')) {
          const par = byId(p[0])
          if (!par || par.parent_period_id || par.status !== 'validated_central') return { rows: [] }
          Object.assign(par, { status: 'sent_to_sites', rejection_reason: (p[1] as string | null) ?? null, initiated_by: null, initiated_at: null, validated_by: null, validated_central_at: null, total_gross: null, total_net: null })
          db.log.push('parent:sent_to_sites')
          return { rows: [{ id: par.id }] }
        }
        if (q.includes("status = 'sent_to_sites'") && q.includes('WHERE parent_period_id = $1')) {
          for (const c of childrenOf(p[0])) Object.assign(c, { status: 'sent_to_sites', rejection_reason: (p[1] as string | null) ?? null, completed_by_site_at: null, validated_by: null, validated_central_at: null, total_gross: null, total_net: null })
          db.log.push('children:sent_to_sites')
          return { rows: [] }
        }
        if (q.includes("status = 'closed'")) {
          for (const x of db.periods.filter(x => (x.id === p[1] || x.parent_period_id === p[1]) && x.status === 'validated_central')) {
            Object.assign(x, { status: 'closed', closed_by: String(p[0]), closed_at: new Date().toISOString() })
          }
          db.log.push('closed')
          return { rows: [] }
        }
        if (q.includes("status = 'validated_central'") && q.includes('WHERE id = $2')) {
          const par = byId(p[1])!
          Object.assign(par, { status: 'validated_central', validated_by: String(p[0]), validated_central_at: new Date().toISOString(),
            ...(q.includes('initiated_by = $1') ? { initiated_by: String(p[0]), initiated_at: new Date().toISOString(), rejection_reason: null } : {}) })
          return { rows: [] }
        }
        if (q.includes("status = 'validated_central'") && q.includes('WHERE parent_period_id = $2')) {
          for (const c of childrenOf(p[1])) Object.assign(c, { status: 'validated_central', validated_by: String(p[0]) })
          return { rows: [] }
        }
        return { rows: [] }
      }
      if (q.includes('WHERE parent_period_id = $1')) return { rows: childrenOf(p[0]).map(c => ({ ...c })) }
      if (q.includes('WHERE id = $1')) { const x = byId(p[0]); return { rows: x ? [{ ...x }] : [] } }
      if (q.includes(' pp')) return { rows: db.periods.map(x => ({ ...x, legal_entity_name: null })) }
      return { rows: [] }
    }
    return { rows: [] }
  })
}

let app: FastifyInstance
function token(sub: string, role = USERS.find(u => u.id === sub)?.role ?? 'employee', employeeId: string | null = null) {
  const u = USERS.find(x => x.id === sub)
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role, email: `${sub}@multi.ci`,
    firstName: u?.first_name ?? 'X', lastName: u?.last_name ?? 'Y', employeeId,
  })
}
function call(method: 'GET' | 'POST', action: string, sub: string, payload?: unknown, role?: string, id = PARENT) {
  return app.inject({
    method, url: `/payroll-workflow/periods/${id}/${action}`,
    headers: { authorization: `Bearer ${token(sub, role)}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(workflowRoutes, { prefix: '/payroll-workflow' })
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset()
  releaseMock.mockReset()
  db = {
    periods: [], slips: [], approvals: [], levels: 2,
    validators: [
      { userId: 'u-paie', functionLabel: 'Chef de service paie', slaDays: 2 },
      { userId: 'u-drh', functionLabel: 'DRH', slaDays: 2 },
    ],
    log: [], audits: [], sql: [], snapshot: null,
  }
  route()
})

describe('Consolidation = initiation du circuit', () => {
  beforeEach(() => {
    db.periods = [
      period({ status: 'sent_to_sites', total_gross: null, total_net: null }),
      period({ id: CHILD_1, parent_period_id: PARENT, raf_user_id: 'u-raf1', status: 'completed_by_site', total_gross: '300000', total_net: '270000' }),
      period({ id: CHILD_2, parent_period_id: PARENT, raf_user_id: 'u-raf2', status: 'completed_by_site', total_gross: '200000', total_net: '180000' }),
    ]
  })

  it('l’auteur de la consolidation devient l’initiateur ; message sans jargon nommant le valideur ; valideur prévenu', async () => {
    const res = await call('POST', 'validate-central', 'u-init')
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.message).toBe(`Période ${MONTH} en attente de validation par Yao Brou (Chef de service paie)`)
    expect(body.message).not.toMatch(/validated_central|POST|\/payroll/)
    expect(body.pendingWith).toMatchObject({ level: 1, requiredLevels: 2, userId: 'u-paie', name: 'Yao Brou' })
    expect(parentOf()).toMatchObject({ status: 'validated_central', initiated_by: 'u-init' })
    expect(childrenOf(PARENT).every(c => c.status === 'validated_central')).toBe(true)
    await vi.waitFor(() => expect(db.log).toContain('notify:u-paie:payroll_validation_requested'))
  })

  it('niveau 1 sans valideur désigné : toute l’équipe RH hors initiateur est alertée (in-app)', async () => {
    db.validators = [{ userId: null }, { userId: null }]
    const res = await call('POST', 'validate-central', 'u-init')
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => expect(db.log.filter(l => l.endsWith(':payroll_validation_requested')).length).toBe(2))
    expect(db.log.filter(l => l.endsWith(':payroll_validation_requested')).sort())
      .toEqual(['notify:u-admin:payroll_validation_requested', 'notify:u-drh:payroll_validation_requested'])
  })

  it('les filles ne sont PAS clôturées à la consolidation (bulletins encore invisibles)', async () => {
    await call('POST', 'validate-central', 'u-init')
    expect(db.periods.some(p => p.status === 'closed')).toBe(false)
  })

  it('une consolidation ne se rejoue pas (409) : la paie est déjà en validation', async () => {
    await call('POST', 'validate-central', 'u-init')
    const again = await call('POST', 'validate-central', 'u-admin')
    expect(again.statusCode).toBe(409)
    expect(parentOf().initiated_by).toBe('u-init')
  })
})

describe('Valideur désigné, SoD, escalade', () => {
  it('GET workflow : valideur attendu, échéance, niveaux et droits du lecteur', async () => {
    seedPending()
    const res = await call('GET', 'workflow', 'u-paie')
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.period).toMatchObject({ id: PARENT, month: MONTH, status: 'validated_central', initiatedBy: 'u-init', initiatorName: 'Awa Koné' })
    expect(body.pendingWith).toMatchObject({ userId: 'u-paie', name: 'Yao Brou', functionLabel: 'Chef de service paie', overdue: false })
    expect(body.levels.map((l: { status: string }) => l.status)).toEqual(['current', 'upcoming'])
    expect(body.levels[1].validator).toMatchObject({ userId: 'u-drh', name: 'Fanta Traoré' })
    expect(body.viewer).toMatchObject({ canApprove: true, canReject: true, canCancel: false })
  })

  it('le reste de l’équipe RH attend le valideur désigné jusqu’à l’échéance (403 nominatif)', async () => {
    seedPending()
    const view = json(await call('GET', 'workflow', 'u-admin'))
    expect(view.viewer).toMatchObject({ canApprove: false, canReject: false, deniedReason: 'awaiting_designated' })
    const res = await call('POST', 'approve', 'u-admin', {})
    expect(res.statusCode).toBe(403)
    expect(json(res).error).toContain('Yao Brou (Chef de service paie)')
    expect(db.approvals).toHaveLength(0)
  })

  it('SoD : l’initiateur (auteur de la consolidation) ne valide jamais', async () => {
    seedPending()
    db.validators = [{ userId: null }, { userId: null }]
    const res = await call('POST', 'approve', 'u-init', {})
    expect(res.statusCode).toBe(403)
    expect(json(res).error).toMatch(/séparation des tâches/)
    const view = json(await call('GET', 'workflow', 'u-init'))
    expect(view.viewer).toMatchObject({ canApprove: false, canCancel: true, deniedReason: 'initiator' })
  })

  it('SoD : initiateur désigné valideur → niveau ouvert d’emblée à l’équipe RH (escalade tracée)', async () => {
    seedPending()
    db.validators = [{ userId: 'u-init', functionLabel: 'DAF' }, { userId: 'u-drh' }]
    const res = await call('POST', 'approve', 'u-admin', {})
    expect(res.statusCode).toBe(200)
    expect(json(res).data).toMatchObject({ level: 1, escalated: true })
  })

  it('circuit complet : niveau 1 par le désigné, niveau 2 par le DRH → parente ET filles clôturées', async () => {
    seedPending()
    const l1 = await call('POST', 'approve', 'u-paie', { notes: 'Totaux conformes' })
    expect(l1.statusCode).toBe(200)
    expect(json(l1).data).toMatchObject({ status: 'validated_central', level: 1, requiredLevels: 2, escalated: false })
    expect(json(l1).message).toContain('Période 2026-10 en attente de validation par Fanta Traoré (DRH)')
    await vi.waitFor(() => expect(db.log).toContain('notify:u-drh:payroll_validation_requested'))
    expect(db.periods.every(p => p.status === 'validated_central')).toBe(true)

    // Le valideur du niveau 1 ne valide pas un second niveau
    const again = await call('POST', 'approve', 'u-paie', {})
    expect(again.statusCode).toBe(403)

    const l2 = await call('POST', 'approve', 'u-drh', {})
    expect(l2.statusCode).toBe(200)
    expect(json(l2).data).toMatchObject({ status: 'closed', level: 2 })
    expect(db.periods.map(p => p.status)).toEqual(['closed', 'closed', 'closed'])
    expect(db.audits.map(a => a.action)).toEqual(['workflow.approve', 'workflow.approve', 'workflow.close'])
    expect(db.log).toContain('notify:u-init:payroll_closed')
    // Une seule chaîne de validations, portée par la parente
    expect(db.approvals.every(a => a.period_id === PARENT)).toBe(true)
  })

  it('« Clôturer » (alias historique) applique exactement les mêmes règles', async () => {
    seedPending()
    expect((await call('POST', 'close', 'u-admin', {})).statusCode).toBe(403)
    const res = await call('POST', 'close', 'u-paie', {})
    expect(res.statusCode).toBe(200)
    expect(json(res).data).toMatchObject({ level: 1, status: 'validated_central' })
  })

  it('échéance dépassée : l’équipe RH (hors initiateur) reprend la main, par escalade', async () => {
    seedPending(3)
    const view = json(await call('GET', 'workflow', 'u-admin'))
    expect(view.pendingWith).toMatchObject({ overdue: true, teamCanAct: true })
    expect(view.viewer).toMatchObject({ canApprove: true, escalated: true })
    const res = await call('POST', 'approve', 'u-admin', {})
    expect(res.statusCode).toBe(200)
    expect(json(res).data).toMatchObject({ level: 1, escalated: true })
    expect(db.audits[0]).toMatchObject({ action: 'workflow.approve', changes: { escalated: true, level: 1 } })
    // L'initiateur reste exclu même après l'échéance
    expect((await call('POST', 'approve', 'u-init', {})).statusCode).toBe(403)
  })

  it('un hr_officer non désigné n’agit jamais (pas d’escalade vers lui)', async () => {
    seedPending(3)
    const res = await call('POST', 'approve', 'u-other', {}, 'hr_officer')
    expect(res.statusCode).toBe(403)
  })
})

describe('Rejet / renvoi en préparation', () => {
  it('commentaire obligatoire (≥ 10 caractères) : 400 sans rien modifier', async () => {
    seedPending()
    for (const payload of [{}, { reason: 'court' }]) {
      const res = await call('POST', 'reject', 'u-paie', payload)
      expect(res.statusCode).toBe(400)
      expect(json(res).error).toMatch(/Commentaire obligatoire/)
    }
    expect(parentOf().status).toBe('validated_central')
    expect(db.slips).toHaveLength(2)
  })

  it('réservé au valideur attendu : un autre membre RH avant l’échéance → 403', async () => {
    seedPending()
    const res = await call('POST', 'reject', 'u-admin', { reason: 'Écart CNPS inexpliqué sur la filiale 2' })
    expect(res.statusCode).toBe(403)
    expect(db.slips).toHaveLength(2)
  })

  it('valideur attendu : transaction, bulletins de TOUTES les filles supprimés, parente et filles renvoyées aux sites, audit + notifications', async () => {
    seedPending()
    await call('POST', 'approve', 'u-paie', {})
    const reason = 'Écart CNPS inexpliqué sur la filiale 2'
    const res = await call('POST', 'reject', 'u-drh', { reason })
    expect(res.statusCode).toBe(200)
    expect(json(res).data).toMatchObject({ status: 'sent_to_sites', deletedPaySlips: 2, sitesReopened: 2 })
    expect(db.slips).toHaveLength(0)
    expect(db.periods.map(p => p.status)).toEqual(['sent_to_sites', 'sent_to_sites', 'sent_to_sites'])
    expect(db.periods.every(p => p.rejection_reason === reason)).toBe(true)
    expect(parentOf()).toMatchObject({ initiated_by: null, validated_by: null })
    expect(db.approvals).toHaveLength(0)
    // revertPeriodPayslips sur la parente ET chaque fille, dans une transaction
    expect(db.log).toEqual(expect.arrayContaining([`lock:slips:${PARENT}`, `lock:slips:${CHILD_1}`, `lock:slips:${CHILD_2}`, 'delete:approvals']))
    expect(db.log.indexOf('BEGIN')).toBeLessThan(db.log.indexOf('COMMIT'))
    expect(db.log).not.toContain('ROLLBACK')
    expect(db.audits.at(-1)).toMatchObject({ action: 'workflow.reject', changes: { reason, level: 2, deletedPaySlips: 2, sitesReopened: 2 } })
    expect(db.log).toEqual(expect.arrayContaining([
      'notify:u-init:payroll_rejected', 'notify:u-raf1:payroll_rejected', 'notify:u-raf2:payroll_rejected',
    ]))
    // Plus rien à valider tant que les sites n'ont pas re-soumis et la RH reconsolidé
    expect((await call('POST', 'approve', 'u-drh', {})).statusCode).toBe(409)
  })

  it('après l’échéance, l’équipe RH peut renvoyer en préparation (escalade tracée)', async () => {
    seedPending(3)
    const res = await call('POST', 'reject', 'u-admin', { reason: 'Primes de transport manquantes' })
    expect(res.statusCode).toBe(200)
    expect(db.audits.at(-1)).toMatchObject({ action: 'workflow.reject', changes: { escalated: true } })
  })

  it('un bulletin d’une filiale déjà payé → 409, ROLLBACK : rien n’est modifié', async () => {
    seedPending()
    db.slips[1] = slip('slip-b', CHILD_2, EMP_B, { status: 'paid', payment_status: 'completed', paid_at: '2026-10-30T10:00:00Z' })
    const res = await call('POST', 'reject', 'u-paie', { reason: 'Écart CNPS inexpliqué sur la filiale 2' })
    expect(res.statusCode).toBe(409)
    expect(json(res).error).toMatch(/1 bulletin\(s\).*payés/)
    expect(db.log).toContain('ROLLBACK')
    expect(db.log).not.toContain('COMMIT')
    expect(db.periods.map(p => p.status)).toEqual(['validated_central', 'validated_central', 'validated_central'])
    expect(db.slips).toHaveLength(2)
    expect(db.audits).toHaveLength(0)
  })
})

describe('Annulation de l’initiation', () => {
  it('par l’initiateur avant toute validation : même retour arrière transactionnel', async () => {
    seedPending()
    const res = await call('POST', 'cancel', 'u-init', { comment: 'Oubli des primes de fin d’année' })
    expect(res.statusCode).toBe(200)
    expect(json(res).data).toMatchObject({ status: 'sent_to_sites', deletedPaySlips: 2, sitesReopened: 2 })
    expect(db.periods.map(p => p.status)).toEqual(['sent_to_sites', 'sent_to_sites', 'sent_to_sites'])
    expect(db.periods.every(p => p.rejection_reason === null)).toBe(true)
    expect(db.audits.at(-1)).toMatchObject({ action: 'workflow.cancel_initiation' })
  })

  it('réservée à l’initiateur (403 pour un autre admin)', async () => {
    seedPending()
    const res = await call('POST', 'cancel', 'u-admin', {})
    expect(res.statusCode).toBe(403)
    expect(parentOf().status).toBe('validated_central')
  })

  it('impossible dès qu’un niveau a validé (409)', async () => {
    seedPending()
    await call('POST', 'approve', 'u-paie', {})
    const res = await call('POST', 'cancel', 'u-init', {})
    expect(res.statusCode).toBe(409)
    expect(json(res).error).toMatch(/déjà été validé/)
    expect(db.slips).toHaveLength(2)
    expect(json(await call('GET', 'workflow', 'u-init')).viewer.canCancel).toBe(false)
  })
})

describe('Paie clôturée immuable, périmètre et RBAC', () => {
  it('paie clôturée : ni validation, ni rejet, ni annulation (409) ; bulletins conservés', async () => {
    seedPending()
    for (const p of db.periods) p.status = 'closed'
    const attempts: Array<[string, string, object]> = [
      ['approve', 'u-paie', {}], ['reject', 'u-paie', { reason: 'Je veux tout refaire ce mois' }], ['cancel', 'u-init', {}],
    ]
    for (const [action, sub, payload] of attempts) {
      const res = await call('POST', action, sub, payload)
      expect(res.statusCode, action).toBe(409)
      expect(json(res).error).toMatch(/immuable/)
    }
    expect(db.slips).toHaveLength(2)
    expect(db.periods.every(p => p.status === 'closed')).toBe(true)
  })

  it('le circuit ne s’applique qu’à la période parente : une fille → 404', async () => {
    seedPending()
    for (const action of ['approve', 'reject', 'cancel', 'workflow']) {
      const res = await call(action === 'workflow' ? 'GET' : 'POST', action, action === 'cancel' ? 'u-init' : 'u-paie',
        action === 'workflow' ? undefined : action === 'reject' ? { reason: 'Motif suffisamment long' } : {}, undefined, CHILD_1)
      expect(res.statusCode, action).toBe(404)
    }
  })

  it('identifiant non UUID → 400 (OWASP A03)', async () => {
    seedPending()
    const res = await call('POST', 'approve', 'u-paie', {}, undefined, 'pp-1')
    expect(res.statusCode).toBe(400)
  })

  it('isolation tenant : toutes les requêtes portent sur le schéma du jeton', async () => {
    seedPending()
    await call('POST', 'approve', 'u-paie', {})
    const tenantSql = db.sql.filter(s => /"tenant_/.test(s))
    expect(tenantSql.length).toBeGreaterThan(0)
    expect(tenantSql.every(s => !/"tenant_(?!multi")/.test(s))).toBe(true)
  })

  it.each([
    ['approve', 'raf_site'], ['approve', 'employee'], ['reject', 'manager'], ['cancel', 'hr_officer'], ['workflow', 'employee'],
  ])('%s interdit au rôle %s (403)', async (action, role) => {
    seedPending()
    const res = await call(action === 'workflow' ? 'GET' : 'POST', action, 'u-x', action === 'workflow' ? undefined : {}, role)
    expect(res.statusCode).toBe(403)
  })
})

describe('Liste multi-filiales : valideur attendu des paies en validation', () => {
  it('GET /periods expose pending_with sur la parente consolidée (lecture hr_officer)', async () => {
    seedPending()
    const res = await app.inject({ method: 'GET', url: '/payroll-workflow/periods', headers: { authorization: `Bearer ${token('u-paie')}` } })
    expect(res.statusCode).toBe(200)
    const rows = json(res).data as Array<{ id: string; pending_with?: { name: string } | null }>
    expect(rows.find(r => r.id === PARENT)?.pending_with).toMatchObject({ name: 'Yao Brou', level: 1 })
    expect(rows.find(r => r.id === CHILD_1)?.pending_with).toBeUndefined()
  })
})

describe('Visibilité salarié des bulletins des filiales', () => {
  const myPayslips = (emp: string) => app.inject({
    method: 'GET', url: '/payroll/my-payslips', headers: { authorization: `Bearer ${token('u-emp', 'employee', emp)}` },
  })
  const ids = async (emp: string) => (json(await myPayslips(emp)).data as Array<{ id: string }>).map(r => r.id)

  it('invisibles pendant tout le circuit, publiés seulement à la validation finale', async () => {
    seedPending()
    expect(await ids(EMP_A)).toEqual([])
    await call('POST', 'approve', 'u-paie', {})
    expect(await ids(EMP_A)).toEqual([])
    expect(await ids(EMP_B)).toEqual([])
    await call('POST', 'approve', 'u-drh', {})
    expect(await ids(EMP_A)).toEqual(['slip-a'])
    expect(await ids(EMP_B)).toEqual(['slip-b'])
  })

  it('le filtre self-service porte sur la période du bulletin (fille), passée en paramètre SQL', async () => {
    seedPending()
    await myPayslips(EMP_A)
    const sel = queryMock.mock.calls.find(c => String(c[0]).includes('LIMIT 24'))
    expect(String(sel?.[0])).toMatch(/pp\.status = \$2/)
    expect(sel?.[1]).toEqual([EMP_A, 'closed'])
  })
})
