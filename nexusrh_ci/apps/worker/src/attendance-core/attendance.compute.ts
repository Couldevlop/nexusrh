// COPIE VERBATIM de apps/api/src/modules/attendance/attendance.compute.ts — garder
// synchronisé (le worker ne peut pas importer le package api).
import type { ComputedDay, DayStatus, EffectiveSchedule, NormalizedPunch } from './attendance.types.js'

export interface ComputeDayInput {
  workDate: string
  punches: NormalizedPunch[]
  schedule: EffectiveSchedule
  isHoliday: boolean
  approvedLeaveId: string | null
}

/**
 * Renvoie le jour ISO 1=lundi … 7=dimanche pour une date 'YYYY-MM-DD'.
 * Défensif : une date malformée retourne NaN plutôt que de lever.
 */
function isoWeekday(workDate: string): number {
  const parsed = new Date(`${workDate}T00:00:00Z`)
  const day = parsed.getUTCDay()
  if (Number.isNaN(day)) return NaN
  return day === 0 ? 7 : day
}

/**
 * Calcule l'instant seuil (début attendu + tolérance) en UTC pour workDate.
 * Défensif : renvoie NaN si expectedStart est malformé plutôt que de lever.
 */
function thresholdInstant(workDate: string, expectedStart: string, toleranceMin: number): number {
  const match = /^(\d{2}):(\d{2})$/.exec(expectedStart)
  if (!match) return NaN
  const base = Date.parse(`${workDate}T${match[1]}:${match[2]}:00Z`)
  if (Number.isNaN(base)) return NaN
  return base + toleranceMin * 60_000
}

function pickFirstIn(punches: NormalizedPunch[]): Date | null {
  if (punches.length === 0) return null
  const ins = punches.filter((p) => p.direction === 'in')
  const pool = ins.length > 0 ? ins : punches
  return pool.reduce((earliest, p) => (p.punchedAt < earliest.punchedAt ? p : earliest)).punchedAt
}

function pickLastOut(punches: NormalizedPunch[]): Date | null {
  if (punches.length === 0) return null
  const outs = punches.filter((p) => p.direction === 'out')
  const pool = outs.length > 0 ? outs : punches
  return pool.reduce((latest, p) => (p.punchedAt > latest.punchedAt ? p : latest)).punchedAt
}

export function computeDay(input: ComputeDayInput): ComputedDay {
  const { workDate, punches, schedule, isHoliday, approvedLeaveId } = input
  const safePunches = Array.isArray(punches) ? punches : []

  const weekday = isoWeekday(workDate)
  const isWorkday = Array.isArray(schedule?.workdays) && schedule.workdays.includes(weekday)

  if (!isWorkday || isHoliday) {
    return { workDate, firstIn: null, lastOut: null, lateMinutes: 0, status: 'off', justifiedBy: null }
  }

  const firstIn = pickFirstIn(safePunches)
  const lastOut = pickLastOut(safePunches)

  if (!firstIn) {
    const status: DayStatus = approvedLeaveId ? 'absent_justified' : 'absent_unjustified'
    return { workDate, firstIn: null, lastOut: null, lateMinutes: 0, status, justifiedBy: approvedLeaveId ?? null }
  }

  const threshold = thresholdInstant(workDate, schedule.expectedStart, schedule.toleranceMin)
  const diffMs = firstIn.getTime() - threshold
  const lateMinutes = Number.isNaN(diffMs) ? 0 : Math.max(0, Math.round(diffMs / 60_000))
  const status: DayStatus = lateMinutes > 0 ? 'late' : 'present'

  return { workDate, firstIn, lastOut, lateMinutes, status, justifiedBy: null }
}
