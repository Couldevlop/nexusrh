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

// Portail cabinet de recrutement : accessible aux utilisateurs cabinet en
// CONTEXTE cabinet (pas en session scopée sur un tenant — dans ce cas l'app RH
// normale prend le relais via le rôle 'admin' délégué).
export function AgencyGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const activeTenant = useAuthStore((s) => s.activeTenant)
  if (!user) return <Navigate to="/login" replace />
  if (user.actorType !== 'agency') return <Navigate to="/dashboard" replace />
  // En session scopée → rediriger vers l'app RH du tenant client.
  if (activeTenant) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}
