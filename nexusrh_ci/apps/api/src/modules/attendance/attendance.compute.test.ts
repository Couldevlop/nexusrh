import { describe, it, expect } from 'vitest'
import { computeDay } from './attendance.compute.js'

const sched = { expectedStart: '08:00', toleranceMin: 10, expectedEnd: '17:00', workdays: [1, 2, 3, 4, 5] }
const p = (t: string, dir = 'in') => ({ rawEmployeeRef: 'M1', punchedAt: new Date(t), direction: dir as 'in', dedupKey: t, raw: {} })

describe('computeDay', () => {
  it('présent à l’heure (dans la tolérance) → late_minutes 0', () => {
    const d = computeDay({ workDate: '2026-07-08', punches: [p('2026-07-08T08:08:00Z')], schedule: sched, isHoliday: false, approvedLeaveId: null })
    expect(d.status).toBe('present'); expect(d.lateMinutes).toBe(0)
  })
  it('retard = premier pointage après start+tolérance', () => {
    const d = computeDay({ workDate: '2026-07-08', punches: [p('2026-07-08T08:45:00Z')], schedule: sched, isHoliday: false, approvedLeaveId: null })
    expect(d.status).toBe('late'); expect(d.lateMinutes).toBe(35) // 08:45 - 08:10
  })
  it('aucun pointage jour ouvré sans congé → absence injustifiée', () => {
    const d = computeDay({ workDate: '2026-07-08', punches: [], schedule: sched, isHoliday: false, approvedLeaveId: null })
    expect(d.status).toBe('absent_unjustified')
  })
  it('aucun pointage mais congé approuvé → justifié', () => {
    const d = computeDay({ workDate: '2026-07-08', punches: [], schedule: sched, isHoliday: false, approvedLeaveId: 'leave-1' })
    expect(d.status).toBe('absent_justified'); expect(d.justifiedBy).toBe('leave-1')
  })
  it('jour férié → off', () => {
    const d = computeDay({ workDate: '2026-07-07', punches: [], schedule: sched, isHoliday: true, approvedLeaveId: null })
    expect(d.status).toBe('off')
  })
  it('week-end (hors workdays) → off', () => { // 2026-07-11 = samedi
    const d = computeDay({ workDate: '2026-07-11', punches: [], schedule: sched, isHoliday: false, approvedLeaveId: null })
    expect(d.status).toBe('off')
  })
})
