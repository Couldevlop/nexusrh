import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Building2, Plus, Trash2, Ban, CheckCircle } from 'lucide-react'
import { api } from '@/lib/api'

interface AgencyDetail {
  id: string; name: string; slug: string; status: string; city: string | null
  offline_message?: string | null
  users: Array<{ id: string; email: string; first_name: string; last_name: string; role: string; is_active: boolean }>
  tenants: Array<{ id: string; name: string; slug: string; city: string | null; status: string; default_country_code: string }>
}
interface TenantOption { id: string; name: string; default_country_code: string }
interface OfflinePolicySettings {
  offline_message_default?: string
  offline_message_required?: boolean
}

export default function PlatformAgencyDetail() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [attachId, setAttachId] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [showOfflineDialog, setShowOfflineDialog] = useState(false)
  const [offlineMessage, setOfflineMessage] = useState('')
  const [includeClients, setIncludeClients] = useState(false)

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
  // Variable système : message hors-ligne par défaut + caractère obligatoire.
  const { data: settingsData } = useQuery<{ data: OfflinePolicySettings }>({
    queryKey: ['platform-settings'],
    queryFn: () => api.get('/platform/settings').then((r) => r.data),
    staleTime: 60_000,
  })
  const offlineDefault = settingsData?.data?.offline_message_default ?? ''
  const offlineRequired = settingsData?.data?.offline_message_required !== false

  const suspend = useMutation({
    mutationFn: (body: { message: string; includeClients: boolean }) =>
      api.post(`/agency/agencies/${id}/suspend`, body).then((r) => r.data),
    onSuccess: (res: { data?: { clientsSuspended?: number } }) => {
      const n = res?.data?.clientsSuspended ?? 0
      setMsg(n > 0 ? `Cabinet mis hors ligne (+ ${n} entreprise(s) cliente(s))` : 'Cabinet mis hors ligne')
      setShowOfflineDialog(false)
      invalidate()
    },
    onError: (err: unknown) =>
      setMsg((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Erreur'),
  })
  const reactivate = useMutation({
    mutationFn: (body: { includeClients: boolean }) =>
      api.post(`/agency/agencies/${id}/reactivate`, body).then((r) => r.data),
    onSuccess: (res: { data?: { clientsReactivated?: number } }) => {
      const n = res?.data?.clientsReactivated ?? 0
      setMsg(n > 0 ? `Cabinet réactivé (+ ${n} entreprise(s) cliente(s))` : 'Cabinet réactivé')
      invalidate()
    },
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
          ? <button onClick={() => { setOfflineMessage(offlineDefault); setIncludeClients(false); setShowOfflineDialog(true) }}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"><Ban className="h-4 w-4" /> Mettre hors ligne</button>
          : <button onClick={() => reactivate.mutate({ includeClients: true })} disabled={reactivate.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"><CheckCircle className="h-4 w-4" /> Réactiver (avec ses clients)</button>}
      </div>

      {a.status !== 'active' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-medium text-red-800 mb-1">Cabinet hors ligne</p>
          <p className="text-red-700">
            Message affiché aux utilisateurs : « {a.offline_message || 'Ce site est temporairement hors service. Veuillez contacter votre administrateur.'} »
          </p>
        </div>
      )}

      {/* Dialogue de mise hors ligne : message (variable système surchargeable)
          + option cascade sur les entreprises clientes du cabinet. */}
      {showOfflineDialog && a.status === 'active' && (
        <div className="rounded-lg border border-red-300 bg-red-50/70 p-4 text-sm space-y-3">
          <div>
            <p className="font-semibold text-red-900 mb-1 flex items-center gap-2">
              <Ban className="h-4 w-4" /> Mettre « {a.name} » hors ligne
            </p>
            <p className="text-xs text-red-800">
              Les membres du cabinet seront bloqués et verront ce message.
              {offlineRequired ? ' Le message est obligatoire (politique plateforme).' : ' Le message est facultatif.'}
            </p>
          </div>
          <textarea
            value={offlineMessage}
            onChange={(e) => setOfflineMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Message affiché aux utilisateurs (ex. : maintenance, suspension contractuelle…)"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={includeClients} onChange={(e) => setIncludeClients(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-red-700" />
            <span className="text-xs text-red-900">
              Mettre aussi hors ligne les <strong>{a.tenants.length}</strong> entreprise(s) cliente(s) rattachée(s)
              (leurs utilisateurs verront le même message)
            </span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => suspend.mutate({ message: offlineMessage.trim(), includeClients })}
              disabled={suspend.isPending || (offlineRequired && !offlineMessage.trim())}
              className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">
              {suspend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              Confirmer la mise hors ligne
            </button>
            <button onClick={() => setShowOfflineDialog(false)}
              className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm hover:bg-red-50">
              Annuler
            </button>
          </div>
        </div>
      )}

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
