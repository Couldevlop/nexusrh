/**
 * Badgeuse / Pointage — helpers d'accès données (repository).
 * Tests ciblés : SQL paramétré, isolation tenant, allowlist employeeMatchBy.
 * `pool.query` est mocké (`vi.fn()`) — aucune vraie connexion DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import {
  loadConfig,
  resolveEmployeeSchedule,
  insertPunches,
  upsertDay,
  loadDaysForEmployee,
  loadConsumedDates,
  countActiveWarnings,
  insertWarning,
  insertSanctionDraft,
} from './attendance.repo.js'
import type { NormalizedPunch } from './attendance.types.js'

const SCHEMA = 'tenant_sotra'

function mockPool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool
}

function punch(overrides: Partial<NormalizedPunch> = {}): NormalizedPunch {
  return {
    rawEmployeeRef: 'M001',
    punchedAt: new Date('2026-07-16T08:00:00Z'),
    direction: 'in',
    dedupKey: 'dev-1|M001|2026-07-16T08:00:00Z',
    raw: { badge: 'M001' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('insertPunches', () => {
  it("matricule → colonne employee_number, INSERT avec ON CONFLICT (device_id, dedup_key) DO NOTHING", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] }) // SELECT résolution employé
      .mockResolvedValueOnce({ rowCount: 1 })              // INSERT
    const result = await insertPunches(mockPool(query), SCHEMA, 'dev-1', [punch()], 'matricule')

    expect(result).toEqual({ total: 1, matched: 1, inserted: 1 })
    expect(query).toHaveBeenCalledTimes(2)

    const [selectSql, selectParams] = query.mock.calls[0]!
    expect(selectSql).toContain(`"${SCHEMA}"`)
    expect(selectSql).toContain('employee_number')
    expect(selectSql).not.toContain('matricule') // matchBy jamais interpolé tel quel
    expect(selectParams).toEqual(['M001'])

    const [insertSql, insertParams] = query.mock.calls[1]!
    expect(insertSql).toContain(`"${SCHEMA}"`)
    expect(insertSql).toContain('attendance_punches')
    expect(insertSql).toContain('ON CONFLICT (device_id, dedup_key) DO NOTHING')
    expect(insertParams[0]).toBe('emp-1') // employee_id résolu
    expect(insertParams).toContain('dev-1')
    expect(insertParams).toContain('dev-1|M001|2026-07-16T08:00:00Z')
  })

  it('email → colonne email', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'emp-2' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
    await insertPunches(mockPool(query), SCHEMA, 'dev-1', [punch({ rawEmployeeRef: 'a@sotra.ci' })], 'email')

    const [selectSql, selectParams] = query.mock.calls[0]!
    expect(selectSql).toContain('WHERE email = $1')
    expect(selectParams).toEqual(['a@sotra.ci'])
  })

  it("badge_id (colonne absente d'employees) : aucun SELECT, employee_id = null, insertion quand même effectuée", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 }) // seul l'INSERT est appelé
    const result = await insertPunches(mockPool(query), SCHEMA, 'dev-1', [punch({ rawEmployeeRef: 'B001' })], 'badge_id')

    expect(query).toHaveBeenCalledTimes(1) // pas de SELECT contre une colonne inexistante
    expect(result).toEqual({ total: 1, matched: 0, inserted: 1 })
    const [insertSql, insertParams] = query.mock.calls[0]!
    expect(insertSql).toContain('attendance_punches')
    expect(insertParams[0]).toBeNull()
  })

  it('matchBy inconnu (valeur non validée en amont) : ignoré, jamais interpolé dans le SQL', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 })
    const evil = "nom'; DROP TABLE employees;--"
    const result = await insertPunches(
      mockPool(query), SCHEMA, 'dev-1', [punch()],
      evil as unknown as Parameters<typeof insertPunches>[4],
    )

    expect(query).toHaveBeenCalledTimes(1) // aucun SELECT tenté
    expect(result.matched).toBe(0)
    const [insertSql] = query.mock.calls[0]!
    expect(insertSql).not.toContain('DROP TABLE')
    expect(insertSql).not.toContain(evil)
  })

  it("un pointage en échec n'interrompt pas le lot", async () => {
    // matchBy='badge_id' → une seule requête par pointage (l'INSERT, pas de SELECT
    // puisque la colonne n'existe pas) : simplifie la séquence de mocks.
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))   // INSERT du 1er pointage échoue
      .mockResolvedValueOnce({ rowCount: 1 })       // INSERT du 2e pointage réussit
    const punches = [punch({ dedupKey: 'dk1' }), punch({ dedupKey: 'dk2' })]
    const result = await insertPunches(mockPool(query), SCHEMA, 'dev-1', punches, 'badge_id')

    expect(result.total).toBe(2)
    expect(result.inserted).toBe(1) // le 1er a échoué (catch), le 2e a réussi
  })

  it('toutes les requêtes contiennent le schema tenant', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'emp-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
    await insertPunches(mockPool(query), SCHEMA, 'dev-1', [punch()], 'matricule')
    for (const call of query.mock.calls) {
      expect(call[0] as string).toContain(`"${SCHEMA}"`)
    }
  })
})

describe('loadConfig', () => {
  it('mappe la ligne singleton snake_case → camelCase', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        late_minutes_tier1: 30, occurrences_tier1: 3,
        late_minutes_tier2: 60, occurrences_tier2: 3,
        unjustified_absence_occurrences: 1,
        warnings_before_sanction: 2,
        window_mode: 'consecutive_or_month',
      }],
    })
    const cfg = await loadConfig(mockPool(query), SCHEMA)
    expect(cfg).toEqual({
      lateMinutesTier1: 30, occurrencesTier1: 3,
      lateMinutesTier2: 60, occurrencesTier2: 3,
      unjustifiedAbsenceOccurrences: 1,
      warningsBeforeSanction: 2,
      windowMode: 'consecutive_or_month',
    })
    const [sql] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(sql).toContain('attendance_config')
    expect(sql).toContain('ORDER BY updated_at DESC')
  })

  it('aucune ligne → null', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] })
    expect(await loadConfig(mockPool(query), SCHEMA)).toBeNull()
  })

  it('erreur DB → null (jamais de throw)', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    expect(await loadConfig(mockPool(query), SCHEMA)).toBeNull()
  })
})

describe('resolveEmployeeSchedule', () => {
  it('mappe les 3 portées (employee/department/tenant) vers EffectiveSchedule', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        { scope: 'employee', expected_start: '08:15:00', tolerance_min: 5, expected_end: '17:00:00', workdays: [1, 2, 3, 4, 5] },
        { scope: 'tenant', expected_start: '08:00:00', tolerance_min: 10, expected_end: null, workdays: [1, 2, 3, 4, 5, 6] },
      ],
    })
    const res = await resolveEmployeeSchedule(mockPool(query), SCHEMA, 'emp-1', null)
    expect(res.employee).toEqual({ expectedStart: '08:15', toleranceMin: 5, expectedEnd: '17:00', workdays: [1, 2, 3, 4, 5] })
    expect(res.department).toBeNull()
    expect(res.tenant).toEqual({ expectedStart: '08:00', toleranceMin: 10, expectedEnd: null, workdays: [1, 2, 3, 4, 5, 6] })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(params).toEqual(['emp-1', null])
  })

  it('erreur DB → 3 portées null (jamais de throw)', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    const res = await resolveEmployeeSchedule(mockPool(query), SCHEMA, 'emp-1', 'dep-1')
    expect(res).toEqual({ employee: null, department: null, tenant: null })
  })
})

describe('upsertDay', () => {
  it('ON CONFLICT (employee_id, work_date) DO UPDATE — recalcul idempotent', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 })
    await upsertDay(mockPool(query), SCHEMA, {
      employeeId: 'emp-1', workDate: '2026-07-16',
      firstIn: new Date('2026-07-16T08:10:00Z'), lastOut: null,
      lateMinutes: 10, status: 'late', justifiedBy: null,
    })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(sql).toContain('attendance_days')
    expect(sql).toContain('ON CONFLICT (employee_id, work_date) DO UPDATE')
    expect(params).toEqual(['emp-1', '2026-07-16', new Date('2026-07-16T08:10:00Z'), null, null, 10, 'late', null])
  })

  it('erreur DB → rejette (écriture, jamais avalée silencieusement)', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    await expect(upsertDay(mockPool(query), SCHEMA, {
      employeeId: 'emp-1', workDate: '2026-07-16',
      firstIn: null, lastOut: null, lateMinutes: 0, status: 'absent_unjustified', justifiedBy: null,
    })).rejects.toThrow(/upsertDay a échoué/)
  })
})

describe('loadDaysForEmployee', () => {
  it('charge la plage [from,to] triée et mappe vers ComputedDay', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ work_date: new Date('2026-07-16T00:00:00Z'), first_in: null, last_out: null, late_minutes: 0, status: 'absent_unjustified', justified_by: null }],
    })
    const days = await loadDaysForEmployee(mockPool(query), SCHEMA, 'emp-1', '2026-07-01', '2026-07-31')
    expect(days).toEqual([{ workDate: '2026-07-16', firstIn: null, lastOut: null, lateMinutes: 0, status: 'absent_unjustified', justifiedBy: null }])
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(sql).toContain('BETWEEN $2 AND $3')
    expect(params).toEqual(['emp-1', '2026-07-01', '2026-07-31'])
  })

  it('erreur DB → tableau vide', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    expect(await loadDaysForEmployee(mockPool(query), SCHEMA, 'emp-1', '2026-07-01', '2026-07-31')).toEqual([])
  })
})

describe('loadConsumedDates', () => {
  it("bucket tier1 = tier 'avertissement' (retards palier 1 + absences injustifiées), tier2 = 'demande_explication'", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        { tier: 'avertissement', occurrence_dates: ['2026-07-01', '2026-07-02'] },
        { tier: 'avertissement', occurrence_dates: ['2026-07-10'] }, // ex. absence injustifiée
        { tier: 'demande_explication', occurrence_dates: ['2026-07-05'] },
      ],
    })
    const res = await loadConsumedDates(mockPool(query), SCHEMA, 'emp-1')
    expect(res.tier1).toEqual(['2026-07-01', '2026-07-02', '2026-07-10'])
    expect(res.tier2).toEqual(['2026-07-05'])
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(params).toEqual(['emp-1'])
  })

  it('erreur DB → buckets vides', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    expect(await loadConsumedDates(mockPool(query), SCHEMA, 'emp-1')).toEqual({ tier1: [], tier2: [] })
  })
})

describe('countActiveWarnings', () => {
  it("filtre status IN ('active','contested')", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ count: '3' }] })
    const n = await countActiveWarnings(mockPool(query), SCHEMA, 'emp-1')
    expect(n).toBe(3)
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(sql).toMatch(/status IN \('active',\s*'contested'\)/)
    expect(params).toEqual(['emp-1'])
  })

  it('erreur DB → 0', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    expect(await countActiveWarnings(mockPool(query), SCHEMA, 'emp-1')).toBe(0)
  })
})

describe('insertWarning', () => {
  it('insère avec statut initial active, valeurs paramétrées, renvoie l\'id', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'warn-1' }] })
    const id = await insertWarning(mockPool(query), SCHEMA, {
      employeeId: 'emp-1', tier: 'avertissement', triggerReason: '30min_x3_consecutive',
      occurrenceDates: ['2026-07-01', '2026-07-02', '2026-07-03'],
    })
    expect(id).toBe('warn-1')
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(sql).toContain('attendance_warnings')
    expect(sql).toContain("'active'")
    expect(params).toEqual(['emp-1', 'avertissement', '30min_x3_consecutive', ['2026-07-01', '2026-07-02', '2026-07-03'], null, null])
  })

  it('erreur DB → rejette', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    await expect(insertWarning(mockPool(query), SCHEMA, {
      employeeId: 'emp-1', tier: 'avertissement', triggerReason: 'x', occurrenceDates: [],
    })).rejects.toThrow(/insertWarning a échoué/)
  })
})

describe('insertSanctionDraft', () => {
  it("insère dans disciplinary_actions avec type='avertissement', status='draft', valeurs paramétrées", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'sanction-1' }] })
    const id = await insertSanctionDraft(mockPool(query), SCHEMA, {
      employeeId: 'emp-1', reason: 'Cumul de 2 avertissements', description: 'Occurrences : 2026-07-01',
    })
    expect(id).toBe('sanction-1')
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain(`"${SCHEMA}"`)
    expect(sql).toContain('disciplinary_actions')
    expect(sql).toContain("'avertissement'")
    expect(sql).toContain("'draft'")
    expect(sql).toContain('CURRENT_DATE')
    expect(params).toEqual(['emp-1', 'Cumul de 2 avertissements', 'Occurrences : 2026-07-01', null])
  })

  it('erreur DB → rejette', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down'))
    await expect(insertSanctionDraft(mockPool(query), SCHEMA, { employeeId: 'emp-1', reason: 'x' }))
      .rejects.toThrow(/insertSanctionDraft a échoué/)
  })
})
