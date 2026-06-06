import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
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
  const { t } = useTranslation('platform')
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
    onSuccess: () => { setMsg(t('agencyDetail.messages.attached')); setAttachId(''); invalidate() },
    onError: (err: unknown) => setMsg((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('agencyDetail.messages.error')),
  })
  const detach = useMutation({
    mutationFn: (tenantId: string) => api.delete(`/agency/agencies/${id}/tenants/${tenantId}`).then((r) => r.data),
    onSuccess: () => { setMsg(t('agencyDetail.messages.detached')); invalidate() },
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
      setMsg(n > 0 ? t('agencyDetail.messages.suspendedWithClients', { count: n }) : t('agencyDetail.messages.suspended'))
      setShowOfflineDialog(false)
      invalidate()
    },
    onError: (err: unknown) =>
      setMsg((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('agencyDetail.messages.error')),
  })
  const reactivate = useMutation({
    mutationFn: (body: { includeClients: boolean }) =>
      api.post(`/agency/agencies/${id}/reactivate`, body).then((r) => r.data),
    onSuccess: (res: { data?: { clientsReactivated?: number } }) => {
      const n = res?.data?.clientsReactivated ?? 0
      setMsg(n > 0 ? t('agencyDetail.messages.reactivatedWithClients', { count: n }) : t('agencyDetail.messages.reactivated'))
      invalidate()
    },
  })

  if (isLoading || !data) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
  const a = data.data
  const attachableTenants = (allTenants?.data ?? []).filter(
    (tn) => ['CIV', 'CI'].includes((tn.default_country_code ?? '').toUpperCase())
      && !a.tenants.some((at) => at.id === tn.id))

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <Link to="/platform/agencies" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> {t('agencyDetail.back')}</Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{a.name}</h1>
          <p className="text-sm text-muted-foreground">{a.city ?? 'Côte d\'Ivoire'} · {a.status === 'active' ? t('agencyDetail.statusActive') : t('agencyDetail.statusSuspended')}</p>
        </div>
        {a.status === 'active'
          ? <button onClick={() => { setOfflineMessage(offlineDefault); setIncludeClients(false); setShowOfflineDialog(true) }}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"><Ban className="h-4 w-4" /> {t('agencyDetail.setOffline')}</button>
          : <button onClick={() => reactivate.mutate({ includeClients: true })} disabled={reactivate.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"><CheckCircle className="h-4 w-4" /> {t('agencyDetail.reactivateWithClients')}</button>}
      </div>

      {a.status !== 'active' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-medium text-red-800 mb-1">{t('agencyDetail.offlineTitle')}</p>
          <p className="text-red-700">
            {t('agencyDetail.offlineMessageShown', { message: a.offline_message || t('agencyDetail.defaultOfflineMessage') })}
          </p>
        </div>
      )}

      {/* Dialogue de mise hors ligne : message (variable système surchargeable)
          + option cascade sur les entreprises clientes du cabinet. */}
      {showOfflineDialog && a.status === 'active' && (
        <div className="rounded-lg border border-red-300 bg-red-50/70 p-4 text-sm space-y-3">
          <div>
            <p className="font-semibold text-red-900 mb-1 flex items-center gap-2">
              <Ban className="h-4 w-4" /> {t('agencyDetail.offlineDialog.title', { name: a.name })}
            </p>
            <p className="text-xs text-red-800">
              {t('agencyDetail.offlineDialog.desc')}
              {offlineRequired ? t('agencyDetail.offlineDialog.required') : t('agencyDetail.offlineDialog.optional')}
            </p>
          </div>
          <textarea
            value={offlineMessage}
            onChange={(e) => setOfflineMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('agencyDetail.offlineDialog.placeholder')}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={includeClients} onChange={(e) => setIncludeClients(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-red-700" />
            <span className="text-xs text-red-900">
              <Trans
                i18nKey="agencyDetail.offlineDialog.includeClients"
                ns="platform"
                values={{ count: a.tenants.length }}
                components={[<strong />]}
              />
            </span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => suspend.mutate({ message: offlineMessage.trim(), includeClients })}
              disabled={suspend.isPending || (offlineRequired && !offlineMessage.trim())}
              className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">
              {suspend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              {t('agencyDetail.offlineDialog.confirm')}
            </button>
            <button onClick={() => setShowOfflineDialog(false)}
              className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm hover:bg-red-50">
              {t('agencyDetail.offlineDialog.cancel')}
            </button>
          </div>
        </div>
      )}

      {msg && <div className="rounded-lg bg-muted px-4 py-2 text-sm">{msg}</div>}

      {/* Entreprises rattachées */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold">{t('agencyDetail.clients.title')}</h2>
        <div className="mb-4 flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('agencyDetail.clients.attachLabel')}</label>
            <select value={attachId} onChange={(e) => setAttachId(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option value="">{t('agencyDetail.clients.selectPlaceholder')}</option>
              {attachableTenants.map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
            </select>
          </div>
          <button onClick={() => attach.mutate()} disabled={!attachId || attach.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {attach.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {t('agencyDetail.clients.attach')}
          </button>
        </div>
        <div className="space-y-2">
          {a.tenants.map((tn) => (
            <div key={tn.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">{tn.name}</span>
              <span className="text-xs text-muted-foreground">{tn.city ?? t('agencyDetail.clients.cityFallback')}</span>
              <button onClick={() => detach.mutate(tn.id)} className="text-muted-foreground hover:text-red-600" title={t('agencyDetail.clients.detach')}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {a.tenants.length === 0 && <p className="text-sm text-muted-foreground">{t('agencyDetail.clients.empty')}</p>}
        </div>
      </div>

      {/* Membres */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold">{t('agencyDetail.members.title')}</h2>
        <div className="space-y-2">
          {a.users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <span className="flex-1">{u.first_name} {u.last_name} <span className="text-muted-foreground">· {u.email}</span></span>
              <span className="text-xs">{u.role === 'agency_owner' ? t('agencyDetail.members.roleOwner') : t('agencyDetail.members.roleMember')}</span>
              <span className={u.is_active ? 'text-emerald-600 text-xs' : 'text-red-500 text-xs'}>{u.is_active ? t('agencyDetail.members.active') : t('agencyDetail.members.inactive')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
