import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock, sendMailMock, loadMailMock, ensureSchemaMock } = vi.hoisted(() => ({
  queryMock: vi.fn(), sendMailMock: vi.fn(), loadMailMock: vi.fn(), ensureSchemaMock: vi.fn(),
}))
vi.mock('../config.js', () => ({ config: { appUrl: 'https://rh.example.ci', smtp: { user: '' } } }))
vi.mock('../db/pool.js', () => ({ pool: { query: queryMock, connect: vi.fn() } }))
vi.mock('./email.js', () => ({ sendPayrollValidationEmail: sendMailMock }))
vi.mock('./tenant-mail.service.js', () => ({ loadTenantMailBySchema: loadMailMock }))
vi.mock('../utils/schema-migrations.js', () => ({ ensureTenantSchema: ensureSchemaMock }))

import {
  alertPayrollValidators, eligibleValidators, formatPayrollMonth, notifyPayrollValidators, reminderDue,
  runPayrollValidationReminders, sweepTenantPayrollReminders, type ValidatorCandidate,
} from './payroll-validation-alerts.service.js'
import { parsePayrollCircuit, payrollLevelState, type PayrollUser } from './payroll-validation.service.js'

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = new Date('2026-10-25T10:00:00Z')

const cand = (id: string, role: string, extra: Partial<ValidatorCandidate> = {}): ValidatorCandidate => ({
  id, role, isActive: true, email: `${id}@sotra.ci`, firstName: id, lastName: 'X', ...extra,
})
const TEAM = [cand('u-init', 'hr_manager'), cand('u-admin', 'admin'), cand('u-drh', 'hr_manager'), cand('u-off', 'hr_officer')]

function stateFor(opts: {
  validators?: Array<{ userId: string | null; slaDays?: number }>; levels?: number
  approvals?: Array<{ level: number; approver_id: string; approved_at: Date }>; agoDays?: number
  users?: Map<string, PayrollUser>
}) {
  const circuit = parsePayrollCircuit(opts.levels ?? 2, { validators: opts.validators ?? [] })
  const period = { id: 'p1', status: 'pending_validation', initiated_by: 'u-init', initiated_at: new Date(NOW.getTime() - (opts.agoDays ?? 0.1) * DAY) }
  return payrollLevelState(circuit, period, opts.approvals ?? [], opts.users ?? new Map(), NOW)!
}

/** Routage du faux pool par texte SQL (pas de mocks séquentiels fragiles). */
function routeQueries(routes: { users?: ValidatorCandidate[]; periods?: unknown[]; claim?: () => unknown[]; tenants?: unknown[] }) {
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM platform.tenants')) return Promise.resolve({ rows: routes.tenants ?? [] })
    if (sql.includes('workflow_configs')) return Promise.resolve({ rows: [{ levels_count: 2, config: {} }] })
    if (sql.includes('pay_period_approvals')) return Promise.resolve({ rows: [] })
    if (sql.includes('FROM "tenant_sotra".pay_periods')) return Promise.resolve({ rows: routes.periods ?? [] })
    if (sql.includes('INSERT INTO "tenant_sotra".pay_period_reminders')) return Promise.resolve({ rows: routes.claim?.() ?? [] })
    if (sql.includes('role = ANY')) {
      return Promise.resolve({ rows: (routes.users ?? []).map(u => ({
        id: u.id, role: u.role, is_active: u.isActive, email: u.email, first_name: u.firstName, last_name: u.lastName,
      })) })
    }
    return Promise.resolve({ rows: [], rowCount: 1 })
  })
}

const notificationInserts = () => queryMock.mock.calls
  .filter(c => String(c[0]).includes('.notifications'))
  .map(c => (c[1] as unknown[])[0])

beforeEach(() => {
  queryMock.mockReset()
  sendMailMock.mockReset().mockResolvedValue(undefined)
  loadMailMock.mockReset().mockResolvedValue({ name: 'SOTRA', primaryColor: '#E85D04', from: 'paie@sotra.ci', smtp: { host: 'smtp.sotra.ci', port: 587, secure: false } })
  ensureSchemaMock.mockReset().mockResolvedValue(undefined)
})

describe('eligibleValidators — mêmes règles SoD que decidePayrollActor', () => {
  it('sans désignation : équipe RH (admin / hr_manager) hors initiateur, jamais hr_officer', () => {
    const ids = eligibleValidators(stateFor({}), TEAM).map(c => c.id)
    expect(ids).toEqual(['u-admin', 'u-drh'])
  })

  it('exclut les approbateurs des niveaux précédents et les comptes inactifs', () => {
    const s = stateFor({ approvals: [{ level: 1, approver_id: 'u-admin', approved_at: new Date(NOW.getTime() - HOUR) }] })
    expect(eligibleValidators(s, [...TEAM, cand('u-off2', 'admin', { isActive: false })]).map(c => c.id)).toEqual(['u-drh'])
  })

  it('valideur désigné disponible : lui seul, puis l\'équipe une fois l\'échéance dépassée', () => {
    const users = new Map<string, PayrollUser>([['u-off', { id: 'u-off', firstName: 'Yao', lastName: 'Brou', role: 'hr_officer', isActive: true }]])
    const fresh = stateFor({ validators: [{ userId: 'u-off', slaDays: 2 }], users, agoDays: 0.5 })
    expect(eligibleValidators(fresh, TEAM).map(c => c.id)).toEqual(['u-off'])
    const late = stateFor({ validators: [{ userId: 'u-off', slaDays: 2 }], users, agoDays: 3 })
    expect(eligibleValidators(late, TEAM).map(c => c.id).sort()).toEqual(['u-admin', 'u-drh', 'u-off'])
  })

  it('désigné = initiateur (indisponible) : le niveau s\'ouvre à l\'équipe hors initiateur', () => {
    const users = new Map<string, PayrollUser>([['u-init', { id: 'u-init', firstName: 'A', lastName: 'K', role: 'hr_manager', isActive: true }]])
    const s = stateFor({ validators: [{ userId: 'u-init' }], users })
    expect(eligibleValidators(s, TEAM).map(c => c.id)).toEqual(['u-admin', 'u-drh'])
  })
})

describe('alertPayrollValidators', () => {
  it('notifie in-app ET par email chaque valideur éligible, via le SMTP du tenant', async () => {
    routeQueries({ users: TEAM })
    const res = await alertPayrollValidators({ schema: 'tenant_sotra', periodId: 'p1', month: '2026-10', scope: 'multi_sites', kind: 'requested', state: stateFor({}) })
    await new Promise(r => setTimeout(r, 0))
    expect(res).toEqual({ recipients: 2, emailed: 2, emailFailed: 0 })
    expect(notificationInserts().sort()).toEqual(['u-admin', 'u-drh'])
    expect(sendMailMock).toHaveBeenCalledTimes(2)
    const arg = sendMailMock.mock.calls[0]![0] as Record<string, unknown>
    expect(arg).toMatchObject({ level: 1, requiredLevels: 2, kind: 'requested', multiSites: true, monthLabel: 'octobre 2026' })
    expect(String(arg.actionUrl)).toMatch(/\/payroll\/multi-filiales$/)
    expect(arg.smtp).toMatchObject({ host: 'smtp.sotra.ci' })
    // Aucune donnée salariale nominative dans l'email
    expect(Object.keys(arg).some(k => /net|gross|salaire|brut/i.test(k))).toBe(false)
  })

  it('un échec SMTP est compté sans jamais lever (non bloquant)', async () => {
    routeQueries({ users: TEAM })
    sendMailMock.mockRejectedValueOnce(new Error('SMTP down'))
    const res = await alertPayrollValidators({ schema: 'tenant_sotra', periodId: 'p1', month: '2026-10', scope: 'mono', kind: 'requested', state: stateFor({}) })
    expect(res).toEqual({ recipients: 2, emailed: 1, emailFailed: 1 })
    expect(String((sendMailMock.mock.calls[0]![0] as Record<string, unknown>).actionUrl)).toMatch(/\/payroll$/)
  })

  it('base indisponible : aucune exception, aucune alerte', async () => {
    queryMock.mockRejectedValue(new Error('db down'))
    await expect(alertPayrollValidators({ schema: 'tenant_sotra', periodId: 'p1', month: '2026-10', scope: 'mono', kind: 'requested', state: stateFor({}) }))
      .resolves.toEqual({ recipients: 0, emailed: 0, emailFailed: 0 })
    expect(() => notifyPayrollValidators({ schema: 'tenant_sotra', periodId: 'p1', month: '2026-10', scope: 'mono', kind: 'requested', state: stateFor({}) })).not.toThrow()
  })
})

describe('relance avant échéance', () => {
  it('reminderDue : < 24 h ou dépassée', () => {
    expect(reminderDue(stateFor({ agoDays: 0.1 }), NOW)).toBe(false) // échéance dans ~45 h
    expect(reminderDue(stateFor({ agoDays: 1.5 }), NOW)).toBe(true)  // ~12 h restantes
    expect(reminderDue(stateFor({ agoDays: 5 }), NOW)).toBe(true)    // dépassée
    expect(reminderDue(null, NOW)).toBe(false)
  })

  it('relance une seule fois par niveau / fenêtre (réservation idempotente)', async () => {
    const claimed = new Set<string>()
    let lastKey = ''
    routeQueries({
      users: TEAM,
      periods: [{ id: 'p1', month: '2026-10', status: 'pending_validation', initiated_by: 'u-init', initiated_at: new Date(NOW.getTime() - 1.5 * DAY) }],
      claim: () => {
        if (claimed.has(lastKey)) return []
        claimed.add(lastKey); return [{ id: 'r1' }]
      },
    })
    const base = queryMock.getMockImplementation()!
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('pay_period_reminders') && sql.includes('INSERT')) lastKey = JSON.stringify(params)
      return base(sql, params)
    })
    expect(await sweepTenantPayrollReminders('tenant_sotra', NOW)).toBe(1)
    expect(sendMailMock).toHaveBeenCalledTimes(2)
    expect((sendMailMock.mock.calls[0]![0] as Record<string, unknown>).kind).toBe('reminder')
    // Deuxième balayage (même fenêtre) : rien n'est renvoyé
    expect(await sweepTenantPayrollReminders('tenant_sotra', new Date(NOW.getTime() + HOUR))).toBe(0)
    expect(sendMailMock).toHaveBeenCalledTimes(2)
  })

  it('échéance lointaine : pas de relance ; multi-filiales projetée en attente', async () => {
    routeQueries({
      users: TEAM,
      periods: [
        { id: 'p1', month: '2026-10', status: 'pending_validation', initiated_by: 'u-init', initiated_at: new Date(NOW.getTime() - HOUR) },
        { id: 'p2', month: '2026-09', status: 'validated_central', initiated_by: null, initiated_at: null, validated_by: 'u-init', validated_central_at: new Date(NOW.getTime() - 3 * DAY) },
      ],
      claim: () => [{ id: 'r2' }],
    })
    expect(await sweepTenantPayrollReminders('tenant_sotra', NOW)).toBe(1)
    const arg = sendMailMock.mock.calls[0]![0] as Record<string, unknown>
    expect(arg).toMatchObject({ multiSites: true, overdue: true, kind: 'reminder' })
  })

  it('balayage multi-tenants : une panne de tenant n\'arrête pas les autres', async () => {
    routeQueries({ tenants: [{ schema_name: 'tenant_sotra' }, { schema_name: 'Bad-Schema' }, { schema_name: 'tenant_ko' }] })
    ensureSchemaMock.mockImplementation((s: string) => s === 'tenant_ko' ? Promise.reject(new Error('ko')) : Promise.resolve())
    const log = { error: vi.fn() }
    const res = await runPayrollValidationReminders(NOW, log)
    expect(res).toEqual({ tenants: 1, reminders: 0, failedTenants: 1 })
    expect(ensureSchemaMock).not.toHaveBeenCalledWith('Bad-Schema')
    expect(log.error).toHaveBeenCalledTimes(1)
  })
})

describe('formatPayrollMonth', () => {
  it('mois en toutes lettres', () => {
    expect(formatPayrollMonth('2026-01')).toBe('janvier 2026')
    expect(formatPayrollMonth('n/a')).toBe('n/a')
  })
})
