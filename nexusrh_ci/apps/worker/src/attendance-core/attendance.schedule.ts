// COPIE VERBATIM de apps/api/src/modules/attendance/attendance.schedule.ts — garder
// synchronisé (le worker ne peut pas importer le package api).
import type { EffectiveSchedule } from './attendance.types.js'

type Sched = EffectiveSchedule

export function resolveSchedule(input: {
  employee?: Sched | null
  department?: Sched | null
  tenant: Sched
}): EffectiveSchedule {
  // Cascade: employee > department > tenant
  if (input.employee != null) {
    return input.employee
  }
  if (input.department != null) {
    return input.department
  }
  return input.tenant
}
