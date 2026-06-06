import { useNavigate } from 'react-router-dom'
import { Briefcase, LogOut } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/authStore'

/**
 * Bannière permanente affichée quand un cabinet agit AU NOM d'une entreprise
 * cliente (session scopée). Permet de quitter et revenir au portail cabinet.
 * OWASP A09 — rend l'action « on-behalf » visible en permanence.
 */
export function ActingAsBanner() {
  const navigate = useNavigate()
  const { t } = useTranslation('agency')
  const activeTenant = useAuthStore((s) => s.activeTenant)
  const agencyConfig = useAuthStore((s) => s.agencyConfig)
  const deactivateTenant = useAuthStore((s) => s.deactivateTenant)

  if (!activeTenant) return null

  const onLeave = () => {
    deactivateTenant()
    navigate('/agency/dashboard', { replace: true })
  }

  return (
    <div className="flex items-center gap-3 bg-indigo-600 px-4 py-2 text-sm font-medium text-white">
      <Briefcase className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">
        <Trans
          i18nKey="actingAsBanner.actingFor"
          t={t}
          values={{ tenant: activeTenant.name }}
          components={[<strong />]}
        />
        {agencyConfig?.name ? (
          <Trans
            i18nKey="actingAsBanner.viaAgency"
            t={t}
            values={{ agency: agencyConfig.name }}
            components={[<strong />]}
          />
        ) : null}
      </span>
      <button onClick={onLeave} className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1 text-xs font-semibold hover:bg-white/25">
        <LogOut className="h-3.5 w-3.5" /> {t('actingAsBanner.leave')}
      </button>
    </div>
  )
}
