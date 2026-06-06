import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, ChevronRight, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore, type TenantConfig } from '@/stores/authStore'

interface ClientTenant {
  id: string; name: string; slug: string; city: string | null
  primary_color: string | null; logo_url: string | null; plan_type: string
}

/**
 * Sélecteur d'entreprise cliente d'un cabinet. Active une session scopée
 * (token admin délégué) sur le tenant choisi puis bascule vers l'app RH.
 */
export function TenantSwitcher() {
  const navigate = useNavigate()
  const { t: tt } = useTranslation('agency')
  const activateTenant = useAuthStore((s) => s.activateTenant)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: ClientTenant[] }>({
    queryKey: ['agency-my-tenants'],
    queryFn: () => api.get('/agency/my-tenants').then((r) => r.data),
  })

  const onSelect = async (t: ClientTenant) => {
    setBusy(t.id); setError(null)
    try {
      const res = await api.post<{ token: string; tenantConfig: TenantConfig }>(
        '/agency/sessions/activate', { tenantId: t.id })
      activateTenant(res.data.token, res.data.tenantConfig)
      navigate('/dashboard', { replace: true })
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } } }
      setError(ax.response?.data?.error ?? tt('tenantSwitcher.accessDenied'))
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {tt('tenantSwitcher.loading')}</div>
  }

  const tenants = data?.data ?? []
  if (tenants.length === 0) {
    return <p className="text-sm text-muted-foreground">{tt('tenantSwitcher.empty')}</p>
  }

  return (
    <div className="space-y-2">
      {error && <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-700">{error}</div>}
      {tenants.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t)}
          disabled={!!busy}
          className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-primary hover:shadow-sm disabled:opacity-60"
        >
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-muted">
            {t.logo_url ? <img src={t.logo_url} alt="" className="h-full w-full object-contain" /> : <Building2 className="h-5 w-5 text-muted-foreground" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-semibold">{t.name}</p>
            <p className="truncate text-xs text-muted-foreground">{t.city ?? tt('common.ci')} · {t.plan_type}</p>
          </div>
          {busy === t.id ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>
      ))}
    </div>
  )
}
