import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { isModuleEnabled, type ModuleKey } from '@/lib/modules'

interface ModuleGuardProps {
  children: React.ReactNode
  /** Module activable (piloté par le super_admin — voir lib/modules.ts). */
  moduleKey: ModuleKey
  redirectTo?: string
}

/**
 * Garde de module : redirige si le module est désactivé pour le tenant courant.
 * Le frontend ne fait que MASQUER l'accès — le blocage réel reste le hook API
 * global (403 { moduleDisabled: true, module }).
 */
export function ModuleGuard({ children, moduleKey, redirectTo = '/dashboard' }: ModuleGuardProps) {
  const tenantConfig = useAuthStore((s) => s.tenantConfig)
  if (!isModuleEnabled(tenantConfig, moduleKey)) return <Navigate to={redirectTo} replace />
  return <>{children}</>
}
