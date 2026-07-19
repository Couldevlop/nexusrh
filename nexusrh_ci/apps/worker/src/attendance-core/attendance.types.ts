// COPIE VERBATIM de apps/api/src/modules/attendance/attendance.types.ts — garder
// synchronisé (le worker ne peut pas importer le package api).
export type PunchDirection = 'in' | 'out' | 'unknown'
export interface NormalizedPunch {
  rawEmployeeRef: string
  punchedAt: Date
  direction: PunchDirection
  dedupKey: string
  raw: unknown
}
export interface FieldMapping {
  recordsPath?: string
  employeePath: string
  employeeMatchBy: 'matricule' | 'email' | 'badge_id'
  timestampPath: string
  timestampFormat: 'iso8601' | 'epoch_s' | 'epoch_ms' | string
  directionPath?: string
  directionInValue?: string
  directionOutValue?: string
}
export interface EffectiveSchedule {
  expectedStart: string   // 'HH:MM'
  toleranceMin: number
  expectedEnd: string | null
  workdays: number[]      // 1=lun … 7=dim
}
export type DayStatus = 'present' | 'late' | 'absent_unjustified' | 'absent_justified' | 'off'
export interface ComputedDay {
  workDate: string        // 'YYYY-MM-DD'
  firstIn: Date | null
  lastOut: Date | null
  lateMinutes: number
  status: DayStatus
  justifiedBy: string | null
}
export interface AttendanceConfig {
  lateMinutesTier1: number; occurrencesTier1: number
  lateMinutesTier2: number; occurrencesTier2: number
  unjustifiedAbsenceOccurrences: number
  warningsBeforeSanction: number
  windowMode: 'consecutive_or_month'
}
export type WarningTier = 'avertissement' | 'demande_explication'
export interface GeneratedWarning {
  employeeId: string
  tier: WarningTier
  triggerReason: string
  occurrenceDates: string[]
}
export interface EscalationResult {
  warnings: GeneratedWarning[]
  sanctionDrafts: Array<{ employeeId: string; reason: string; description: string }>
}
