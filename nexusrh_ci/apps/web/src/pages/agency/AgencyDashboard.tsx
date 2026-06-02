import { useQuery } from '@tanstack/react-query'
import { Building2, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { TenantSwitcher } from '@/components/agency/TenantSwitcher'

export default function AgencyDashboard() {
  const user = useAuthStore((s) => s.user)
  const isOwner = user?.role === 'agency_owner'

  const { data: tenants } = useQuery<{ data: unknown[] }>({
    queryKey: ['agency-my-tenants'],
    queryFn: () => api.get('/agency/my-tenants').then((r) => r.data),
  })
  const { data: members } = useQuery<{ data: unknown[] }>({
    queryKey: ['agency-members'],
    queryFn: () => api.get('/agency/members').then((r) => r.data),
    enabled: isOwner,
  })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Tableau de bord cabinet</h1>
        <p className="text-sm text-muted-foreground">Pilotez vos entreprises clientes et votre équipe.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600"><Building2 className="h-6 w-6" /></div>
          <div>
            <p className="text-2xl font-bold">{tenants?.data?.length ?? 0}</p>
            <p className="text-sm text-muted-foreground">Entreprises clientes</p>
          </div>
        </div>
        {isOwner && (
          <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600"><Users className="h-6 w-6" /></div>
            <div>
              <p className="text-2xl font-bold">{members?.data?.length ?? 0}</p>
              <p className="text-sm text-muted-foreground">Membres du cabinet</p>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold">Accéder à une entreprise cliente</h2>
        <p className="mb-4 text-sm text-muted-foreground">Sélectionnez une entreprise pour gérer ses ressources humaines en son nom.</p>
        <TenantSwitcher />
      </div>
    </div>
  )
}
