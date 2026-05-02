import { Navigate } from 'react-router-dom'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

type Role = AuthUser['role']

interface RoleGuardProps {
  children: React.ReactNode
  allowedRoles: Role[]
  redirectTo?: string
}

export function RoleGuard({ children, allowedRoles, redirectTo = '/dashboard' }: RoleGuardProps) {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (!allowedRoles.includes(user.role)) return <Navigate to={redirectTo} replace />
  return <>{children}</>
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated())
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export function PlatformGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'super_admin') return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export function EmployeeGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'employee') return <>{children}</>
  return <Navigate to="/dashboard" replace />
}
