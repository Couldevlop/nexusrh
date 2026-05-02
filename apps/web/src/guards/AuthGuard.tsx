import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

interface AuthGuardProps {
  children: React.ReactNode
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, user } = useAuthStore()

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />
  }

  if (user.role === 'super_admin') {
    return <Navigate to="/platform/dashboard" replace />
  }

  if (user.role === 'employee') {
    return <Navigate to="/mon-espace" replace />
  }

  return <>{children}</>
}
