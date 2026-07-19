// COPIE VERBATIM de apps/api/src/modules/attendance/attendance.schedule.test.ts — garder
// synchronisé (le worker ne peut pas importer le package api).
import { it, expect } from 'vitest'
import { resolveSchedule } from './attendance.schedule.js'

it('employé > département > tenant', () => {
  const t = { expectedStart: '08:00', toleranceMin: 10, expectedEnd: null, workdays: [1, 2, 3, 4, 5] }
  const d = { ...t, expectedStart: '09:00' }
  const e = { ...t, expectedStart: '07:30' }
  expect(resolveSchedule({ employee: e, department: d, tenant: t }).expectedStart).toBe('07:30')
  expect(resolveSchedule({ employee: null, department: d, tenant: t }).expectedStart).toBe('09:00')
  expect(resolveSchedule({ tenant: t }).expectedStart).toBe('08:00')
})
