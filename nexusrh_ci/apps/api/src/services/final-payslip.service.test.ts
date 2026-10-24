import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 } },
}))

import {
  employmentWindow, loadPayrollPopulation, markSettlementPaid, previousMonth,
  resolveEmployeeMonth, settlementEarningsFrom, workedDaysFor,
} from './final-payslip.service.js'
import { calculatePayrollCI } from './payroll-engine-ci.js'
import { CIV_2024 } from './legislation-packs.js'

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

// Octobre 2026 : 31 jours, 4 dimanches (4, 11, 18, 25) → 27 jours ouvrables
describe('fenêtre d’emploi du mois', () => {
  it('mois complet sans entrée ni sortie', () => {
    const w = employmentWindow('2026-10', '2019-04-01', null)
    expect(w).toMatchObject({ contractDays: 27, workingDaysMonth: 27, hiredInMonth: false, leavesInMonth: false, exitsThisMonth: false })
  })
  it('sortie le 15 : jours ouvrables du 1er au 15 (13 j)', () => {
    const w = employmentWindow('2026-10', '2019-04-01', '2026-10-15')
    expect(w).toMatchObject({ start: '2026-10-01', end: '2026-10-15', contractDays: 13, leavesInMonth: true, exitsThisMonth: true })
  })
  it('sortie le dernier jour : mois complet mais bulletin de solde', () => {
    const w = employmentWindow('2026-10', '2019-04-01', '2026-10-31')
    expect(w).toMatchObject({ contractDays: 27, leavesInMonth: false, exitsThisMonth: true, settlementOnly: false })
  })
  it('embauche le 20 : du 20 au 31 (11 j)', () => {
    const w = employmentWindow('2026-10', '2026-10-20', null)
    expect(w).toMatchObject({ start: '2026-10-20', contractDays: 11, hiredInMonth: true })
  })
  it('entrée et sortie dans le même mois', () => {
    expect(employmentWindow('2026-10', '2026-10-05', '2026-10-10').contractDays).toBe(6)
  })
  it('sorti le mois précédent : aucun jour, solde seul', () => {
    const w = employmentWindow('2026-10', '2019-04-01', '2026-09-30')
    expect(w).toMatchObject({ contractDays: 0, settlementOnly: true, exitsThisMonth: false })
  })
  it('accepte les dates JS renvoyées par pg', () => {
    expect(employmentWindow('2026-10', new Date(2026, 9, 20), null).contractDays).toBe(11)
  })
  it('jours rémunérés = jours sous contrat − absences, jamais négatifs', () => {
    const w = employmentWindow('2026-10', '2019-04-01', '2026-10-15')
    expect(workedDaysFor(w, 3)).toBe(10)
    expect(workedDaysFor(w, 40)).toBe(0)
    expect(workedDaysFor(w, undefined)).toBe(13)
  })
  it('mois précédent', () => {
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(previousMonth('2026-10')).toBe('2026-09')
  })
})

describe('indemnités du solde de tout compte', () => {
  const settlement = {
    indemniteConges: 82_500, indemnitePreavis: 0, indemniteLicenciement: 240_000,
    lines: [{ key: 'licenciement', label: 'Indemnité de départ à la retraite', amount: 240_000 }],
  }
  it('ignore les montants nuls et reprend le libellé du solde', () => {
    expect(settlementEarningsFrom(settlement, '2026-10')).toEqual([
      { key: 'conges', label: 'Indemnité compensatrice de congés', amount: 82_500 },
      { key: 'licenciement', label: 'Indemnité de départ à la retraite', amount: 240_000 },
    ])
  })
  it('un solde déjà payé sur un autre mois ne produit rien', () => {
    expect(settlementEarningsFrom({ ...settlement, paidInMonth: '2026-09' }, '2026-10')).toEqual([])
    // recalcul du même mois (période rejetée puis reclôturée) : toujours porté
    expect(settlementEarningsFrom({ ...settlement, paidInMonth: '2026-10' }, '2026-10')).toHaveLength(2)
  })
  it('aucun solde → aucune ligne', () => {
    expect(settlementEarningsFrom(null, '2026-10')).toEqual([])
    expect(settlementEarningsFrom('x', '2026-10')).toEqual([])
  })
})

describe('bulletin de solde — moteur', () => {
  const base = {
    baseSalary: 300_000, workingDaysMonth: 27, atRate: 0.02,
    maritalStatus: 'single', childrenCount: 0, variableElements: {}, legislationPack: CIV_2024,
  }
  it('congés soumis CNPS + ITS ; indemnité de licenciement exonérée', () => {
    const ref = calculatePayrollCI({ ...base, workedDays: 13 })
    const r = calculatePayrollCI({
      ...base, workedDays: 13,
      settlementEarnings: [
        { key: 'conges', label: 'Indemnité compensatrice de congés', amount: 82_500 },
        { key: 'licenciement', label: 'Indemnité de licenciement', amount: 240_000 },
      ],
    })
    expect(r.brutProrata).toBe(Math.floor(300_000 * 13 / 27))
    expect(r.grossSalary).toBe(ref.grossSalary + 82_500 + 240_000)
    expect(r.settlementTotal).toBe(322_500)
    expect(r.lines.find(l => l.code === '1610')?.amount).toBe(82_500)
    expect(r.lines.find(l => l.code === '1630')?.amount).toBe(240_000)
    // assiette CNPS retraite = prorata + congés (licenciement exclu)
    expect(r.lines.find(l => l.code === '2000')?.base).toBe(r.brutProrata + 82_500)
    // base imposable : seules les congés s'ajoutent
    const withCongesOnly = calculatePayrollCI({
      ...base, workedDays: 13,
      settlementEarnings: [{ key: 'conges', label: 'c', amount: 82_500 }],
    })
    expect(r.baseImposable).toBe(withCongesOnly.baseImposable)
    expect(r.its).toBeGreaterThan(ref.its)
  })
  it('traitement paramétrable par le pack', () => {
    const pack = { ...CIV_2024, settlementTreatment: {
      conges: { social: true, tax: true }, preavis: { social: true, tax: true },
      licenciement: { social: true, tax: true },
    } }
    const r = calculatePayrollCI({
      ...base, legislationPack: pack, workedDays: 0,
      settlementEarnings: [{ key: 'licenciement', label: 'l', amount: 100_000 }],
    })
    expect(r.lines.find(l => l.code === '2000')?.base).toBe(100_000)
    expect(r.baseImposable).toBeGreaterThan(0)
  })
  it('sans solde : bulletin inchangé', () => {
    const a = calculatePayrollCI({ ...base, workedDays: 27 })
    const b = calculatePayrollCI({ ...base, workedDays: 27, settlementEarnings: [] })
    expect(b).toEqual(a)
    expect(a.settlementTotal).toBeUndefined()
  })
})

describe('accès base', () => {
  it('population : actifs + sortants du mois + rattrapage du solde du mois précédent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'e1' }] })
    const rows = await loadPayrollPopulation('tenant_x', '2026-10', { legalEntityId: 'le1' })
    expect(rows).toEqual([{ id: 'e1' }])
    const [sql, params] = queryMock.mock.calls[0]!
    expect(String(sql)).toContain('offboarding_cases')
    expect(String(sql)).toContain("o.status <> 'cancelled'")
    // dossier ouvert à date dépassée : pas une sortie avérée
    expect(String(sql)).toContain("o.status IN ('settled', 'closed') OR o.departure_date >= $1")
    expect(String(sql)).toContain('e.legal_entity_id = $5')
    expect(params).toEqual(['2026-10-01', '2026-10-31', '2026-09-01', '2026-10', 'le1'])
  })
  it('population : repli sans table offboarding_cases', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation does not exist'))
      .mockResolvedValueOnce({ rows: [{ id: 'e2' }] })
    const rows = await loadPayrollPopulation('tenant_x', '2026-10', { employeeId: 'e2' })
    expect(rows).toEqual([{ id: 'e2' }])
    const [sql, params] = queryMock.mock.calls[1]!
    expect(String(sql)).not.toContain('offboarding_cases')
    expect(params).toEqual(['2026-10-01', '2026-10-31', 'e2'])
  })
  it('marque le solde payé', async () => {
    await markSettlementPaid('tenant_x', 'o1', '2026-10', 'ps1')
    const [sql, params] = queryMock.mock.calls[0]!
    expect(String(sql)).toContain("jsonb_build_object('paidInMonth'")
    expect(params).toEqual(['o1', '2026-10', 'ps1'])
  })
  it('solde seul : ni absences ni pointage interrogés', async () => {
    const m = await resolveEmployeeMonth('tenant_x', {
      id: 'e1', base_salary: '300000', hire_date: '2019-04-01', exit_date: '2026-09-30',
      settlement: { indemniteConges: 50_000 },
    }, '2026-10', { enabled: true } as never)
    expect(m.workedDays).toBe(0)
    expect(m.settlementEarnings).toHaveLength(1)
    expect(queryMock).not.toHaveBeenCalled()
  })
  it('sortie en cours de mois : pointage borné aux jours sous contrat', async () => {
    const m = await resolveEmployeeMonth('tenant_x', {
      id: 'e1', base_salary: '300000', hire_date: '2019-04-01', exit_date: '2026-10-15', settlement: null,
    }, '2026-10', { enabled: true, absences: { enabled: false }, lateness: { enabled: false } } as never)
    expect(m.workedDays).toBe(13)
    const att = queryMock.mock.calls.find(c => String(c[0]).includes('attendance_days'))
    expect(att?.[1]).toEqual(['e1', '2026-10-01', '2026-10-15'])
  })
})
