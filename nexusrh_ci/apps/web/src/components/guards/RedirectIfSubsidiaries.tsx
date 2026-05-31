import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

/**
 * Garde de routage : pour un tenant À FILIALES (tenantConfig.hasSubsidiaries),
 * la « Paie multi-filiales » couvre l'intégralité de la paie. La page de paie
 * mono-filiale ne doit donc plus être accessible — ni par l'onglet (masqué dans
 * la Sidebar), ni par URL directe (défense en profondeur, OWASP A01).
 *
 * Rendu :
 *  - tenant à filiales  → redirection vers `to` (par défaut /payroll/multi-filiales)
 *  - tenant mono-filiale → affiche les enfants (la page de paie standard)
 */
export function RedirectIfSubsidiaries({
  children,
  to = '/payroll/multi-filiales',
}: {
  children: React.ReactNode
  to?: string
}) {
  const hasSubsidiaries = useAuthStore(s => s.tenantConfig?.hasSubsidiaries === true)
  if (hasSubsidiaries) return <Navigate to={to} replace />
  return <>{children}</>
}
