import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
const { evaluateEscalationSpy } = vi.hoisted(() => ({ evaluateEscalationSpy: vi.fn() }))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

// Spy sur `evaluateEscalation` tout en exécutant la VRAIE implémentation (le
// moteur pur, déjà testé dans attendance-core/attendance.escalation.test.ts) —
// permet de vérifier l'argument `workdays` sans jamais réimplémenter la logique.
vi.mock('../attendance-core/attendance.escalation.js', async () => {
  const actual = await vi.importActual<typeof import('../attendance-core/attendance.escalation.js')>(
    '../attendance-core/attendance.escalation.js',
  )
  return {
    ...actual,
    evaluateEscalation: (input: Parameters<typeof actual.evaluateEscalation>[0]) => {
      evaluateEscalationSpy(input)
      return actual.evaluateEscalation(input)
    },
  }
})

import { processAttendanceEvaluateJob } from './attendance-evaluate.js'

const SCHEMA = 'tenant_test'
const EMPLOYEE_ID = 'aaaaaaaa-1111-1111-1111-111111111111'

function jobFor(data: unknown): Job<unknown, void> {
  return { id: 'job-1', data } as unknown as Job<unknown, void>
}

interface MockState {
  departmentId?: string | null
  scheduleRows?: Array<{ scope: string; expected_start: string; tolerance_min: number; expected_end: string | null; workdays: number[] }>
  configRow?: Record<string, unknown> | null
  punchesByDate?: Record<string, Array<{ raw_employee_ref: string | null; punched_at: string; direction: string; dedup_key: string; raw: unknown }>>
  approvedLeaveByDate?: Record<string, string | null>
  singleTargetFound?: boolean
  activeTargets?: string[]
  consumedTier1?: string[]
  consumedTier2?: string[]
  activeWarningsCount?: number
  userId?: string | null
}

/** Dispatcher générique : identifie chaque requête par un extrait DE TEXTE SQL unique (cf. attendance-evaluate.ts). */
function makeQueryMock(state: MockState) {
  let warningCounter = 0
  let sanctionCounter = 0

  return vi.fn((sql: unknown, params?: unknown[]) => {
    const s = String(sql)
    const p = params ?? []

    if (s.includes('attendance_config')) {
      return Promise.resolve({ rows: state.configRow ? [state.configRow] : [] })
    }
    if (s.includes('attendance_schedules')) {
      return Promise.resolve({ rows: state.scheduleRows ?? [] })
    }
    if (s.includes('SELECT department_id FROM')) {
      return Promise.resolve({ rows: [{ department_id: state.departmentId ?? null }] })
    }
    if (s.includes('SELECT user_id FROM')) {
      return Promise.resolve({ rows: [{ user_id: state.userId ?? null }] })
    }
    if (s.includes('attendance_punches')) {
      const date = String(p[1]).slice(0, 10)
      const rows = (state.punchesByDate ?? {})[date] ?? []
      return Promise.resolve({ rows })
    }
    if (s.includes('.absences')) {
      const date = String(p[1]).slice(0, 10)
      const leaveId = (state.approvedLeaveByDate ?? {})[date] ?? null
      return Promise.resolve({ rows: leaveId ? [{ id: leaveId }] : [] })
    }
    if (s.includes('INSERT INTO') && s.includes('attendance_days')) {
      return Promise.resolve({ rowCount: 1 })
    }
    if (s.includes('SELECT tier, occurrence_dates')) {
      const rows: Array<{ tier: string; occurrence_dates: string[] }> = []
      if (state.consumedTier1?.length) rows.push({ tier: 'avertissement', occurrence_dates: state.consumedTier1 })
      if (state.consumedTier2?.length) rows.push({ tier: 'demande_explication', occurrence_dates: state.consumedTier2 })
      return Promise.resolve({ rows })
    }
    if (s.includes('COUNT(*) AS count')) {
      return Promise.resolve({ rows: [{ count: String(state.activeWarningsCount ?? 0) }] })
    }
    if (s.includes('INSERT INTO') && s.includes('attendance_warnings')) {
      warningCounter += 1
      return Promise.resolve({ rows: [{ id: `warn-${warningCounter}` }] })
    }
    if (s.includes('UPDATE') && s.includes('attendance_warnings') && s.includes('disciplinary_action_id')) {
      return Promise.resolve({ rowCount: Array.isArray(p[1]) ? (p[1] as unknown[]).length : 0 })
    }
    if (s.includes('disciplinary_actions')) {
      sanctionCounter += 1
      return Promise.resolve({ rows: [{ id: `sanction-${sanctionCounter}` }] })
    }
    if (s.includes('.notifications') && s.includes('VALUES ($1, $2, $3, $4, $5)')) {
      return Promise.resolve({ rowCount: 1 })
    }
    if (s.includes('.notifications') && s.includes('SELECT id, $1, $2, $3, $4')) {
      return Promise.resolve({ rowCount: 1 })
    }
    if (s.includes('SELECT DISTINCT e.id')) {
      return Promise.resolve({ rows: (state.activeTargets ?? []).map((id) => ({ id })) })
    }
    if (s.includes('SELECT id FROM') && s.includes('.employees WHERE id = $1')) {
      return Promise.resolve({ rows: state.singleTargetFound === false ? [] : [{ id: p[0] }] })
    }
    // Repli défensif : ne doit jamais crasher un `.catch()` en aval.
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => {
  queryMock.mockReset()
  loggerMock.info.mockReset()
  loggerMock.error.mockReset()
  loggerMock.warn.mockReset()
  evaluateEscalationSpy.mockReset()
})

describe('processAttendanceEvaluateJob — validation du payload', () => {
  it('schemaName invalide → rejeté sans crash, aucune requête DB', async () => {
    queryMock.mockImplementation(makeQueryMock({}))
    await expect(
      processAttendanceEvaluateJob(jobFor({ schemaName: 'BAD SCHEMA', dateFrom: '2026-07-06', dateTo: '2026-07-08' })),
    ).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
    expect(loggerMock.error).toHaveBeenCalled()
  })

  it('employeeId non-UUID → rejeté sans crash', async () => {
    queryMock.mockImplementation(makeQueryMock({}))
    await expect(
      processAttendanceEvaluateJob(jobFor({ schemaName: SCHEMA, employeeId: 'not-a-uuid', dateFrom: '2026-07-06', dateTo: '2026-07-08' })),
    ).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('dateFrom postérieure à dateTo → rejeté sans crash', async () => {
    queryMock.mockImplementation(makeQueryMock({}))
    await expect(
      processAttendanceEvaluateJob(jobFor({ schemaName: SCHEMA, dateFrom: '2026-07-08', dateTo: '2026-07-06' })),
    ).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('plage trop large (> 366 jours) → rejetée sans crash', async () => {
    queryMock.mockImplementation(makeQueryMock({}))
    await expect(
      processAttendanceEvaluateJob(jobFor({ schemaName: SCHEMA, dateFrom: '2020-01-01', dateTo: '2025-01-01' })),
    ).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('payload non-objet (null) → rejeté sans crash', async () => {
    queryMock.mockImplementation(makeQueryMock({}))
    await expect(processAttendanceEvaluateJob(jobFor(null))).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('processAttendanceEvaluateJob — 3 jours de retard (1h) consécutifs', () => {
  it('génère 2 avertissements + 1 brouillon de sanction, persiste et notifie RH+employé, transmet workdays à evaluateEscalation', async () => {
    const punchesByDate = {
      '2026-07-06': [{ raw_employee_ref: 'M1', punched_at: '2026-07-06T09:15:00.000Z', direction: 'in', dedup_key: 'a', raw: {} }],
      '2026-07-07': [{ raw_employee_ref: 'M1', punched_at: '2026-07-07T09:15:00.000Z', direction: 'in', dedup_key: 'b', raw: {} }],
      '2026-07-08': [{ raw_employee_ref: 'M1', punched_at: '2026-07-08T09:15:00.000Z', direction: 'in', dedup_key: 'c', raw: {} }],
    }
    queryMock.mockImplementation(makeQueryMock({
      singleTargetFound: true,
      departmentId: null,
      scheduleRows: [], // pas de surcharge → horaire de repli tenant (workdays [1,2,3,4,5])
      configRow: null,  // pas de config → défauts applicatifs
      punchesByDate,
      approvedLeaveByDate: {},
      consumedTier1: [],
      consumedTier2: [],
      activeWarningsCount: 0,
      userId: 'user-emp-1',
    }))

    await processAttendanceEvaluateJob(jobFor({
      schemaName: SCHEMA, employeeId: EMPLOYEE_ID, dateFrom: '2026-07-06', dateTo: '2026-07-08',
    }))

    // evaluateEscalation appelé UNE fois, avec les jours calculés ET workdays explicitement transmis
    // (le défaut tenant de repli est [1,2,3,4,5] — DIFFÉRENT du défaut interne du moteur
    // [1,2,3,4,5,6] — la présence de [1,2,3,4,5] prouve que le champ a bien été transmis).
    expect(evaluateEscalationSpy).toHaveBeenCalledTimes(1)
    const call = evaluateEscalationSpy.mock.calls[0]![0] as { workdays?: number[]; days: Array<{ status: string }> }
    expect(call.workdays).toEqual([1, 2, 3, 4, 5])
    expect(call.days).toHaveLength(3)
    expect(call.days.every((d) => d.status === 'late')).toBe(true)

    const warningInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_warnings'))
    expect(warningInserts).toHaveLength(2)
    const tiers = warningInserts.map((c) => (c[1] as unknown[])[1])
    expect(tiers.sort()).toEqual(['avertissement', 'demande_explication'])

    const sanctionInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('disciplinary_actions'))
    expect(sanctionInserts).toHaveLength(1)
    expect(String(sanctionInserts[0]![0])).toContain("'avertissement'")
    expect(String(sanctionInserts[0]![0])).toContain("'draft'")
    const sanctionParams = sanctionInserts[0]![1] as unknown[]
    expect(sanctionParams[0]).toBe(EMPLOYEE_ID)
    expect(String(sanctionParams[1])).toContain('avertissements')

    const linkCall = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE') && String(c[0]).includes('disciplinary_action_id'))
    expect(linkCall).toBeDefined()
    expect((linkCall![1] as unknown[])[1]).toEqual(['warn-1', 'warn-2'])

    // Notifications : employé (5 params) + RH (4 params, SELECT depuis users) pour chaque
    // avertissement (2) et pour la sanction (1) → 3 x 2 = 6 insertions au total.
    const employeeNotifs = queryMock.mock.calls.filter((c) => String(c[0]).includes('.notifications') && String(c[0]).includes('VALUES ($1, $2, $3, $4, $5)'))
    const rhNotifs = queryMock.mock.calls.filter((c) => String(c[0]).includes('.notifications') && String(c[0]).includes('SELECT id, $1, $2, $3, $4'))
    expect(employeeNotifs).toHaveLength(3)
    expect(rhNotifs).toHaveLength(3)

    const daysUpserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_days'))
    expect(daysUpserts).toHaveLength(3)
  })
})

describe('processAttendanceEvaluateJob — congé approuvé', () => {
  it('jour sans pointage mais congé approuvé → absent_justified, aucun avertissement', async () => {
    queryMock.mockImplementation(makeQueryMock({
      singleTargetFound: true,
      departmentId: null,
      scheduleRows: [],
      configRow: null,
      punchesByDate: {},
      approvedLeaveByDate: { '2026-07-08': 'leave-1' },
      consumedTier1: [],
      consumedTier2: [],
      activeWarningsCount: 0,
      userId: null,
    }))

    await processAttendanceEvaluateJob(jobFor({
      schemaName: SCHEMA, employeeId: EMPLOYEE_ID, dateFrom: '2026-07-08', dateTo: '2026-07-08',
    }))

    const dayUpsert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_days'))
    expect(dayUpsert).toBeDefined()
    const params = dayUpsert![1] as unknown[]
    // (employee_id, work_date, first_in, last_out, expected_start, late_minutes, status, justified_by)
    expect(params[6]).toBe('absent_justified')
    expect(params[7]).toBe('leave-1')

    const warningInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_warnings'))
    expect(warningInserts).toHaveLength(0)
    const sanctionInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('disciplinary_actions'))
    expect(sanctionInserts).toHaveLength(0)
  })
})

describe('processAttendanceEvaluateJob — idempotence (relancement sur la même plage)', () => {
  it('dates déjà consommées (avertissements existants) → aucun nouvel avertissement généré', async () => {
    const punchesByDate = {
      '2026-07-06': [{ raw_employee_ref: 'M1', punched_at: '2026-07-06T09:15:00.000Z', direction: 'in', dedup_key: 'a', raw: {} }],
      '2026-07-07': [{ raw_employee_ref: 'M1', punched_at: '2026-07-07T09:15:00.000Z', direction: 'in', dedup_key: 'b', raw: {} }],
      '2026-07-08': [{ raw_employee_ref: 'M1', punched_at: '2026-07-08T09:15:00.000Z', direction: 'in', dedup_key: 'c', raw: {} }],
    }
    queryMock.mockImplementation(makeQueryMock({
      singleTargetFound: true,
      departmentId: null,
      scheduleRows: [],
      configRow: null,
      punchesByDate,
      approvedLeaveByDate: {},
      // Les 3 dates sont déjà consommées par les avertissements du run précédent.
      consumedTier1: ['2026-07-06', '2026-07-07', '2026-07-08'],
      consumedTier2: ['2026-07-06', '2026-07-07', '2026-07-08'],
      activeWarningsCount: 0,
      userId: 'user-emp-1',
    }))

    await processAttendanceEvaluateJob(jobFor({
      schemaName: SCHEMA, employeeId: EMPLOYEE_ID, dateFrom: '2026-07-06', dateTo: '2026-07-08',
    }))

    const warningInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_warnings'))
    expect(warningInserts).toHaveLength(0)
    const sanctionInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('disciplinary_actions'))
    expect(sanctionInserts).toHaveLength(0)

    // Les jours restent malgré tout recalculés/upsertés (idempotent via ON CONFLICT DO UPDATE).
    const daysUpserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_days'))
    expect(daysUpserts).toHaveLength(3)
  })
})

describe('processAttendanceEvaluateJob — isolation des pannes', () => {
  it('échec DB pour un employé (liste multi-employés) → les autres employés sont quand même traités', async () => {
    const employeeA = 'aaaaaaaa-2222-2222-2222-222222222222'
    const employeeB = 'bbbbbbbb-3333-3333-3333-333333333333'

    queryMock.mockImplementation((sql: unknown, params?: unknown[]) => {
      const s = String(sql)
      const p = params ?? []
      if (s.includes('SELECT DISTINCT e.id')) {
        return Promise.resolve({ rows: [{ id: employeeA }, { id: employeeB }] })
      }
      if (s.includes('SELECT department_id FROM')) {
        // L'employé A fait planter la lecture de département (erreur DB simulée) ;
        // l'employé B est traité normalement.
        if (p[0] === employeeA) return Promise.reject(new Error('connexion DB perdue'))
        return Promise.resolve({ rows: [{ department_id: null }] })
      }
      if (s.includes('attendance_config')) return Promise.resolve({ rows: [] })
      if (s.includes('attendance_schedules')) return Promise.resolve({ rows: [] })
      if (s.includes('attendance_punches')) return Promise.resolve({ rows: [] })
      if (s.includes('.absences')) return Promise.resolve({ rows: [] })
      if (s.includes('INSERT INTO') && s.includes('attendance_days')) return Promise.resolve({ rowCount: 1 })
      if (s.includes('SELECT tier, occurrence_dates')) return Promise.resolve({ rows: [] })
      if (s.includes('COUNT(*) AS count')) return Promise.resolve({ rows: [{ count: '0' }] })
      if (s.includes('INSERT INTO') && s.includes('attendance_warnings')) return Promise.resolve({ rows: [{ id: 'warn-x' }] })
      // Repli défensif (notifications, etc.) : ne doit jamais renvoyer `undefined`.
      return Promise.resolve({ rows: [] })
    })

    await expect(
      processAttendanceEvaluateJob(jobFor({ schemaName: SCHEMA, dateFrom: '2026-07-06', dateTo: '2026-07-06' })),
    ).resolves.toBeUndefined()

    expect(loggerMock.error).toHaveBeenCalled()
    // Les jours de l'employé B ont bien été upsertés malgré l'échec sur A.
    const daysUpserts = queryMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('attendance_days'))
    expect(daysUpserts.length).toBeGreaterThan(0)
  })
})
