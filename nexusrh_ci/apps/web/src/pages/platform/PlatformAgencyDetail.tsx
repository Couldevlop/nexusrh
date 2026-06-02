import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Building2, Plus, Trash2, Ban, CheckCircle } from 'lucide-react'
import { api } from '@/lib/api'

interface AgencyDetail {
  id: string; name: string; slug: string; status: string; city: string | null
  users: Array<{ id: string; email: string; first_name: string; last_name: string; role: string; is_active: boolean }>
  tenants: Array<{ id: string; name: string; slug: string; city: string | null; status: string; default_country_code: string }>
}
interface TenantOption { id: string; name: string; default_country_code: string }

export default function PlatformAgencyDetail() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [attachId, setAttachId] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: AgencyDetail }>({
    queryKey: ['platform-agency', id],
    queryFn: () => api.get(`/agency/agencies/${id}`).then((r) => r.data),
    enabled: !!id,
  })
  const { data: allTenants } = useQuery<{ data: TenantOption[] }>({
    queryKey: ['platform-tenants-all'],
    queryFn: () => api.get('/platform/tenants?limit=200').then((r) => r.data),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-agency', id] })

  const attach = useMutation({
    mutationFn: () => api.post(`/agency/agencies/${id}/tenants`, { tenantId: attachId }).then((r) => r.data),
    onSuccess: () => { setMsg('Entreprise rattachée ✓'); setAttachId(''); invalidate() },
    onError: (err: unknown) => setMsg((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Erreur'),
  })
  const detach = useMutation({
    mutationFn: (tenantId: string) => api.delete(`/agency/agencies/${id}/tenants/${tenantId}`).then((r) => r.data),
    onSuccess: () => { setMsg('Entreprise détachée'); invalidate() },
  })
  const suspend = useMutation({
    mutationFn: () => api.post(`/agency/agencies/${id}/suspend`, {}).then((r) => r.data),
    onSuccess: () => { setMsg('Cabinet suspendu'); invalidate() },
  })
  const reactivate = useMutation({
    mutationFn: () => api.post(`/agency/agencies/${id}/reactivate`, {}).then((r) => r.data),
    onSuccess: () => { setMsg('Cabinet réactivé'); invalidate() },
  })

  if (isLoading || !data) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
  const a = data.data
  const attachableTenants = (allTenants?.data ?? []).filter(
    (t) => ['CIV', 'CI'].includes((t.default_country_code ?? '').toUpperCase())
      && !a.tenants.some((at) => at.id === t.id))

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <Link to="/platform/agencies" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Cabinets</Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{a.name}</h1>
          <p className="text-sm text-muted-foreground">{a.city ?? 'Côte d\'Ivoire'} · {a.status === 'active' ? 'Actif' : 'Suspendu'}</p>
        </div>
        {a.status === 'active'
          ? <button onClick={() => suspend.mutate()} className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"><Ban className="h-4 w-4" /> Suspendre</button>
          : <button onClick={() => reactivate.mutate()} className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50"><CheckCircle className="h-4 w-4" /> Réactiver</button>}
      </div>

      {msg && <div className="rounded-lg bg-muted px-4 py-2 text-sm">{msg}</div>}

      {/* Entreprises rattachées */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold">Entreprises clientes</h2>
        <div className="mb-4 flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Rattacher une entreprise (CI)</label>
            <select value={attachId} onChange={(e) => setAttachId(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value="">— Choisir une entreprise —</option>
              {attachableTenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <button onClick={() => attach.mutate()} disabled={!attachId || attach.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {attach.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Rattacher
          </button>
        </div>
        <div className="space-y-2">
          {a.tenants.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.city ?? 'CI'}</span>
              <button onClick={() => detach.mutate(t.id)} className="text-muted-foreground hover:text-red-600" title="Détacher"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {a.tenants.length === 0 && <p className="text-sm text-muted-foreground">Aucune entreprise rattachée.</p>}
        </div>
      </div>

      {/* Membres */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold">Membres</h2>
        <div className="space-y-2">
          {a.users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <span className="flex-1">{u.first_name} {u.last_name} <span className="text-muted-foreground">· {u.email}</span></span>
              <span className="text-xs">{u.role === 'agency_owner' ? 'Propriétaire' : 'Recruteur'}</span>
              <span className={u.is_active ? 'text-emerald-600 text-xs' : 'text-red-500 text-xs'}>{u.is_active ? 'Actif' : 'Inactif'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
