/**
 * Circuit de validation NOMINATIF de la clôture de paie (recette paie oct. 2026).
 *
 * Couvre : valideur désigné par niveau (seul habilité), SoD (l'initiateur ne
 * valide / ne rejette jamais, même désigné → escalade immédiate), escalade à
 * l'équipe RH après l'échéance, état du circuit exposé à l'UI, rejet avec
 * commentaire obligatoire (transaction : bulletins supprimés, notes de frais
 * et solde de tout compte rétablis, notification de l'initiateur, audit),
 * annulation par l'initiateur avant toute validation, période clôturée
 * immuable, RBAC, message de clôture sans jargon technique.
 *
 * Base simulée : routeur SQL en mémoire (aucune connexion).
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
import payrollRoutes from './payroll.routes.js'

const SCHEMA = 'tenant_sotra'
const MONTH = '2026-10'
const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const DAY = 86_400_000

const USERS = [
  { id: 'u-init', first_name: 'Awa', last_name: 'Koné', role: 'hr_manager', is_active: true },
  { id: 'u-paie', first_name: 'Yao', last_name: 'Brou', role: 'hr_officer', is_active: true },
  { id: 'u-drh', first_name: 'Fanta', last_name: 'Traoré', role: 'hr_manager', is_active: true },
  { id: 'u-admin', first_name: 'Ali', last_name: 'Diallo', role: 'admin', is_active: true },
  { id: 'u-off', first_name: 'Inès', last_name: 'Kouassi', role: 'hr_manager', is_active: false },
]

interface Slip { id: string; status: string; payment_status: string | null; paid_at: string | null; has_payment: boolean }
interface Db {
  period: { id: string; month: string; status: string; initiated_by: string | null; initiated_at: string | null } | null
  levels: number
  validators: Array<{ userId: string | null; functionLabel?: string | null; slaDays?: number }>
  approvals: Array<{ level: number; approver_id: string; approver_role: string; approved_at: string; notes: string | null }>
  slips: Slip[]
  log: string[]
}
let db: Db

function route() {
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql)
    const p = params ?? []
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(q.trim())) { db.log.push(q.trim()); return { rows: [] } }
    if (q.includes('.audit_log')) { db.log.push(`audit:${String(p[1])}`); return { rows: [] } }
    if (q.includes('.notifications')) { db.log.push(`notify:${String(p[0])}:${String(p[1])}`); return { rows: [] } }
    if (q.includes('.workflow_configs')) return { rows: [{ levels_count: db.levels, config: { validators: db.validators } }] }
    if (q.includes('.pay_period_approvals')) {
      if (/^\s*INSERT/i.test(q)) {
        db.approvals.push({ level: Number(p[1]), approver_id: String(p[2]), approver_role: String(p[3]), approved_at: new Date().toISOString(), notes: (p[4] as string | null) ?? null })
        return { rows: [] }
      }
      if (/^\s*DELETE/i.test(q)) { db.log.push('delete:approvals'); db.approvals = []; return { rows: [], rowCount: 0 } }
      if (q.includes('count(')) return { rows: [{ cnt: db.approvals.length }] }
      const withNames = db.approvals.map(a => {
        const u = USERS.find(x => x.id === a.approver_id)
        return { ...a, period_id: PERIOD_ID, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null }
      })
      return { rows: withNames }
    }
    if (q.includes('.pay_slips')) {
      if (/^\s*DELETE/i.test(q)) {
        const ids = p[0] as string[]
        db.log.push(`delete:slips:${ids.join(',')}`)
        db.slips = db.slips.filter(s => !ids.includes(s.id))
        return { rows: [], rowCount: ids.length }
      }
      return { rows: db.slips.map(s => ({ ...s })) }
    }
    if (q.includes('.expense_reports')) { db.log.push(`expenses:${(p[0] as string[]).join(',')}`); return { rows: [], rowCount: 2 } }
    if (q.includes('.offboarding_cases')) { db.log.push(`settlement:${(p[0] as string[]).join(',')}`); return { rows: [], rowCount: 1 } }
    if (q.includes('.users') && !q.includes('.pay_periods')) {
      const ids = (p[0] as string[] | undefined) ?? []
      return { rows: USERS.filter(u => ids.includes(u.id)) }
    }
    if (q.includes('.pay_periods')) {
      if (/^\s*UPDATE/i.test(q)) {
        if (!db.period) return { rows: [] }
        if (q.includes("status = 'open'")) {
          if (db.period.status !== 'pending_validation') return { rows: [] }
          db.period = { ...db.period, status: 'open', initiated_by: null, initiated_at: null }
          db.log.push(`period:open:${String(p[1])}`)
          return { rows: [{ id: db.period.id }] }
        }
        if (q.includes("status = 'closed'")) { db.period = { ...db.period, status: 'closed' }; db.log.push('period:closed') }
        return { rows: [] }
      }
      if (!db.period) return { rows: [] }
      const ini = USERS.find(u => u.id === db.period!.initiated_by)
      return { rows: [{
        ...db.period, rejection_reason: null, closed_at: null, closed_by: null,
        initiator_first_name: ini?.first_name ?? null, initiator_last_name: ini?.last_name ?? null,
      }] }
    }
    return { rows: [] }
  })
}

function pendingPeriod(initiatedDaysAgo = 0.5) {
  return { id: PERIOD_ID, month: MONTH, status: 'pending_validation', initiated_by: 'u-init', initiated_at: new Date(Date.now() - initiatedDaysAgo * DAY).toISOString() }
}

let app: FastifyInstance
function token(sub: string, role: string) {
  return app.jwt.sign({
    sub, tenantId: 't1', schemaName: SCHEMA, role, email: `${sub}@sotra.ci`,
    firstName: USERS.find(u => u.id === sub)?.first_name ?? 'X', lastName: USERS.find(u => u.id === sub)?.last_name ?? 'Y', employeeId: null,
  })
}
const roleOf = (sub: string) => USERS.find(u => u.id === sub)?.role ?? 'employee'
function call(method: 'GET' | 'POST', path: string, sub: string, payload?: unknown, role = roleOf(sub)) {
  return app.inject({ method, url: `/payroll/periods/${MONTH}${path}`, headers: { authorization: `Bearer ${token(sub, role)}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(payrollRoutes, { prefix: '/payroll' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset(); releaseMock.mockReset()
  db = {
    period: pendingPeriod(),
    levels: 2,
    validators: [
      { userId: 'u-paie', functionLabel: 'Chef de service paie', slaDays: 2 },
      { userId: 'u-drh', functionLabel: 'DRH', slaDays: 2 },
    ],
    approvals: [],
    slips: [
      { id: 'slip-1', status: 'generated', payment_status: 'pending', paid_at: null, has_payment: false },
      { id: 'slip-2', status: 'generated', payment_status: 'pending', paid_at: null, has_payment: false },
    ],
    log: [],
  }
  route()
})

describe('Valideur désigné par niveau', () => {
  it('seul le valideur désigné du niveau 1 valide (un hr_officer désigné est habilité)', async () => {
    const res = await call('POST', '/approve', 'u-paie', { notes: 'Contrôle OK' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toMatchObject({ status: 'pending_validation', level: 1, requiredLevels: 2, escalated: false })
    // Le message annonce le valideur suivant, nommé, sans jargon technique
    expect(body.message).toContain('en attente de validation par Fanta Traoré (DRH)')
    expect(body.message).not.toMatch(/POST|\/payroll|hr_manager/)
    expect(db.log).toContain('audit:payroll.approved')
    expect(db.log).toContain('notify:u-drh:payroll_validation_requested')
  })

  it('un autre membre RH ne peut pas agir avant l’échéance (403 nominatif)', async () => {
    const res = await call('POST', '/approve', 'u-admin', {})
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('assigné à Yao Brou (Chef de service paie)')
    expect(db.approvals).toHaveLength(0)
  })

  it('le niveau 2 n’est ouvert qu’à son valideur désigné', async () => {
    db.approvals = [{ level: 1, approver_id: 'u-paie', approver_role: 'hr_officer', approved_at: new Date().toISOString(), notes: null }]
    expect((await call('POST', '/approve', 'u-admin', {})).statusCode).toBe(403)
    const ok = await call('POST', '/approve', 'u-drh', {})
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).data.status).toBe('closed')
    expect(db.log).toContain('period:closed')
    expect(db.log).toContain('audit:payroll.closed')
    expect(db.log).toContain('notify:u-init:payroll_closed')
  })

  it('un hr_officer NON désigné ne valide jamais (pas d’escalade vers lui)', async () => {
    db.validators = []
    const res = await call('POST', '/approve', 'u-paie', {})
    expect(res.statusCode).toBe(403)
  })

  it('sans désignation : tout admin / hr_manager autre que l’initiateur (comportement historique)', async () => {
    db.validators = []
    const res = await call('POST', '/approve', 'u-admin', {})
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toContain('par un administrateur ou responsable RH autre que l\'initiateur')
  })
})

describe('Séparation des tâches (SoD)', () => {
  it('l’initiateur ne valide jamais sa propre clôture, même désigné', async () => {
    db.validators = [{ userId: 'u-init', functionLabel: 'Chef de service paie' }, { userId: 'u-drh' }]
    const res = await call('POST', '/approve', 'u-init', {})
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('séparation des tâches')
  })

  it('initiateur désigné → niveau ouvert d’emblée à l’équipe RH (escalade tracée)', async () => {
    db.validators = [{ userId: 'u-init', functionLabel: 'Chef de service paie' }, { userId: 'u-drh' }]
    const res = await call('POST', '/approve', 'u-admin', {})
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.escalated).toBe(true)
  })

  it('valideur désigné désactivé → escalade immédiate à l’équipe RH', async () => {
    db.validators = [{ userId: 'u-off' }, { userId: 'u-drh' }]
    expect((await call('POST', '/approve', 'u-admin', {})).statusCode).toBe(200)
  })

  it('l’initiateur ne peut pas non plus rejeter (il annule son initiation)', async () => {
    const res = await call('POST', '/reject', 'u-init', { reason: 'Je veux tout recommencer' })
    expect(res.statusCode).toBe(403)
  })
})

describe('Escalade après échéance (SLA)', () => {
  it('échéance dépassée : l’équipe RH (hors initiateur) prend la main', async () => {
    db.period = pendingPeriod(3) // SLA 2 j
    const res = await call('POST', '/approve', 'u-admin', {})
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.escalated).toBe(true)
    const audit = queryMock.mock.calls.find(c => String(c[0]).includes('.audit_log') && (c[1] as unknown[])[1] === 'payroll.approved')
    expect(JSON.parse(String((audit![1] as unknown[])[4]))).toMatchObject({ escalated: true, level: 1 })
  })

  it('même après l’échéance, l’initiateur reste exclu', async () => {
    db.period = pendingPeriod(3)
    expect((await call('POST', '/approve', 'u-init', {})).statusCode).toBe(403)
  })
})

describe('GET /workflow — état du circuit pour l’UI', () => {
  it('niveau courant : valideur attendu nommé + fonction + échéance ; droits du lecteur', async () => {
    db.approvals = [{ level: 1, approver_id: 'u-paie', approver_role: 'hr_officer', approved_at: new Date().toISOString(), notes: 'RAS' }]
    const res = await call('GET', '/workflow', 'u-drh')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.levels).toHaveLength(2)
    expect(body.levels[0]).toMatchObject({ level: 1, status: 'approved', functionLabel: 'Chef de service paie', approval: { approverName: 'Yao Brou', escalated: false } })
    expect(body.levels[1]).toMatchObject({ level: 2, status: 'current', functionLabel: 'DRH', validator: { name: 'Fanta Traoré', available: true } })
    expect(body.levels[1].dueAt).toBeTruthy()
    expect(body.pendingWith).toMatchObject({ level: 2, name: 'Fanta Traoré', functionLabel: 'DRH', teamCanAct: false })
    expect(body.viewer).toMatchObject({ canApprove: true, canReject: true, canCancel: false })
  })

  it('l’initiateur voit « Annuler l’initiation » tant qu’aucun niveau n’a validé', async () => {
    const body = JSON.parse((await call('GET', '/workflow', 'u-init')).body)
    expect(body.viewer).toMatchObject({ canApprove: false, canReject: false, canCancel: true, deniedReason: 'initiator' })
  })

  it('un membre RH non désigné : lecture seule, avec la raison', async () => {
    const body = JSON.parse((await call('GET', '/workflow', 'u-admin')).body)
    expect(body.viewer).toMatchObject({ canApprove: false, deniedReason: 'awaiting_designated' })
    expect(body.viewer.deniedMessage).toContain('Yao Brou')
  })

  it('mois invalide → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/periods/2026-13/workflow', headers: { authorization: `Bearer ${token('u-admin', 'admin')}` } })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /reject — renvoi en préparation', () => {
  it('commentaire obligatoire (absent ou trop court → 400)', async () => {
    expect((await call('POST', '/reject', 'u-paie', {})).statusCode).toBe(400)
    expect((await call('POST', '/reject', 'u-paie', { reason: 'trop' })).statusCode).toBe(400)
    expect(db.log).not.toContain('BEGIN')
  })

  it('valideur désigné : bulletins supprimés, frais + solde rétablis, initiateur notifié, audit — en transaction', async () => {
    const res = await call('POST', '/reject', 'u-paie', { reason: 'Prime de transport erronée sur 3 bulletins' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toMatchObject({ status: 'open', deletedPaySlips: 2, restoredExpenses: 2, restoredSettlements: 1 })
    expect(db.log[0]).toBe('BEGIN')
    expect(db.log).toContain('expenses:slip-1,slip-2')
    expect(db.log).toContain('settlement:slip-1,slip-2')
    expect(db.log).toContain('delete:slips:slip-1,slip-2')
    expect(db.log).toContain('delete:approvals')
    expect(db.log).toContain('COMMIT')
    expect(db.log).toContain('audit:payroll.rejected')
    expect(db.log).toContain('notify:u-init:payroll_rejected')
    expect(db.period?.status).toBe('open')
    expect(releaseMock).toHaveBeenCalled()
    // Notes de frais : seules celles payées PAR CES bulletins sont remises « approuvées »
    const exp = queryMock.mock.calls.find(c => String(c[0]).includes('.expense_reports'))!
    expect(String(exp[0])).toMatch(/status = 'approved', payment_method = NULL, payment_reference = NULL, paid_at = NULL/)
    expect(String(exp[0])).toMatch(/status = 'paid' AND payment_method = 'payslip' AND payment_reference = ANY/)
    // Solde de tout compte : marqueurs de markSettlementPaid retirés
    const off = queryMock.mock.calls.find(c => String(c[0]).includes('.offboarding_cases'))!
    expect(String(off[0])).toContain("(settlement - 'paidInMonth') - 'paySlipId'")
  })

  it('un bulletin déjà payé bloque le renvoi (409, ROLLBACK, rien supprimé)', async () => {
    db.slips[1] = { ...db.slips[1]!, payment_status: 'paid', paid_at: new Date().toISOString() }
    const res = await call('POST', '/reject', 'u-paie', { reason: 'Prime de transport erronée sur 3 bulletins' })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('déjà payés')
    expect(db.log).toContain('ROLLBACK')
    expect(db.log.some(l => l.startsWith('delete:slips'))).toBe(false)
  })

  it('un paiement Mobile Money engagé bloque aussi le renvoi', async () => {
    db.slips[0] = { ...db.slips[0]!, has_payment: true }
    expect((await call('POST', '/reject', 'u-paie', { reason: 'Prime de transport erronée sur 3 bulletins' })).statusCode).toBe(409)
  })

  it('non désigné avant l’échéance → 403 ; après l’échéance → autorisé (escalade)', async () => {
    expect((await call('POST', '/reject', 'u-admin', { reason: 'Prime de transport erronée' })).statusCode).toBe(403)
    db.period = pendingPeriod(3)
    expect((await call('POST', '/reject', 'u-admin', { reason: 'Prime de transport erronée' })).statusCode).toBe(200)
  })
})

describe('POST /cancel — annulation de l’initiation', () => {
  it('l’initiateur annule tant qu’aucun niveau n’a validé (bulletins défaits)', async () => {
    const res = await call('POST', '/cancel', 'u-init', {})
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data).toMatchObject({ status: 'open', deletedPaySlips: 2 })
    expect(db.log).toContain('audit:payroll.initiation_cancelled')
    expect(db.log).toContain('period:open:null')
  })

  it('impossible après une première validation (409)', async () => {
    db.approvals = [{ level: 1, approver_id: 'u-paie', approver_role: 'hr_officer', approved_at: new Date().toISOString(), notes: null }]
    const res = await call('POST', '/cancel', 'u-init', {})
    expect(res.statusCode).toBe(409)
    expect(db.log).not.toContain('BEGIN')
  })

  it('réservé à l’initiateur (403 pour un autre admin)', async () => {
    expect((await call('POST', '/cancel', 'u-admin', {})).statusCode).toBe(403)
  })

  it('RBAC : un salarié / readonly n’accède pas au circuit (403)', async () => {
    expect((await call('POST', '/cancel', 'u-x', {}, 'employee')).statusCode).toBe(403)
    expect((await call('POST', '/approve', 'u-x', {}, 'readonly')).statusCode).toBe(403)
    expect((await call('POST', '/reject', 'u-x', { reason: 'Motif suffisamment long' }, 'manager')).statusCode).toBe(403)
  })
})

describe('Période clôturée : immuable', () => {
  it.each(['/approve', '/reject', '/cancel'])('%s → 409', async (path) => {
    db.period = { ...pendingPeriod(), status: 'closed' }
    const res = await call('POST', path, path === '/cancel' ? 'u-init' : 'u-paie', path === '/reject' ? { reason: 'Motif suffisamment long' } : {})
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toContain('immuable')
    expect(db.log.some(l => l.startsWith('delete:'))).toBe(false)
  })

  it('période introuvable → 404', async () => {
    db.period = null
    expect((await call('POST', '/approve', 'u-paie', {})).statusCode).toBe(404)
  })
})

describe('Historique des périodes — valideur attendu', () => {
  it('GET /payroll/periods expose pending_with (nom + fonction + échéance)', async () => {
    const res = await app.inject({ method: 'GET', url: '/payroll/periods', headers: { authorization: `Bearer ${token('u-admin', 'admin')}` } })
    expect(res.statusCode).toBe(200)
    const row = JSON.parse(res.body).data[0]
    expect(row.pending_with).toMatchObject({ level: 1, requiredLevels: 2, name: 'Yao Brou', functionLabel: 'Chef de service paie' })
  })
})

describe('Clôture — message de période en validation', () => {
  function routeClose() {
    queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const q = String(sql)
      if (q.includes('platform.tenants')) return { rows: [{ id: 't1', has_subsidiaries: false, at_rate: '0.02', default_country_code: 'CI' }] }
      if (q.includes('.workflow_configs')) return { rows: [{ levels_count: db.levels, config: { validators: db.validators } }] }
      if (q.includes('.users')) return { rows: USERS.filter(u => ((params?.[0] as string[]) ?? []).includes(u.id)) }
      if (q.includes('.pay_periods') && /^\s*INSERT/i.test(q)) return { rows: [{ id: PERIOD_ID }] }
      return { rows: [] }
    })
  }

  it('nomme le valideur attendu, sans chemin d’API ni jargon', async () => {
    routeClose()
    const res = await app.inject({ method: 'POST', url: `/payroll/periods/${MONTH}/close`, headers: { authorization: `Bearer ${token('u-init', 'hr_manager')}` }, payload: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.message).toContain('Période 2026-10 en attente de validation par Yao Brou (Chef de service paie)')
    expect(body.message).not.toMatch(/POST|\/payroll|admin\/hr_manager/)
    expect(body.pendingWith).toMatchObject({ level: 1, name: 'Yao Brou' })
  })

  it('sans désignation : « par un administrateur ou responsable RH autre que l’initiateur »', async () => {
    db.validators = []
    routeClose()
    const res = await app.inject({ method: 'POST', url: `/payroll/periods/${MONTH}/close`, headers: { authorization: `Bearer ${token('u-init', 'hr_manager')}` }, payload: {} })
    expect(JSON.parse(res.body).message).toContain('Période 2026-10 en attente de validation par un administrateur ou responsable RH autre que l\'initiateur')
  })
})
