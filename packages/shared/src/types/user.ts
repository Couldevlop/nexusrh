export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'hr_manager'
  | 'hr_officer'
  | 'manager'
  | 'employee'
  | 'readonly'
  | 'payroll_service'

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  role: UserRole
  employeeId?: string
  mfaEnabled: boolean
  avatarUrl?: string
  lastLoginAt?: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface LoginCredentials {
  email: string
  password: string
  mfaCode?: string
}

export interface JwtPayload {
  sub: string
  userId: string
  email: string
  role: UserRole
  employeeId?: string
  tenantId?: string
  schemaName?: string
  iat?: number
  exp?: number
}

export interface TenantConfig {
  id: string
  name: string
  slug: string
  primaryColor: string
  secondaryColor: string
  logoUrl?: string
  planType: string
}
