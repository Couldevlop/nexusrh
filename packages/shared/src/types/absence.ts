export type AbsenceCategory =
  | 'paid_leave'
  | 'rtt'
  | 'sick'
  | 'maternity'
  | 'paternity'
  | 'family'
  | 'unpaid'
  | 'other'

export type AbsenceStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface AbsenceType {
  id: string
  entityId: string
  code: string
  label: string
  category: AbsenceCategory
  countingUnit: 'working_days' | 'calendar_days' | 'hours'
  requiresJustification: boolean
  requiresApproval: boolean
  isPaid: boolean
  impactsPayroll: boolean
  isActive: boolean
  color: string
  maxDaysPerYear?: string
}

export interface AbsenceBalance {
  id: string
  employeeId: string
  absenceTypeId: string
  periodLabel: string
  acquired: string
  taken: string
  pending: string
  carried: string
  updatedAt: string
  absenceType?: AbsenceType
}

export interface Absence {
  id: string
  employeeId: string
  absenceTypeId: string
  startDate: string
  endDate: string
  startHalf?: 'morning' | 'afternoon'
  endHalf?: 'morning' | 'afternoon'
  daysCount: string
  reason?: string
  justificationUrl?: string
  status: AbsenceStatus
  approvedBy?: string
  approvedAt?: string
  rejectionReason?: string
  payrollImpact?: Record<string, unknown>
  requestedAt: string
  createdAt: string
  absenceType?: AbsenceType
}

export interface CreateAbsenceInput {
  employeeId: string
  absenceTypeId: string
  startDate: string
  endDate: string
  startHalf?: 'morning' | 'afternoon'
  endHalf?: 'morning' | 'afternoon'
  reason?: string
}
