import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Composant de redirection intelligent basé sur le rôle.
 * Pour super_admin : vérifie si l'onboarding est requis avant de router.
 * Placé sur la route "/" pour router vers la bonne destination.
 */
export function RootRedirect() {
  const { isAuthenticated, user } = useAuthStore()

  const { data: onboardingStatus, isLoading: checkingOnboarding } = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const { data } = await api.get('/platform/onboarding-status')
      return data.data as { onboardingCompleted: boolean; tenantCount: number; needsOnboarding: boolean }
    },
    enabled: isAuthenticated && user?.role === 'super_admin',
    retry: false,
    staleTime: 30_000,
  })

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />
  }

  if (user.role === 'super_admin') {
    if (checkingOnboarding) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-500">Chargement...</p>
          </div>
        </div>
      )
    }
    if (onboardingStatus?.needsOnboarding) {
      return <Navigate to="/platform/onboarding" replace />
    }
    return <Navigate to="/platform/dashboard" replace />
  }

  switch (user.role) {
    case 'employee':
      return <Navigate to="/mon-espace" replace />
    case 'payroll_service':
      return <Navigate to="/payroll" replace />
    default:
      return <Navigate to="/dashboard" replace />
  }
}
