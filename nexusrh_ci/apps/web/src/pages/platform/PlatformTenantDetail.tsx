import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { ArrowLeft, Power, RefreshCw } from 'lucide-react'
import { useState } from 'react'

interface Tenant {
  id: string; name: string; slug: string; schema_name: string
  plan_type: string; status: string; city: string; sector: string
  at_rate: string; cnps_number: string; dgi_number: string
  max_users: number; max_employees: number
  primary_color: string; secondary_color: string
  created_at: string; trial_ends_at: string | null
  has_subsidiaries?: boolean
  payroll_mode?: 'single_country' | 'multi_country'
  default_country_code?: string
}

export default function PlatformTenantDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [resetResult, setResetResult] = useState<{ tempPassword: string; adminEmail: string } | null>(null)

  const { data, isLoading } = useQuery<{ data: Tenant }>({
    queryKey: ['tenant', id],
    queryFn: () => api.get(`/platform/tenants/${id}`).then(r => r.data),
  })

  const suspendMut = useMutation({
    mutationFn: () => api.post(`/platform/tenants/${id}/suspend`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant', id] }),
  })

  const reactivateMut = useMutation({
    mutationFn: () => api.post(`/platform/tenants/${id}/reactivate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant', id] }),
  })

  const resetMut = useMutation({
    mutationFn: () => api.post(`/platform/tenants/${id}/reset-admin`),
    onSuccess: (res) => setResetResult(res.data as { tempPassword: string; adminEmail: string }),
  })

  const tenant = data?.data
  if (isLoading) return <div className="p-6 text-center text-muted-foreground">Chargement...</div>
  if (!tenant)   return <div className="p-6 text-center text-destructive">Tenant introuvable</div>

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/platform/tenants')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Retour aux tenants
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground"
            style={{ backgroundColor: tenant.primary_color }}>
            {tenant.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-bold">{tenant.name}</h1>
            <p className="text-sm text-muted-foreground">{tenant.slug} · {tenant.schema_name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tenant.has_subsidiaries && (
            <span className="rounded-full bg-purple-100 px-3 py-1 text-xs font-medium text-purple-700">
              Multi-pays · {tenant.default_country_code ?? 'CIV'}
            </span>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${
            tenant.status === 'active' ? 'bg-green-100 text-green-700' :
            tenant.status === 'trial'  ? 'bg-yellow-100 text-yellow-700' :
            'bg-red-100 text-red-700'
          }`}>
            {tenant.status}
          </span>
        </div>
      </div>

      {/* Infos */}
      <div className="grid grid-cols-2 gap-4">
        {[
          ['Ville', tenant.city],
          ['Secteur', tenant.sector],
          ['Plan', tenant.plan_type],
          ['Taux AT CNPS', `${(parseFloat(tenant.at_rate) * 100).toFixed(1)} %`],
          ['N° CNPS', tenant.cnps_number ?? '—'],
          ['N° DGI', tenant.dgi_number ?? '—'],
          ['Max utilisateurs', String(tenant.max_users)],
          ['Max employés', String(tenant.max_employees)],
          ['Mode paie', tenant.payroll_mode === 'multi_country' ? 'Multi-pays (centralisée)' : 'Mono-pays (CI)'],
          ['Pays principal', tenant.default_country_code ?? 'CIV'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-sm font-medium mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* Toggle filiales (réactif) */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-3">Structure multi-pays</h2>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={tenant.has_subsidiaries ?? false}
            onChange={(e) => api.patch(`/platform/tenants/${id}`, {
              has_subsidiaries: e.target.checked,
              payroll_mode: e.target.checked ? 'multi_country' : 'single_country',
            }).then(() => queryClient.invalidateQueries({ queryKey: ['tenant', id] }))}
            className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">Activer la gestion multi-pays / filiales</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tenant.has_subsidiaries
                ? 'Le tenant utilise des packs législatifs par pays et le workflow paie centralisé draft → RAF site → central.'
                : 'Tenant mono-pays Côte d\'Ivoire : moteur paie CI 2024 standard, pas d\'onglet « Filiales & législations ».'}
            </p>
          </div>
        </label>
      </div>

      {/* Actions */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4">Actions</h2>
        <div className="flex flex-wrap gap-3">
          {tenant.status !== 'suspended' ? (
            <button
              onClick={() => suspendMut.mutate()}
              disabled={suspendMut.isPending}
              className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">
              <Power className="h-4 w-4" />
              Suspendre
            </button>
          ) : (
            <button
              onClick={() => reactivateMut.mutate()}
              disabled={reactivateMut.isPending}
              className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50">
              <Power className="h-4 w-4" />
              Réactiver
            </button>
          )}

          <button
            onClick={() => resetMut.mutate()}
            disabled={resetMut.isPending}
            className="flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50">
            <RefreshCw className="h-4 w-4" />
            Réinitialiser mot de passe admin
          </button>
        </div>

        {resetResult && (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm">
            <p className="font-medium text-green-800 mb-1">Mot de passe réinitialisé</p>
            <p>Email : <strong>{resetResult.adminEmail}</strong></p>
            <p>Nouveau mot de passe : <code className="rounded bg-white px-1 font-mono">{resetResult.tempPassword}</code></p>
          </div>
        )}
      </div>

      {/* Thème */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4">Thème</h2>
        <div className="flex gap-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg border" style={{ backgroundColor: tenant.primary_color }} />
            <div>
              <p className="text-xs text-muted-foreground">Couleur primaire</p>
              <p className="text-sm font-mono">{tenant.primary_color}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg border" style={{ backgroundColor: tenant.secondary_color }} />
            <div>
              <p className="text-xs text-muted-foreground">Couleur secondaire</p>
              <p className="text-sm font-mono">{tenant.secondary_color}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
