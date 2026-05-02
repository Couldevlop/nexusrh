import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import type { User, TenantConfig } from '@nexusrh/shared'

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: User
  requiresMfa?: boolean
  tenantConfig?: TenantConfig
}

export function useLogin() {
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()

  return useMutation({
    mutationFn: async (credentials: {
      email: string
      password: string
      mfaCode?: string
    }) => {
      const response = await api.post<LoginResponse>('/auth/login', credentials)
      return response.data
    },
    onSuccess: (data) => {
      if (data.requiresMfa) return // Géré par le composant
      setAuth(data.user, data.accessToken, data.refreshToken, data.tenantConfig)
      const role = data.user.role
      if (role === 'super_admin') navigate('/platform/dashboard', { replace: true })
      else if (role === 'employee') navigate('/mon-espace', { replace: true })
      else navigate('/dashboard', { replace: true })
    },
  })
}

export function useLogout() {
  const { logout, refreshToken } = useAuthStore()
  const navigate = useNavigate()

  return useMutation({
    mutationFn: async () => {
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken }).catch(() => {})
      }
    },
    onSettled: () => {
      logout()
      navigate('/login')
    },
  })
}

export function useCurrentUser() {
  const { user, isAuthenticated } = useAuthStore()
  return { user, isAuthenticated }
}
