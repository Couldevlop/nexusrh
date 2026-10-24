import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryMock = vi.fn()
vi.mock('../db/pool.js', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }))

import {
  computeAttendanceDeductions,
  parseAttendancePayrollSettings,
  loadAttendancePayrollSettings,
  loadEffectiveAttendancePayrollSettings,
  loadAttendanceMonth,
  resolveAttendanceForPayroll,
  DEFAULT_ATTENDANCE_PAYROLL_SETTINGS,
  type AttendancePayrollSettings,
} from './attendance-payroll.service.js'
import { calculatePayrollCI, type PayrollContext } from './payroll-engine-ci.js'
import { invalidateModulesCache } from './tenant-modules.service.js'

const ON: AttendancePayrollSettings = { ...DEFAULT_ATTENDANCE_PAYROLL_SETTINGS, enabled: true }

beforeEach(() => {
  queryMock.mockReset()
  invalidateModulesCache()
})

describe('parseAttendancePayrollSettings', () => {
  it('rien / corrompu → défauts, désactivé', () => {
    expect(parseAttendancePayrollSettings(undefined)).toEqual(DEFAULT_ATTENDANCE_PAYROLL_SETTINGS)
    expect(parseAttendancePayrollSettings('x')).toEqual(DEFAULT_ATTENDANCE_PAYROLL_SETTINGS)
    expect(parseAttendancePayrollSettings([])).toEqual(DEFAULT_ATTENDANCE_PAYROLL_SETTINGS)
    expect(parseAttendancePayrollSettings({}).enabled).toBe(false)
  })
  it('garde les clés valides, ignore les invalides', () => {
    const s = parseAttendancePayrollSettings({ enabled: true, monthlyHours: -5, absenceDivisor: 'calendar_30', foo: 1 })
    expect(s.enabled).toBe(true)
    expect(s.absenceDivisor).toBe('calendar_30')
    expect(s.monthlyHours).toBe(173.33)
    expect(s).not.toHaveProperty('foo')
  })
})

describe('computeAttendanceDeductions', () => {
  const data = (unjustifiedDays: number, lateMinutesByDay: number[] = []) => ({ unjustifiedDays, lateMinutesByDay })

  it('désactivé → aucune retenue', () => {
    expect(computeAttendanceDeductions(DEFAULT_ATTENDANCE_PAYROLL_SETTINGS, data(3, [60]), 260000, 26)).toBeNull()
  })
  it('aucun écart pointé → aucune retenue', () => {
    expect(computeAttendanceDeductions(ON, data(0, []), 260000, 26)).toBeNull()
  })
  it('absences injustifiées au prorata des jours ouvrables', () => {
    const r = computeAttendanceDeductions(ON, data(2), 260000, 26)!
    expect(r.deductions.absenceAmount).toBe(20000)
    expect(r.deductions.absenceDays).toBe(2)
    expect(r.deductions.latenessAmount).toBe(0)
  })
  it('diviseur 30 jours', () => {
    const r = computeAttendanceDeductions({ ...ON, absenceDivisor: 'calendar_30' }, data(3), 300000, 26)!
    expect(r.deductions.absenceAmount).toBe(30000)
  })
  it('retenue absences désactivable', () => {
    expect(computeAttendanceDeductions({ ...ON, deductUnjustifiedAbsences: false }, data(3), 300000, 26)).toBeNull()
  })
  it('retards non retenus par défaut', () => {
    expect(computeAttendanceDeductions(ON, data(0, [45, 30]), 300000, 26)).toBeNull()
  })
  it('retards : seuil par occurrence, franchise mensuelle, arrondi au quart d heure inférieur', () => {
    const s = { ...ON, deductLateness: true, latenessMinPerOccurrenceMin: 15,
      latenessMonthlyAllowanceMin: 20, latenessRounding: 'quarter_hour_down' as const, monthlyHours: 200 }
    // 10 min ignorées (< 15), 50 + 40 = 90 − 20 de franchise = 70 → 60 min
    const r = computeAttendanceDeductions(s, data(0, [10, 50, 40]), 240000, 26)!
    expect(r.summary.lateMinutesRaw).toBe(100)
    expect(r.deductions.lateMinutes).toBe(60)
    // taux horaire 240000 / 200 = 1200 → 60 min = 1200
    expect(r.deductions.latenessAmount).toBe(1200)
  })
  it('plafond en % du salaire de base', () => {
    const r = computeAttendanceDeductions({ ...ON, maxPercentOfBase: 10 }, data(10), 260000, 26)!
    expect(r.deductions.absenceAmount).toBe(26000)
    expect(r.summary.capped).toBe(true)
  })
  it('suspension des primes de présence seulement si paramétrée', () => {
    expect(computeAttendanceDeductions(ON, data(1), 260000, 26)!.deductions.suspendAttendanceBonus).toBe(false)
    expect(computeAttendanceDeductions({ ...ON, suspendAttendanceBonusOnUnjustified: true }, data(1), 260000, 26)!
      .deductions.suspendAttendanceBonus).toBe(true)
  })
  it('jamais plus de jours que les jours ouvrables', () => {
    const r = computeAttendanceDeductions(ON, data(40), 260000, 26)!
    expect(r.deductions.absenceDays).toBe(26)
    expect(r.deductions.absenceAmount).toBe(260000)
  })
})

describe('lectures tolérantes (pas de badgeuse = pas d erreur)', () => {
  it('table/colonne absente → désactivé', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation "attendance_config" does not exist'))
    expect((await loadAttendancePayrollSettings('tenant_x')).enabled).toBe(false)
  })
  it('aucune ligne de config → aucune requête de module, null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await loadEffectiveAttendancePayrollSettings('tenant_x')).toBeNull()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
  it('activé mais module pointage fermé → null', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ payroll_link: { enabled: true } }] })
      .mockResolvedValueOnce({ rows: [{ enabled_modules: { attendance: false } }] })
    expect(await loadEffectiveAttendancePayrollSettings('tenant_x')).toBeNull()
  })
  it('activé et module ouvert → paramétrage', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ payroll_link: { enabled: true, deductLateness: true } }] })
      .mockResolvedValueOnce({ rows: [{ enabled_modules: { attendance: true } }] })
    const s = await loadEffectiveAttendancePayrollSettings('tenant_x')
    expect(s?.enabled).toBe(true)
    expect(s?.deductLateness).toBe(true)
  })
  it('pointages illisibles → aucune donnée', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'))
    expect(await loadAttendanceMonth('tenant_x', 'e1', '2026-10')).toEqual({ unjustifiedDays: 0, lateMinutesByDay: [] })
  })
  it('agrège absences et retards du mois', async () => {
    queryMock.mockResolvedValueOnce({ rows: [
      { status: 'absent_unjustified', late_minutes: 0 },
      { status: 'late', late_minutes: 25 },
      { status: 'late', late_minutes: '5' },
    ] })
    expect(await loadAttendanceMonth('tenant_x', 'e1', '2026-10')).toEqual({ unjustifiedDays: 1, lateMinutesByDay: [25, 5] })
    const [, params] = queryMock.mock.calls[0]!
    expect(params).toEqual(['e1', '2026-10-01', '2026-10-31'])
  })
  it('paramétrage null → aucune requête', async () => {
    expect(await resolveAttendanceForPayroll(null, 'tenant_x', 'e1', '2026-10', 300000, 26)).toBeNull()
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('moteur de paie — retenues pointage', () => {
  const ctx: PayrollContext = {
    baseSalary: 260000, workedDays: 26, workingDaysMonth: 26, atRate: 0.02,
    maritalStatus: 'single', childrenCount: 0,
    variableElements: { PRIME_TRANSPORT: 30000 },
  }

  it('sans retenue : bulletin identique', () => {
    const a = calculatePayrollCI(ctx)
    const b = calculatePayrollCI({ ...ctx, attendanceDeductions: undefined })
    expect(b).toEqual(a)
    expect(a.lines.find((l) => l.code === '1010')).toBeUndefined()
  })

  it('lignes 1010/1020 négatives, bases CNPS/ITS réduites', () => {
    const base = calculatePayrollCI(ctx)
    const r = calculatePayrollCI({ ...ctx, attendanceDeductions: {
      absenceDays: 2, absenceAmount: 20000, lateMinutes: 60, latenessAmount: 1500, suspendAttendanceBonus: false,
    } })
    expect(r.lines.find((l) => l.code === '1000')!.amount).toBe(260000)
    expect(r.lines.find((l) => l.code === '1010')).toMatchObject({ amount: -20000, label: expect.stringContaining('2 j') })
    expect(r.lines.find((l) => l.code === '1020')).toMatchObject({ amount: -1500, label: expect.stringContaining('60 min') })
    expect(r.brutProrata).toBe(238500)
    expect(r.grossSalary).toBe(base.grossSalary - 21500)
    expect(r.cnpsRetraiteSal).toBeLessThan(base.cnpsRetraiteSal)
    expect(r.netPayable).toBeLessThan(base.netPayable)
  })

  it('suspension de la prime de transport', () => {
    const r = calculatePayrollCI({ ...ctx, attendanceDeductions: {
      absenceDays: 1, absenceAmount: 10000, lateMinutes: 0, latenessAmount: 0, suspendAttendanceBonus: true,
    } })
    expect(r.lines.find((l) => l.code === '1300')).toBeUndefined()
  })

  it('la retenue ne rend jamais le salaire de base négatif', () => {
    const r = calculatePayrollCI({ ...ctx, attendanceDeductions: {
      absenceDays: 30, absenceAmount: 999999, lateMinutes: 600, latenessAmount: 99999, suspendAttendanceBonus: false,
    } })
    expect(r.brutProrata).toBe(0)
    expect(r.netPayable).toBeGreaterThanOrEqual(0)
  })
})