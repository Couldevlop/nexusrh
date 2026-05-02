import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Building2, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

interface Tenant {
  id: string; name: string; slug: string; schema_name: string
  plan_type: string; status: string; city: string; sector: string
  max_users: number; max_employees: number; created_at: string
}

export default function PlatformTenants() {
  const navigate = useNavigate()

  const { data, isLoading } = useQuery<{ data: Tenant[]; total: number }>({
    queryKey: ['platform-tenants-list'],
    queryFn: () => api.get('/platform/tenants?limit=50').then(r => r.data),
  })

  const tenants = data?.data ?? []

  const statusColor: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    trial: 'bg-yellow-100 text-yellow-700',
    suspended: 'bg-red-100 text-red-700',
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tenants</h1>
          <p className="text-sm text-muted-foreground mt-1">{data?.total ?? 0} entreprise(s) enregistrée(s)</p>
        </div>
        <button
          onClick={() => navigate('/platform/tenants/new')}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Nouveau tenant
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="p-4">Entreprise</th>
                <th className="p-4">Ville · Secteur</th>
                <th className="p-4">Plan</th>
                <th className="p-4 text-right">Max employés</th>
                <th className="p-4">Statut</th>
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
                  <td className="p-4">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize">
                      {t.plan_type}
                    </span>
                  </td>
                  <td className="p-4 text-right text-muted-foreground">{t.max_employees}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[t.status] ?? ''}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => navigate(`/platform/tenants/${t.id}`)}
                      className="text-xs text-primary hover:underline"
                    >
                      Gérer
                    </button>
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-muted-foreground">
                    <Building2 className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p>Aucun tenant créé</p>
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
