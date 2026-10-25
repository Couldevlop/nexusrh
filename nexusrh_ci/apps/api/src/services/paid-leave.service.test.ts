import { describe, it, expect } from 'vitest'
import {
  accruedPaidLeaveDays, averageRemuneration, checkPaidLeaveRequest, effectiveLeavePolicy,
  monthsServedInYear, paidLeaveAllowance, parseLeavePolicy, refreshPaidLeaveBalance, seniorityYearsAt,
} from './paid-leave.service.js'
import { CIV_2024 } from './legislation-packs.js'

const CIV = effectiveLeavePolicy(CIV_2024.leaveRules, null)

/** Base factice : réponses choisies selon le texte SQL, appels enregistrés. */
function fakeDb(routes: Array<[string, unknown[] | Error]>) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  return {
    calls,
    async query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
      calls.push({ sql, params })
      const hit = routes.find(([k]) => sql.includes(k))
      if (!hit) return { rows: [] }
      if (hit[1] instanceof Error) throw hit[1]
      return { rows: hit[1] as R[] }
    },
  }
}

describe('acquisition — CT CI art. 25.1 / 25.2', () => {
  it('mois de service accomplis dans l année', () => {
    expect(monthsServedInYear('2019-09-29', 2026, '2026-10-24')).toBe(9)
    expect(monthsServedInYear('2019-09-29', 2026, '2026-12-31')).toBe(12)
    expect(monthsServedInYear('2026-07-07', 2026, '2026-10-24')).toBe(3)
    expect(monthsServedInYear('2026-07-07', 2026, '2026-10-06')).toBe(3) // 7 juil. → 6 oct. inclus
    expect(monthsServedInYear('2026-07-07', 2026, '2026-10-05')).toBe(2)
    expect(monthsServedInYear('2026-11-01', 2026, '2026-10-24')).toBe(0)
    expect(monthsServedInYear(null, 2026, '2026-03-01')).toBe(2)
  })

  it('ancienneté en années complètes', () => {
    expect(seniorityYearsAt('2019-09-29', '2026-10-24')).toBe(7)
    expect(seniorityYearsAt('2019-10-25', '2026-10-24')).toBe(6)
    expect(seniorityYearsAt(null, '2026-10-24')).toBe(0)
  })

  it('pack CIV : 2,2 j/mois + jours d ancienneté au prorata', () => {
    // 7 ans → +1 j/an ; 9 mois → 19,8 + 0,75 = 20,55 → 20,6
    expect(accruedPaidLeaveDays(CIV, '2019-09-29', 2026, '2026-10-24')).toEqual({
      months: 9, principal: 19.8, seniority: 0.8, total: 20.6,
    })
    // Année complète, 31 ans : 26,4 + 8 = 34,4
    expect(accruedPaidLeaveDays(CIV, '1995-01-01', 2026, '2026-12-31').total).toBe(34.4)
    // Pas d arrondi parasite : 2,2 × 3 = 6,6
    expect(accruedPaidLeaveDays(CIV, '2026-07-07', 2026, '2026-10-24').total).toBe(6.6)
  })
})

describe('politique de congés', () => {
  it('règles du pays par défaut', () => {
    expect(CIV).toMatchObject({
      accrualMode: 'monthly', daysPerMonth: 2.2, calendarDaysPerWorkingDay: 1.25,
      allowanceMethod: 'most_favourable', balanceCheck: 'block', maxAdvanceDays: 0, leaveTypeCode: 'CP',
      legalDaysPerMonth: 2.2, carryOver: true,
    })
  })
  it('surcharge tenant prioritaire, valeur invalide ignorée', () => {
    const p = effectiveLeavePolicy(CIV_2024.leaveRules, { daysPerMonth: 2.5, balanceCheck: 'warn', maxAdvanceDays: 5 })
    expect(p.daysPerMonth).toBe(2.5)
    expect(p.balanceCheck).toBe('warn')
    expect(p.maxAdvanceDays).toBe(5)
    expect(parseLeavePolicy({ balanceCheck: 'nope' })).toEqual({})
    expect(parseLeavePolicy('x')).toEqual({})
  })
  it('pays sans règles : rien acquis plutôt que les règles CI', () => {
    expect(effectiveLeavePolicy(undefined, null).daysPerMonth).toBe(0)
  })
})

describe('allocation de congés — CCI art. 71 / décret 98-39 art. 12 / CT art. 25.7', () => {
  const base = { days: 10, averageMonthlyExclFrais: 270_000, averageMonthlyTotal: 300_000, currentMonthly: 250_000 }

  it('le plus favorable des méthodes, jamais sous le salaire maintenu', () => {
    const a = paidLeaveAllowance({ ...base, policy: CIV })
    expect(a.calendarDays).toBe(12.5)
    expect(a.candidates).toEqual({ average_calendar: 112_500, one_twelfth: 113_636, maintained_salary: 104_167 })
    expect(a).toMatchObject({ amount: 113_636, method: 'one_twelfth' })
  })
  it('méthode imposée par le tenant', () => {
    const a = paidLeaveAllowance({ ...base, policy: { ...CIV, allowanceMethod: 'average_calendar' } })
    expect(a).toMatchObject({ amount: 112_500, method: 'average_calendar' })
  })
  it('salaire maintenu si la moyenne est plus basse (augmentation récente)', () => {
    const a = paidLeaveAllowance({ ...base, averageMonthlyExclFrais: 200_000, averageMonthlyTotal: 200_000, policy: CIV })
    expect(a.method).toBe('maintained_salary')
  })
  it('0 jour → 0', () => {
    expect(paidLeaveAllowance({ ...base, days: 0, policy: CIV }).amount).toBe(0)
  })
})

describe('moyenne des 12 derniers bulletins', () => {
  it('exclut transport (1300) et allocation de congés (1600)', async () => {
    const db = fakeDb([['pay_slips', [
      { gross_salary: '330000', lines: [{ code: '1000', amount: 300000 }, { code: '1300', amount: 30000 }] },
      { gross_salary: 300000, lines: JSON.stringify([{ code: '1000', amount: 250000 }, { code: '1600', amount: 50000 }]) },
    ]]])
    expect(await averageRemuneration(db, 'tenant_x', 'e1', '2026-10')).toEqual({ total: 315000, exclFrais: 275000, months: 2 })
  })
  it('exclut des deux moyennes les indemnités de rupture du bulletin de solde (1610/1620/1630)', async () => {
    // Recette 10/2026 (Yao) : le bulletin de solde d'octobre portait congés + préavis +
    // licenciement ; les compter gonflait la base du solde qui les calcule (circularité).
    const db = fakeDb([['pay_slips', [
      { gross_salary: 792384, lines: [
        { code: '1000', amount: 250000 }, { code: '1010', amount: -9259 }, { code: '1020', amount: -2524 },
        { code: '1610', amount: 229167 }, { code: '1620', amount: 250000 }, { code: '1630', amount: 75000 },
      ] },
      { gross_salary: 250000, lines: [{ code: '1000', amount: 250000 }] },
      { gross_salary: 250000, lines: [{ code: '1000', amount: 250000 }] },
      { gross_salary: 250000, lines: [{ code: '1000', amount: 250000 }] },
    ]]])
    expect(await averageRemuneration(db, 'tenant_x', 'e1', '2026-10'))
      .toEqual({ total: 247054, exclFrais: 247054, months: 4 })
  })
  it('aucun bulletin ou erreur → null', async () => {
    expect(await averageRemuneration(fakeDb([]), 's', 'e', '2026-10')).toBeNull()
    expect(await averageRemuneration(fakeDb([['pay_slips', new Error('x')]]), 's', 'e', '2026-10')).toBeNull()
  })
})

describe('solde — recalcul de l acquis', () => {
  const routes = (extra: Array<[string, unknown[] | Error]> = []): Array<[string, unknown[] | Error]> => [
    ...extra,
    ['FROM "tenant_x".absence_types WHERE code', [{ id: 'cp' }]],
    ['FROM "tenant_x".employees WHERE id', [{ hire_date: '2019-09-29', legal_entity_id: null }]],
    ['AND year = $3 ORDER BY', [{ id: 'b1', acquired: '26', taken: '4', pending: '1', remaining: '5' }]],
  ]

  it('mode mensuel : acquis recalculé et enregistré', async () => {
    const db = fakeDb(routes())
    const b = await refreshPaidLeaveBalance(db, 'tenant_x', 'e1', { ...CIV, carryOver: false }, '2026-10-24')
    expect(b).toMatchObject({ acquired: 20.6, taken: 4, pending: 1, remaining: 15.6, mode: 'monthly' })
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE'))
    expect(upd?.params).toEqual([20.6, 15.6, 'b1'])
  })

  it('simulation (persist=false) : rien n est écrit', async () => {
    const db = fakeDb(routes())
    await refreshPaidLeaveBalance(db, 'tenant_x', 'e1', CIV, '2026-12-31', { persist: false })
    expect(db.calls.some((c) => /^(UPDATE|INSERT)/.test(c.sql.trim()))).toBe(false)
  })

  it('mode manuel : solde stocké inchangé', async () => {
    const db = fakeDb(routes())
    const b = await refreshPaidLeaveBalance(db, 'tenant_x', 'e1', { ...CIV, accrualMode: 'manual' }, '2026-10-24')
    expect(b).toMatchObject({ acquired: 26, remaining: 21, mode: 'manual' })
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
  })

  it('pas de ligne de solde : créée depuis les absences de l année', async () => {
    const db = fakeDb([
      ['AND year = $3 ORDER BY', []],
      ['SUM(days)', [{ taken: '3', pending: '2' }]],
      ['INSERT INTO "tenant_x".absence_balances', [{ id: 'nb', acquired: '0', taken: '3', pending: '2' }]],
      ...routes().slice(0, 2),
    ])
    const b = await refreshPaidLeaveBalance(db, 'tenant_x', 'e1', { ...CIV, carryOver: false }, '2026-10-24')
    expect(b).toMatchObject({ acquired: 20.6, taken: 3, pending: 2, remaining: 15.6 })
  })

  it('aucun type congés payés / base en erreur → null', async () => {
    expect(await refreshPaidLeaveBalance(fakeDb([]), 'tenant_x', 'e1', CIV)).toBeNull()
    expect(await refreshPaidLeaveBalance(fakeDb([['absence_types', new Error('down')]]), 'tenant_x', 'e1', CIV)).toBeNull()
  })
})

describe('contrôle d une demande de congés payés', () => {
  const routes = (code: string, policy: unknown = null): Array<[string, unknown[] | Error]> => [
    ['WHERE id = $1 LIMIT 1`', []],
    ['SELECT code FROM "tenant_x".absence_types WHERE id', [{ code }]],
    ['leave_policy', [{ leave_policy: policy }]],
    ['FROM platform.tenants', [{ id: 't', at_rate: '0.02', has_subsidiaries: false, default_country_code: 'CIV' }]],
    ['FROM "tenant_x".absence_types WHERE code', [{ id: 'cp' }]],
    ['FROM "tenant_x".employees WHERE id', [{ hire_date: '2026-07-07', legal_entity_id: null }]],
    ['AND year = $3 ORDER BY', [{ id: 'b1', acquired: '0', taken: '0', pending: '0' }]],
  ]

  it('au-delà du solde → bloqué', async () => {
    const r = await checkPaidLeaveRequest(fakeDb(routes('CP')), 'tenant_x', 'e1', 'cp', 10, '2026-10-24')
    expect(r).toMatchObject({ available: 6.6, insufficient: true, blocked: true })
  })
  it('dans le solde → accepté', async () => {
    const r = await checkPaidLeaveRequest(fakeDb(routes('CP')), 'tenant_x', 'e1', 'cp', 5, '2026-10-24')
    expect(r).toMatchObject({ insufficient: false, blocked: false })
  })
  it('mode avertissement et anticipation paramétrés par le tenant', async () => {
    const r = await checkPaidLeaveRequest(fakeDb(routes('CP', { balanceCheck: 'warn' })), 'tenant_x', 'e1', 'cp', 10, '2026-10-24')
    expect(r).toMatchObject({ insufficient: true, blocked: false })
    const r2 = await checkPaidLeaveRequest(fakeDb(routes('CP', { maxAdvanceDays: 5 })), 'tenant_x', 'e1', 'cp', 10, '2026-10-24')
    expect(r2).toMatchObject({ available: 11.6, insufficient: false })
  })
  it('autre type d absence ou contrôle désactivé → null', async () => {
    expect(await checkPaidLeaveRequest(fakeDb(routes('MALADIE')), 'tenant_x', 'e1', 'm', 10)).toBeNull()
    expect(await checkPaidLeaveRequest(fakeDb(routes('CP', { balanceCheck: 'off' })), 'tenant_x', 'e1', 'cp', 10)).toBeNull()
  })
})