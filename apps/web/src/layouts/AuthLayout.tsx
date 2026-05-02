import { useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

export function AuthLayout() {
  const { isAuthenticated, user } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (isAuthenticated && user) {
      if (user.role === 'super_admin') navigate('/platform/dashboard', { replace: true })
      else if (user.role === 'employee') navigate('/mon-espace', { replace: true })
      else navigate('/dashboard', { replace: true })
    }
  }, [isAuthenticated, user, navigate])

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-indigo-900 to-purple-900">
      <Outlet />
    </div>
  )
}
