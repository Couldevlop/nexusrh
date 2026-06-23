import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { MODULE_DEFAULTS, type ModuleKey } from '@/lib/modules'
import { ModuleTogglesGrid } from '@/components/shared/ModuleTogglesGrid'
import { ArrowLeft, Power, RefreshCw, AlertTriangle, Wrench, Save, Palette, FileText, Boxes, Database, Download, Trash2 } from 'lucide-react'
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
  offline_message?: string | null
  ai_platform_key_enabled?: boolean
}

interface OfflinePolicySettings {
  offline_message_default?: string
  offline_message_required?: boolean
}

interface TenantStats {
  userCount: number; employeeCount: number; activeEmployeeCount: number
  payslipCount: number; maxUsers: number; maxEmployees: number
}

type TabKey = 'apparence' | 'plan' | 'modules' | 'donnees'

export default function PlatformTenantDetail() {
  const { t } = useTranslation('platform')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabKey>('plan')
  const [resetResult, setResetResult] = useState<{ tempPassword: string; adminEmail: string } | null>(null)
  const [showRepairForm, setShowRepairForm] = useState(false)
  const [repairEmail, setRepairEmail] = useState('')
  const [repairFirst, setRepairFirst] = useState('')
  const [repairLast, setRepairLast] = useState('')

  const [showOfflineDialog, setShowOfflineDialog] = useState(false)
  const [offlineMessage, setOfflineMessage] = useState('')

  // Modules activés : brouillon local (null = aucun changement non sauvegardé).
  const [moduleDraft, setModuleDraft] = useState<Record<ModuleKey, boolean> | null>(null)
  const [modulesSaved, setModulesSaved] = useState(false)

  // PLT-010 — brouillon d'apparence (couleurs) : null = pas de changement.
  const [appearanceDraft, setAppearanceDraft] = useState<{ primary: string; secondary: string } | null>(null)
  const [appearanceSaved, setAppearanceSaved] = useState(false)

  // PLT-009 (Données) — confirmation de suppression (saisie du slug).
  const [deleteConfirm, setDeleteConfirm] = useState('')

  const { data, isLoading } = useQuery<{ data: Tenant }>({
    queryKey: ['tenant', id],
    queryFn: () => api.get(`/platform/tenants/${id}`).then(r => r.data),
  })

  const { data: modulesData, isLoading: modulesLoading } = useQuery<{ data: { modules: Record<ModuleKey, boolean> } }>({
    queryKey: ['tenant-modules', id],
    queryFn: () => api.get(`/platform/tenants/${id}/modules`).then(r => r.data),
    enabled: !!id,
  })

  // PLT-009 — statistiques du tenant (onglet Données).
  const { data: statsData } = useQuery<{ data: TenantStats }>({
    queryKey: ['tenant-stats', id],
    queryFn: () => api.get(`/platform/tenants/${id}/stats`).then(r => r.data),
    enabled: !!id,
  })

  const serverModules = modulesData?.data?.modules
  const moduleValues: Record<ModuleKey, boolean> | null =
    moduleDraft ?? (serverModules ? { ...MODULE_DEFAULTS, ...serverModules } : null)

  const modulesMut = useMutation({
    mutationFn: (modules: Record<ModuleKey, boolean>) =>
      api.put(`/platform/tenants/${id}/modules`, { modules }),
    onSuccess: () => {
      setModuleDraft(null)
      setModulesSaved(true)
      void queryClient.invalidateQueries({ queryKey: ['tenant-modules', id] })
    },
  })
  const modulesErrMsg = (modulesMut.error as { response?: { data?: { error?: string } } } | null)
    ?.response?.data?.error ?? null

  // PLT-010 — sauvegarde des couleurs (PATCH primary_color/secondary_color).
  const appearanceMut = useMutation({
    mutationFn: (v: { primary: string; secondary: string }) =>
      api.patch(`/platform/tenants/${id}`, { primary_color: v.primary, secondary_color: v.secondary }),
    onSuccess: () => {
      setAppearanceDraft(null)
      setAppearanceSaved(true)
      void queryClient.invalidateQueries({ queryKey: ['tenant', id] })
    },
  })

  // PLT-009 — suppression définitive (DELETE avec confirmation du slug).
  const deleteMut = useMutation({
    mutationFn: (confirmSlug: string) => api.delete(`/platform/tenants/${id}`, { data: { confirmSlug } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-tenants-list'] })
      navigate('/platform/tenants')
    },
  })
  const deleteErrMsg = (deleteMut.error as { response?: { data?: { error?: string } } } | null)
    ?.response?.data?.error ?? null

  // PLT-011 — changer le plan (le backend réajuste maxUsers/maxEmployees).
  const planMut = useMutation({
    mutationFn: (plan: string) => api.patch(`/platform/tenants/${id}`, { plan_type: plan }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tenant', id] }),
  })

  // PLT-014 — liste des utilisateurs du tenant (lecture + suspension).
  const { data: usersData } = useQuery<{ data: Array<{
    id: string; email: string; first_name: string; last_name: string
    role: string; is_active: boolean; created_at: string
  }> }>({
    queryKey: ['tenant-users', id],
    queryFn: () => api.get(`/platform/tenants/${id}/users`).then(r => r.data),
    enabled: !!id,
  })
  // PLT-015 — suspendre / réactiver un utilisateur.
  const userToggleMut = useMutation({
    mutationFn: (v: { userId: string; isActive: boolean }) =>
      api.patch(`/platform/tenants/${id}/users/${v.userId}`, { isActive: v.isActive }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tenant-users', id] }),
  })

  // Variable système : message hors-ligne par défaut + caractère obligatoire.
  const { data: settingsData } = useQuery<{ data: OfflinePolicySettings }>({
    queryKey: ['platform-settings'],
    queryFn: () => api.get('/platform/settings').then(r => r.data),
    staleTime: 60_000,
  })
  const offlineDefault = settingsData?.data?.offline_message_default ?? ''
  const offlineRequired = settingsData?.data?.offline_message_required !== false

  const suspendMut = useMutation({
    mutationFn: (message: string) => api.post(`/platform/tenants/${id}/suspend`, { message }),
    onSuccess: () => {
      setShowOfflineDialog(false)
      void queryClient.invalidateQueries({ queryKey: ['tenant', id] })
    },
  })
  const suspendErrMsg = (suspendMut.error as { response?: { data?: { error?: string } } } | null)
    ?.response?.data?.error ?? null

  const reactivateMut = useMutation({
    mutationFn: () => api.post(`/platform/tenants/${id}/reactivate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant', id] }),
  })

  const resetMut = useMutation({
    mutationFn: (body?: { adminEmail: string; firstName: string; lastName: string }) =>
      api.post(`/platform/tenants/${id}/reset-admin`, body ?? {}),
    onSuccess: (res) => {
      setResetResult(res.data as { tempPassword: string; adminEmail: string })
      setShowRepairForm(false)
    },
  })

  const resetErr = (resetMut.error as { response?: { status?: number; data?: { error?: string } } } | null)
  const resetErrMsg = resetErr?.response?.data?.error ?? null
  const resetErrStatus = resetErr?.response?.status ?? null
  const canRepair = resetErrStatus === 409  // schema/admin manquant → réparation possible

  // PLT-009 — export RGPD (téléchargement JSON authentifié).
  async function handleExport(slug: string) {
    const res = await api.get(`/platform/tenants/${id}/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `export-rgpd-${slug}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const tenant = data?.data
  if (isLoading) return <div className="p-6 text-center text-muted-foreground">{t('common.loading')}</div>
  if (!tenant)   return <div className="p-6 text-center text-destructive">{t('tenantDetail.notFound')}</div>

  // Plan : clé technique = valeur API ; libellé traduit si connu, sinon brut.
  const planLabel = ['trial', 'starter', 'business', 'enterprise', 'public_sector'].includes(tenant.plan_type)
    ? t(`plans.${tenant.plan_type}`) : tenant.plan_type
  // Statut : clé technique = valeur API ; libellé traduit si connu, sinon brut.
  const statusLabel = ['active', 'trial', 'suspended'].includes(tenant.status)
    ? t(`status.${tenant.status}`) : tenant.status

  const appearance = appearanceDraft ?? { primary: tenant.primary_color, secondary: tenant.secondary_color }
  const stats = statsData?.data

  const TABS: { key: TabKey; label: string; icon: typeof Palette }[] = [
    { key: 'apparence', label: 'Apparence', icon: Palette },
    { key: 'plan',      label: 'Plan',      icon: FileText },
    { key: 'modules',   label: 'Modules',   icon: Boxes },
    { key: 'donnees',   label: 'Données',   icon: Database },
  ]

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/platform/tenants')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t('tenantDetail.back')}
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
              {t('tenantDetail.multiCountryBadge', { country: tenant.default_country_code ?? 'CIV' })}
            </span>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${
            tenant.status === 'active' ? 'bg-green-100 text-green-700' :
            tenant.status === 'trial'  ? 'bg-yellow-100 text-yellow-700' :
            'bg-red-100 text-red-700'
          }`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Onglets (PLT-009) */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {/* ── Onglet Apparence (PLT-010 — éditable + preview + save) ── */}
      {tab === 'apparence' && (
        <div className="rounded-xl border border-border bg-card p-6 space-y-5">
          <h2 className="font-semibold">{t('tenantDetail.theme.title')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div>
              <label className="text-xs text-muted-foreground">{t('tenantDetail.theme.primaryColor')}</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color" value={appearance.primary}
                  onChange={(e) => { setAppearanceSaved(false); setAppearanceDraft({ ...appearance, primary: e.target.value }) }}
                  className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
                />
                <input
                  type="text" value={appearance.primary}
                  onChange={(e) => { setAppearanceSaved(false); setAppearanceDraft({ ...appearance, primary: e.target.value }) }}
                  className="w-28 rounded-lg border border-input bg-background px-2 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('tenantDetail.theme.secondaryColor')}</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color" value={appearance.secondary}
                  onChange={(e) => { setAppearanceSaved(false); setAppearanceDraft({ ...appearance, secondary: e.target.value }) }}
                  className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
                />
                <input
                  type="text" value={appearance.secondary}
                  onChange={(e) => { setAppearanceSaved(false); setAppearanceDraft({ ...appearance, secondary: e.target.value }) }}
                  className="w-28 rounded-lg border border-input bg-background px-2 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>

          {/* Prévisualisation live (réagit au changement avant sauvegarde) */}
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground mb-2">Prévisualisation</p>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold text-white"
                style={{ backgroundColor: appearance.primary }}>
                {tenant.name.slice(0, 2).toUpperCase()}
              </div>
              <button type="button" className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: appearance.primary }}>
                Bouton primaire
              </button>
              <span className="rounded-full px-3 py-1 text-xs font-medium text-white" style={{ backgroundColor: appearance.secondary }}>
                Accent secondaire
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => appearanceMut.mutate(appearance)}
              disabled={appearanceMut.isPending || appearanceDraft === null}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
              <Save className="h-4 w-4" />
              {appearanceMut.isPending ? t('modules.saving') : t('modules.save')}
            </button>
            {appearanceSaved && appearanceDraft === null && (
              <span className="text-sm font-medium text-green-700">{t('modules.saved')}</span>
            )}
            {appearanceMut.isError && (
              <span className="text-sm font-medium text-destructive">{t('modules.saveError')}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Onglet Plan (infos + filiales + clé IA + actions) ── */}
      {tab === 'plan' && (
        <div className="space-y-6">
          {/* PLT-011 — changer le plan (réajuste maxUsers/maxEmployees) */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-1">Plan d'abonnement</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Changer le plan réajuste automatiquement les quotas (utilisateurs / employés).
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={tenant.plan_type}
                onChange={(e) => planMut.mutate(e.target.value)}
                disabled={planMut.isPending}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50">
                {['trial', 'starter', 'business', 'enterprise', 'public_sector'].map(p => (
                  <option key={p} value={p}>{t(`plans.${p}`)}</option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">
                Quotas actuels : {tenant.max_users} utilisateurs · {tenant.max_employees} employés
              </span>
              {planMut.isPending && <span className="text-xs text-muted-foreground">{t('modules.saving')}</span>}
            </div>
          </div>

          {/* Infos */}
          <div className="grid grid-cols-2 gap-4">
            {[
              [t('tenantDetail.info.city'), tenant.city],
              [t('tenantDetail.info.sector'), tenant.sector],
              [t('tenantDetail.info.plan'), planLabel],
              [t('tenantDetail.info.atRate'), `${(parseFloat(tenant.at_rate) * 100).toFixed(1)} %`],
              [t('tenantDetail.info.cnpsNumber'), tenant.cnps_number ?? t('tenantDetail.info.dash')],
              [t('tenantDetail.info.dgiNumber'), tenant.dgi_number ?? t('tenantDetail.info.dash')],
              [t('tenantDetail.info.maxUsers'), String(tenant.max_users)],
              [t('tenantDetail.info.maxEmployees'), String(tenant.max_employees)],
              [t('tenantDetail.info.payrollMode'), tenant.payroll_mode === 'multi_country' ? t('tenantDetail.info.payrollModeMulti') : t('tenantDetail.info.payrollModeSingle')],
              [t('tenantDetail.info.defaultCountry'), tenant.default_country_code ?? 'CIV'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-sm font-medium mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          {/* Toggle filiales (réactif) */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-3">{t('tenantDetail.subsidiaries.title')}</h2>
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
                <div className="text-sm font-medium">{t('tenantDetail.subsidiaries.toggleLabel')}</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {tenant.has_subsidiaries
                    ? t('tenantDetail.subsidiaries.hintOn')
                    : t('tenantDetail.subsidiaries.hintOff')}
                </p>
              </div>
            </label>
          </div>

          {/* Clé IA plateforme (gouvernance super_admin) */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-3">{t('tenantDetail.aiPlatformKey.title')}</h2>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tenant.ai_platform_key_enabled ?? true}
                onChange={(e) => api.patch(`/platform/tenants/${id}`, {
                  ai_platform_key_enabled: e.target.checked,
                }).then(() => queryClient.invalidateQueries({ queryKey: ['tenant', id] }))}
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
              />
              <div className="flex-1">
                <div className="text-sm font-medium">{t('tenantDetail.aiPlatformKey.toggleLabel')}</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {(tenant.ai_platform_key_enabled ?? true)
                    ? t('tenantDetail.aiPlatformKey.hintOn')
                    : t('tenantDetail.aiPlatformKey.hintOff')}
                </p>
              </div>
            </label>
          </div>

          {/* Actions */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-4">{t('tenantDetail.actions.title')}</h2>
            {tenant.status === 'suspended' && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
                <p className="font-medium text-red-800 mb-1">{t('tenantDetail.actions.offlineTitle')}</p>
                <p className="text-red-700">
                  {t('tenantDetail.actions.offlineMessageShown', { message: tenant.offline_message || t('tenantDetail.actions.defaultOfflineMessage') })}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              {tenant.status !== 'suspended' ? (
                <button
                  onClick={() => {
                    setOfflineMessage(offlineDefault)
                    setShowOfflineDialog(true)
                  }}
                  disabled={suspendMut.isPending}
                  className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">
                  <Power className="h-4 w-4" />
                  {t('tenantDetail.actions.setOffline')}
                </button>
              ) : (
                <button
                  onClick={() => reactivateMut.mutate()}
                  disabled={reactivateMut.isPending}
                  className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50">
                  <Power className="h-4 w-4" />
                  {t('tenantDetail.actions.reactivate')}
                </button>
              )}

              <button
                onClick={() => resetMut.mutate(undefined)}
                disabled={resetMut.isPending}
                className="flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50">
                <RefreshCw className="h-4 w-4" />
                {t('tenantDetail.actions.resetPassword')}
              </button>
            </div>

            {/* Dialogue de mise hors ligne */}
            {showOfflineDialog && (
              <div className="mt-4 rounded-lg border border-red-300 bg-red-50/70 p-4 text-sm space-y-3">
                <div>
                  <p className="font-semibold text-red-900 mb-1 flex items-center gap-2">
                    <Power className="h-4 w-4" /> {t('tenantDetail.offlineDialog.title', { name: tenant.name })}
                  </p>
                  <p className="text-xs text-red-800">
                    {t('tenantDetail.offlineDialog.desc')}
                    {offlineRequired ? t('tenantDetail.offlineDialog.required') : t('tenantDetail.offlineDialog.optional')}
                  </p>
                </div>
                <textarea
                  value={offlineMessage}
                  onChange={(e) => setOfflineMessage(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder={t('tenantDetail.offlineDialog.placeholder')}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                {suspendErrMsg && (
                  <p className="text-xs font-medium text-red-700">{suspendErrMsg}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => suspendMut.mutate(offlineMessage.trim())}
                    disabled={suspendMut.isPending || (offlineRequired && !offlineMessage.trim())}
                    className="flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">
                    <Power className="h-4 w-4" />
                    {t('tenantDetail.offlineDialog.confirm')}
                  </button>
                  <button
                    onClick={() => setShowOfflineDialog(false)}
                    className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm hover:bg-red-50">
                    {t('tenantDetail.offlineDialog.cancel')}
                  </button>
                </div>
              </div>
            )}

            {resetErrMsg && !resetResult && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium text-amber-900 mb-1">{t('tenantDetail.reset.errorTitle')}</p>
                    <p className="text-amber-800">{resetErrMsg}</p>
                    {canRepair && !showRepairForm && (
                      <button
                        onClick={() => setShowRepairForm(true)}
                        className="mt-3 flex items-center gap-2 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800">
                        <Wrench className="h-3.5 w-3.5" />
                        {t('tenantDetail.reset.forceRepair')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showRepairForm && !resetResult && (
              <div className="mt-4 rounded-lg border border-amber-400 bg-amber-50/70 p-4 text-sm space-y-3">
                <div>
                  <p className="font-semibold text-amber-900 mb-1 flex items-center gap-2">
                    <Wrench className="h-4 w-4" /> {t('tenantDetail.reset.repairTitle')}
                  </p>
                  <p className="text-xs text-amber-800">
                    {t('tenantDetail.reset.repairDesc')}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input
                    type="email" required placeholder={t('tenantDetail.reset.emailPlaceholder')}
                    value={repairEmail} onChange={e => setRepairEmail(e.target.value)}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="text" required placeholder={t('tenantDetail.reset.firstNamePlaceholder')}
                    value={repairFirst} onChange={e => setRepairFirst(e.target.value)}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="text" required placeholder={t('tenantDetail.reset.lastNamePlaceholder')}
                    value={repairLast} onChange={e => setRepairLast(e.target.value)}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => resetMut.mutate({
                      adminEmail: repairEmail.trim(),
                      firstName:  repairFirst.trim(),
                      lastName:   repairLast.trim(),
                    })}
                    disabled={resetMut.isPending || !repairEmail.includes('@') || !repairFirst || !repairLast}
                    className="flex items-center gap-2 rounded-lg bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50">
                    <Wrench className="h-4 w-4" />
                    {t('tenantDetail.reset.launchRepair')}
                  </button>
                  <button
                    onClick={() => setShowRepairForm(false)}
                    className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm hover:bg-amber-50">
                    {t('tenantDetail.reset.cancel')}
                  </button>
                </div>
              </div>
            )}

            {resetResult && (
              <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm">
                <p className="font-medium text-green-800 mb-1">{t('tenantDetail.reset.successTitle')}</p>
                <p>{t('tenantDetail.reset.email')} <strong>{resetResult.adminEmail}</strong></p>
                <p>{t('tenantDetail.reset.newPassword')} <code className="rounded bg-white px-1 font-mono select-all">{resetResult.tempPassword}</code></p>
                <p className="mt-2 text-xs text-green-700">{t('tenantDetail.reset.saveNote')}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Onglet Modules ── */}
      {tab === 'modules' && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-1">{t('modules.title')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('modules.subtitle')}</p>
          {moduleValues ? (
            <>
              <ModuleTogglesGrid
                values={moduleValues}
                disabled={modulesMut.isPending}
                onToggle={(key, enabled) => {
                  setModulesSaved(false)
                  setModuleDraft({ ...moduleValues, [key]: enabled })
                }}
              />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => modulesMut.mutate(moduleValues)}
                  disabled={modulesMut.isPending || moduleDraft === null}
                  className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  <Save className="h-4 w-4" />
                  {modulesMut.isPending ? t('modules.saving') : t('modules.save')}
                </button>
                {modulesSaved && moduleDraft === null && (
                  <span className="text-sm font-medium text-green-700">{t('modules.saved')}</span>
                )}
                {modulesMut.isError && (
                  <span className="text-sm font-medium text-destructive">{modulesErrMsg ?? t('modules.saveError')}</span>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {modulesLoading ? t('common.loading') : t('modules.loadError')}
            </p>
          )}
        </div>
      )}

      {/* ── Onglet Données (PLT-009 — stats + export RGPD + suppression) ── */}
      {tab === 'donnees' && (
        <div className="space-y-6">
          {/* Statistiques */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-4">Statistiques</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                ['Utilisateurs', stats ? `${stats.userCount} / ${stats.maxUsers}` : '…'],
                ['Employés actifs', stats ? `${stats.activeEmployeeCount} / ${stats.maxEmployees}` : '…'],
                ['Employés (total)', stats ? String(stats.employeeCount) : '…'],
                ['Bulletins', stats ? String(stats.payslipCount) : '…'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border p-3 text-center">
                  <p className="text-2xl font-bold text-primary">{value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* PLT-014/015 — utilisateurs du tenant (lecture + suspension) */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-1">Utilisateurs du tenant</h2>
            <p className="text-xs text-muted-foreground mb-4">Consultation et suspension — pas de création depuis ici.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4">Email</th>
                    <th className="py-2 pr-4">Rôle</th>
                    <th className="py-2 pr-4">Statut</th>
                    <th className="py-2 pr-4">Créé le</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(usersData?.data ?? []).map(u => (
                    <tr key={u.id}>
                      <td className="py-2 pr-4">
                        <p className="font-medium">{u.email}</p>
                        <p className="text-xs text-muted-foreground">{u.first_name} {u.last_name}</p>
                      </td>
                      <td className="py-2 pr-4">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{u.role}</span>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {u.is_active ? 'Actif' : 'Suspendu'}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{u.created_at?.slice(0, 10)}</td>
                      <td className="py-2">
                        <button
                          onClick={() => userToggleMut.mutate({ userId: u.id, isActive: !u.is_active })}
                          disabled={userToggleMut.isPending}
                          className={`text-xs font-medium hover:underline disabled:opacity-50 ${
                            u.is_active ? 'text-red-600' : 'text-green-600'}`}>
                          {u.is_active ? 'Suspendre' : 'Réactiver'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {(usersData?.data?.length ?? 0) === 0 && (
                    <tr><td colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Aucun utilisateur.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Export RGPD */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-semibold mb-2">Export RGPD</h2>
            <p className="text-xs text-muted-foreground mb-4">
              Télécharge l'ensemble des données du tenant (métadonnées, utilisateurs, employés) au format JSON.
            </p>
            <button
              onClick={() => void handleExport(tenant.slug)}
              className="flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent">
              <Download className="h-4 w-4" />
              Exporter les données (JSON)
            </button>
          </div>

          {/* Zone de danger — suppression définitive */}
          <div className="rounded-xl border border-red-300 bg-red-50/50 p-6">
            <h2 className="font-semibold text-red-800 mb-2 flex items-center gap-2">
              <Trash2 className="h-4 w-4" /> Supprimer le tenant
            </h2>
            <p className="text-xs text-red-700 mb-4">
              Action irréversible : le schéma <code className="font-mono">{tenant.schema_name}</code> et toutes ses
              données seront définitivement supprimés. Saisissez le slug <strong>{tenant.slug}</strong> pour confirmer.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={tenant.slug}
                className="w-48 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400"
              />
              <button
                onClick={() => deleteMut.mutate(deleteConfirm.trim())}
                disabled={deleteMut.isPending || deleteConfirm.trim() !== tenant.slug}
                className="flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">
                <Trash2 className="h-4 w-4" />
                {deleteMut.isPending ? 'Suppression…' : 'Supprimer définitivement'}
              </button>
            </div>
            {deleteErrMsg && <p className="mt-2 text-xs font-medium text-red-700">{deleteErrMsg}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
