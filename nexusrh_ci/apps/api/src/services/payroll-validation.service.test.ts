import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }))

import {
  decidePayrollActor, parsePayrollCircuit, payrollLevelState, pendingValidationMessage, revertPeriodPayslips,
  type PayrollUser,
} from './payroll-validation.service.js'

const DAY = 86_400_000
const NOW = new Date('2026-10-25T10:00:00Z')
const users = new Map<string, PayrollUser>([
  ['u-paie', { id: 'u-paie', firstName: 'Yao', lastName: 'Brou', role: 'hr_officer', isActive: true }],
  ['u-init', { id: 'u-init', firstName: 'Awa', lastName: 'Koné', role: 'hr_manager', isActive: true }],
])
const period = (ago = 0.5) => ({ id: 'p', status: 'pending_validation', initiated_by: 'u-init', initiated_at: new Date(NOW.getTime() - ago * DAY) })

describe('parsePayrollCircuit', () => {
  it('défauts : 2 niveaux, aucun valideur, SLA 2 jours', () => {
    expect(parsePayrollCircuit(undefined, null)).toEqual({
      levels: 2,
      steps: [
        { level: 1, userId: null, functionLabel: null, slaDays: 2 },
        { level: 2, userId: null, functionLabel: null, slaDays: 2 },
      ],
    })
  })

  it('borne niveaux et SLA, tronque/nettoie les libellés', () => {
    const c = parsePayrollCircuit(99, { validators: [{ userId: 'u-paie', functionLabel: '  DRH  ', slaDays: 90 }] })
    expect(c.levels).toBe(10)
    expect(c.steps[0]).toEqual({ level: 1, userId: 'u-paie', functionLabel: 'DRH', slaDays: 30 })
    expect(c.steps[1]!.userId).toBeNull()
  })
})

describe('payrollLevelState / decidePayrollActor', () => {
  const circuit = parsePayrollCircuit(1, { validators: [{ userId: 'u-paie', functionLabel: 'Chef de service paie', slaDays: 2 }] })

  it('échéance = initiation + SLA ; dépassée → équipe RH', () => {
    const fresh = payrollLevelState(circuit, period(0.5), [], users, NOW)!
    expect(fresh.dueAt).toBe(new Date(NOW.getTime() + 1.5 * DAY).toISOString())
    expect(fresh.teamCanAct).toBe(false)
    expect(decidePayrollActor(fresh, { userId: 'u-x', role: 'admin' })).toEqual({ allowed: false, reason: 'awaiting_designated' })
    const late = payrollLevelState(circuit, period(3), [], users, NOW)!
    expect(decidePayrollActor(late, { userId: 'u-x', role: 'admin' })).toEqual({ allowed: true, escalated: true })
    expect(decidePayrollActor(late, { userId: 'u-x', role: 'hr_officer' })).toEqual({ allowed: false, reason: 'awaiting_designated' })
    expect(decidePayrollActor(late, { userId: 'u-x', role: 'manager' })).toEqual({ allowed: false, reason: 'role' })
  })

  it('période non en validation ou complète → null', () => {
    expect(payrollLevelState(circuit, { ...period(), status: 'closed' }, [], users, NOW)).toBeNull()
    expect(payrollLevelState(circuit, period(), [{ level: 1, approver_id: 'u-paie', approved_at: NOW }], users, NOW)).toBeNull()
  })

  it('message sans désignation', () => {
    expect(pendingValidationMessage('2026-10', null))
      .toBe('Période 2026-10 en attente de validation par un administrateur ou responsable RH autre que l\'initiateur')
  })
})

describe('revertPeriodPayslips', () => {
  it('aucun bulletin : rien à défaire', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await expect(revertPeriodPayslips(db as never, 'tenant_x', 'p')).resolves.toEqual({ ok: true, deletedPaySlips: 0, restoredExpenses: 0, restoredSettlements: 0 })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('bulletin non « généré » (ex. validé / payé) : verrouillé', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 's', status: 'paid', payment_status: 'pending', paid_at: null, has_payment: false }] }) }
    await expect(revertPeriodPayslips(db as never, 'tenant_x', 'p')).resolves.toEqual({ ok: false, lockedPaySlips: 1 })
  })
})
