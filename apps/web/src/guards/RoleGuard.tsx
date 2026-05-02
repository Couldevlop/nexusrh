import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import type { UserRole } from '@nexusrh/shared'

interface RoleGuardProps {
  children: React.ReactNode
  allowedRoles: UserRole[]
  redirectTo?: string
}

export function RoleGuard({
  children,
  allowedRoles,
  redirectTo = '/dashboard',
}: RoleGuardProps) {
  const { user, isAuthenticated } = useAuthStore()

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />
  }

  if (!allowedRoles.includes(user.role)) {
    return <Navigate to={redirectTo} replace />
  }

  return <>{children}</>
}
