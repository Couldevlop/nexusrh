import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Building2, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

interface Tenant {
  id: string; name: string; slug: string; schema_name: string
  plan_type: string; status: string; city: string; sector: string
  max_users: number; max_employees: number; created_at: string
  // PLT-007 — compteurs réels renvoyés par l'API
  user_count?: number; employee_count?: number
}

const STATUS_FILTERS = ['', 'active', 'trial', 'suspended'] as const

export default function PlatformTenants() {
  const { t: tt } = useTranslation('platform')
  const navigate = useNavigate()
  // PLT-008 — filtre par statut (alimente la requête API ?status=)
  const [status, setStatus] = useState<string>('')

  const { data, isLoading } = useQuery<{ data: Tenant[]; total: number }>({
    queryKey: ['platform-tenants-list', status],
    queryFn: () => api.get(`/platform/tenants?limit=50${status ? `&status=${status}` : ''}`).then(r => r.data),
  })

  const tenants = data?.data ?? []

  const statusColor: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    trial: 'bg-yellow-100 text-yellow-700',
    suspended: 'bg-red-100 text-red-700',
  }
  const statusLabel: Record<string, string> = {
    active: tt('status.active'), trial: tt('status.trial'), suspended: tt('status.suspended'),
  }
  const filterLabel: Record<string, string> = {
    '': 'Tous les statuts', active: tt('status.active'), trial: tt('status.trial'), suspended: tt('status.suspended'),
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tt('tenants.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{tt('tenants.count', { count: data?.total ?? 0 })}</p>
        </div>
        <button
          onClick={() => navigate('/platform/tenants/new')}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {tt('tenants.newButton')}
        </button>
      </div>

      {/* PLT-008 — filtre par statut */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Statut :</span>
        {STATUS_FILTERS.map(s => (
          <button
            key={s || 'all'}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              status === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {filterLabel[s]}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="p-4">{tt('tenants.table.company')}</th>
                <th className="p-4">{tt('tenants.table.cityCategory')}</th>
                <th className="p-4">{tt('tenants.table.plan')}</th>
                <th className="p-4 text-right">Utilisateurs</th>
                <th className="p-4 text-right">Employés</th>
                <th className="p-4">{tt('tenants.table.status')}</th>
                <th className="p-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tenants.map(t => (
                <tr key={t.id} className="hover:bg-muted/40">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
                        {t.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium">{t.name}</p>
                        <p className="text-xs text-muted-foreground">{t.slug}</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-4 text-muted-foreground">
                    {t.city ?? '—'} · {t.sector ?? '—'}
                  </td>
                  {/* plan_type is an API key, kept verbatim with capitalize styling */}
                  <td className="p-4">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize">
                      {t.plan_type}
                    </span>
                  </td>
                  {/* PLT-007 — effectif RÉEL / quota du plan */}
                  <td className="p-4 text-right text-muted-foreground">
                    {t.user_count ?? 0} <span className="text-xs opacity-60">/ {t.max_users}</span>
                  </td>
                  <td className="p-4 text-right text-muted-foreground">
                    {t.employee_count ?? 0} <span className="text-xs opacity-60">/ {t.max_employees}</span>
                  </td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[t.status] ?? ''}`}>
                      {statusLabel[t.status] ?? t.status}
                    </span>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => navigate(`/platform/tenants/${t.id}`)}
                      className="text-xs text-primary hover:underline"
                    >
                      {tt('common.manage')}
                    </button>
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-12 text-center text-muted-foreground">
                    <Building2 className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p>{tt('tenants.empty')}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
