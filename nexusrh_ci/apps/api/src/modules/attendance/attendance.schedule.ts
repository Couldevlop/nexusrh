import type { EffectiveSchedule } from './attendance.types.js'

type Sched = EffectiveSchedule

export function resolveSchedule(input: {
  employee?: Sched | null
  department?: Sched | null
  tenant: Sched
}): EffectiveSchedule {
  // Cascade: employee > department > tenant
  if (input.employee) {
    return input.employee
  }
  if (input.department) {
    return input.department
  }
  return input.tenant
}
