export interface ApiResponse<T = unknown> {
  data: T
  message?: string
}

export interface ApiError {
  statusCode: number
  error: string
  message: string
  details?: unknown
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginationParams {
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  search?: string
}

export interface DashboardKPIs {
  activeEmployees: number
  activeEmployeesDelta: number
  monthlySalaryMass: number
  monthlySalaryMassDelta: number
  absenteeismRate: number
  absenteeismRateDelta: number
  openPositions: number
  openPositionsDelta: number
}

export interface DashboardData {
  kpis: DashboardKPIs
  headcountTrend: Array<{ month: string; count: number }>
  salaryByDepartment: Array<{ department: string; amount: number }>
  aiInsights: Array<{
    type: 'warning' | 'info' | 'success'
    message: string
    action?: string
    actionUrl?: string
  }>
  todayAbsences: Array<{
    employeeId: string
    firstName: string
    lastName: string
    photoUrl?: string
    absenceType: string
  }>
  upcomingBirthdays: Array<{
    employeeId: string
    firstName: string
    lastName: string
    photoUrl?: string
    birthDate: string
  }>
  monthlyEvents: Array<{
    type: 'hire' | 'departure'
    employeeId: string
    firstName: string
    lastName: string
    date: string
  }>
}
