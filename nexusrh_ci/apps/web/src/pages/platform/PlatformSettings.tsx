import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { api, formatFCFA } from '@/lib/api'
import {
  Settings, Save, Loader2, Bot, Mail, Shield,
  Bell, Building2, AlertCircle, CheckCircle, Scale, Globe,
  Sparkles, Plus, Trash2, Edit3, RefreshCw,
} from 'lucide-react'

interface PlatformSettings {
  id?: string
  app_name: string
  support_email: string
  support_phone: string
  support_whatsapp?: string
  welcome_email_signature?: string
  logo_url: string | null
  primary_color: string
  maintenance_mode: boolean
  allow_new_tenants: boolean
  max_tenants: number
  default_trial_days: number
  ai_enabled: boolean
  legal_name: string
  legal_address: string
  // ── Politique de sécurité paramétrable (OWASP A07) ──
  mfa_required_super_admin: boolean
  mfa_required_tenant_users: boolean
  password_max_age_days: number
  password_history_count: number
  breach_check_enabled: boolean
  lockout_enabled: boolean
  lockout_max_attempts: number
  lockout_window_minutes: number
  lockout_duration_minutes: number
  // ── Mise hors ligne (tenant / cabinet) : variable système ──
  offline_message_default?: string
  offline_message_required?: boolean
  aiConfigured: boolean
  smtpConfigured: boolean
  version: string
  environment: string
}

type TabKey = 'general' | 'security' | 'notifications' | 'ai' | 'legal' | 'store-lois' | 'multi-leg' | 'sourcing-ia'

interface LegalConstant {
  key: string
  label: string
  value: string | number
  unit: string
  category: string
  effective_date: string
}

interface CountryConfig {
  country_code: string
  country_name: string
  currency: string
  payroll_engine: string
  is_active: boolean
  timezone: string
  config: { smig?: number; [k: string]: unknown }
}

const TABS: Array<{ key: TabKey; labelKey: string; icon: React.ElementType }> = [
  { key: 'general',       labelKey: 'general',       icon: Settings   },
  { key: 'security',      labelKey: 'security',      icon: Shield     },
  { key: 'notifications', labelKey: 'notifications', icon: Bell       },
  { key: 'ai',            labelKey: 'ai',            icon: Bot        },
  { key: 'legal',         labelKey: 'legal',         icon: Building2  },
  { key: 'store-lois',    labelKey: 'storeLois',     icon: Scale      },
  { key: 'multi-leg',     labelKey: 'multiLeg',      icon: Globe      },
  { key: 'sourcing-ia',   labelKey: 'sourcingIa',    icon: Sparkles   },
]

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted'}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </div>
      <span className="text-sm font-medium">{label}</span>
    </label>
  )
}

// Métadonnées locales pour transformer le JSONB constants en liste affichable.
// Les libellés sont traduits via i18n (settings.storeLois.constants.<KEY>).
const CONSTANT_META: Record<string, { unit: string; category: string }> = {
  SMIG_MENSUEL:                 { unit: 'FCFA',   category: 'smig' },
  SMIG_HORAIRE:                 { unit: 'FCFA/h', category: 'smig' },
  PLAFOND_CNPS_AT_PF_MENSUEL:   { unit: 'FCFA/mois', category: 'cnps' },
  PLAFOND_CNPS_RETRAITE_MENSUEL:{ unit: 'FCFA/mois', category: 'cnps' },
  TAUX_CNPS_RETRAITE_SAL:       { unit: '%',      category: 'cnps' },
  TAUX_CNPS_RETRAITE_PAT:       { unit: '%',      category: 'cnps' },
  TAUX_CNPS_PF_PAT:             { unit: '%',     category: 'cnps' },
  TAUX_CNPS_MATERNITE_PAT:      { unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_COMMERCE:        { unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_BTP:             { unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_INDUSTRIE:       { unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_EXTRACTION:      { unit: '%',      category: 'cnps' },
  ABATTEMENT_ITS:               { unit: '%',     category: 'its' },
  CREDIT_IMPOT_MARIE:           { unit: 'FCFA/mois', category: 'its' },
  CREDIT_IMPOT_1ENFANT:         { unit: 'FCFA/mois', category: 'its' },
  CREDIT_IMPOT_2ENFANTS:        { unit: 'FCFA/mois', category: 'its' },
  CREDIT_IMPOT_3ENFANTS_PLUS:   { unit: 'FCFA/mois', category: 'its' },
  CONGES_JOURS_PAR_MOIS:        { unit: 'j/mois', category: 'conges' },
  CONTRIBUTION_FDFP:            { unit: '% masse sal.', category: 'fdfp' },
}

const CATEGORY_KEYS = ['smig', 'cnps', 'its', 'conges', 'fdfp'] as const

function StoreDeLoisTab() {
  const { t } = useTranslation('platform')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const queryClient = useQueryClient()

  // L'API retourne des rows PG : [{ country, version, constants: {...jsonb}, notes }]
  const { data, isLoading } = useQuery<{ data: Array<{ constants: Record<string, unknown> }> }>({
    queryKey: ['legal-constants'],
    queryFn: () => api.get('/platform/legal-constants?country=CI&version=2024').then(r => r.data),
  })

  const updateMut = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string | number }) =>
      api.patch('/platform/legal-constants/CI/2024', { constants: { [key]: value } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['legal-constants'] })
      setEditingKey(null)
    },
  })

  // Transformer le JSONB en LegalConstant[] avec métadonnées
  const rawConstants = (data?.data?.[0]?.constants ?? {}) as Record<string, unknown>
  const constants: LegalConstant[] = Object.entries(rawConstants)
    .filter(([key]) => CONSTANT_META[key])
    .map(([key, value]) => ({
      key,
      label: t(`settings.storeLois.constants.${key}`),
      unit:  CONSTANT_META[key]!.unit,
      category: CONSTANT_META[key]!.category,
      value: value as string | number,
      effective_date: '',
    }))

  const categories = (CATEGORY_KEYS as readonly string[]).filter(cat =>
    constants.some(c => c.category === cat)
  )

  if (isLoading) return <div className="flex justify-center p-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold">{t('settings.storeLois.title')}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('settings.storeLois.subtitle')}
          </p>
        </div>
        <span className="rounded-full bg-green-100 text-green-700 text-xs font-medium px-3 py-1">
          {t('settings.storeLois.badge')}
        </span>
      </div>

      {categories.map(cat => {
        const items = constants.filter(c => c.category === cat)
        return (
          <div key={cat} className="rounded-xl border border-border overflow-hidden">
            <div className="bg-muted/40 border-b border-border px-4 py-2.5">
              <p className="text-sm font-semibold">{t(`settings.storeLois.categories.${cat}`)}</p>
            </div>
            <div className="divide-y divide-border">
              {items.map(c => (
                <div key={c.key} className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 text-sm">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{c.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground font-mono">{c.key}</span>
                  </div>
                  {editingKey === c.key ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        className="rounded border border-input px-2 py-1 text-sm w-32 focus:ring-2 focus:ring-ring outline-none"
                      />
                      <span className="text-xs text-muted-foreground">{c.unit}</span>
                      <button onClick={() => updateMut.mutate({ key: c.key, value: editValue })}
                        disabled={updateMut.isPending}
                        className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90">
                        {updateMut.isPending ? '...' : 'OK'}
                      </button>
                      <button onClick={() => setEditingKey(null)}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-semibold">
                        {typeof c.value === 'number' && c.value > 1000 ? formatFCFA(c.value) : c.value}
                        {' '}<span className="text-xs font-normal text-muted-foreground">{c.unit}</span>
                      </span>
                      <button
                        onClick={() => { setEditingKey(c.key); setEditValue(String(c.value)) }}
                        className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-0.5 hover:bg-accent"
                      >
                        {t('settings.storeLois.edit')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}

      <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
        <Trans i18nKey="settings.storeLois.warning" ns="platform" components={[<strong />]} />
      </div>
    </div>
  )
}

function MultiLegTab() {
  const { t } = useTranslation('platform')
  const { data, isLoading } = useQuery<{ data: CountryConfig[] }>({
    queryKey: ['country-configs'],
    queryFn: () => api.get('/platform/country-configs').then(r => r.data),
  })

  const configs = data?.data ?? []

  const FLAG: Record<string, string> = {
    CI: '🇨🇮', SN: '🇸🇳', BJ: '🇧🇯', TG: '🇹🇬', BF: '🇧🇫', ML: '🇲🇱',
    NE: '🇳🇪', CM: '🇨🇲', TD: '🇹🇩', NG: '🇳🇬', GH: '🇬🇭',
  }
  const ZONE_BADGE: Record<string, string> = {
    UEMOA:  'bg-orange-50 text-orange-700 border-orange-200',
    CEMAC:  'bg-emerald-50 text-emerald-700 border-emerald-200',
    ECOWAS: 'bg-blue-50 text-blue-700 border-blue-200',
  }
  const STATUS_COLOR: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    beta: 'bg-blue-100 text-blue-700',
    planned: 'bg-gray-100 text-gray-600',
  }

  if (isLoading) return <div className="flex justify-center p-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>

  const activeCount  = configs.filter(c => c.is_active).length
  const uemoaCount   = configs.filter(c => (c.config as { zone?: string } | undefined)?.zone === 'UEMOA').length
  const cemacCount   = configs.filter(c => (c.config as { zone?: string } | undefined)?.zone === 'CEMAC').length
  const ecowasCount  = configs.filter(c => (c.config as { zone?: string } | undefined)?.zone === 'ECOWAS').length

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold">{t('settings.multiLeg.title')}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('settings.multiLeg.subtitle')}
          <span className="ml-2 inline-flex items-center gap-2 text-xs">
            <span className="rounded bg-green-100 px-1.5 py-0.5 font-medium text-green-700">{t('settings.multiLeg.activeCount', { count: activeCount })}</span>
            <span className="rounded bg-orange-50 px-1.5 py-0.5 font-medium text-orange-700">UEMOA {uemoaCount}</span>
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">CEMAC {cemacCount}</span>
            <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">ECOWAS {ecowasCount}</span>
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {configs.map(c => {
          const zone = (c.config as { zone?: string } | undefined)?.zone
          return (
            <div key={c.country_code} className={`rounded-xl border p-4 ${c.is_active ? 'border-border bg-card' : 'border-border/50 bg-muted/20 opacity-70'}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{FLAG[c.country_code] ?? '🌍'}</span>
                  <div>
                    <p className="font-semibold text-sm">{c.country_name}</p>
                    <p className="text-xs text-muted-foreground">{c.country_code} · {c.currency} · {c.timezone}</p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.is_active ? STATUS_COLOR['active'] : STATUS_COLOR['planned']}`}>
                    {c.is_active ? t('settings.multiLeg.statusActive') : t('settings.multiLeg.statusPlanned')}
                  </span>
                  {zone && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${ZONE_BADGE[zone] ?? 'bg-muted text-muted-foreground border-border'}`}>
                      {zone}
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('settings.multiLeg.engine')}</span>
                  <code className="bg-muted px-1.5 rounded">{c.payroll_engine}</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('settings.multiLeg.smig')}</span>
                  <span className="font-mono font-semibold">
                    {(c.config?.smig ?? 0).toLocaleString('fr-FR')} {c.currency}
                  </span>
                </div>
              </div>
              {!c.is_active && (
                <div className="mt-3 rounded bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                  {t('settings.multiLeg.onDemand')}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm">
        <p className="font-semibold text-blue-800 mb-2">{t('settings.multiLeg.coverageTitle')}</p>
        <div className="space-y-1 text-blue-700 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-green-600 font-bold">✓</span>
            <span><Trans i18nKey="settings.multiLeg.coverage.uemoa" ns="platform" components={[<strong />]} /></span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-600 font-bold">✓</span>
            <span><Trans i18nKey="settings.multiLeg.coverage.cemac" ns="platform" components={[<strong />]} /></span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-blue-600 font-bold">✓</span>
            <span><Trans i18nKey="settings.multiLeg.coverage.ecowas" ns="platform" components={[<strong />]} /></span>
          </div>
        </div>
      </div>

      <div className="rounded-lg bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">{t('settings.multiLeg.architectureTitle')}</p>
        <p className="text-xs text-muted-foreground">
          <Trans i18nKey="settings.multiLeg.architectureDesc" ns="platform"
            components={[
              <code className="bg-muted px-1 rounded" />,
              <code className="bg-muted px-1 rounded" />,
              <code className="bg-muted px-1 rounded" />,
            ]} />
        </p>
      </div>
    </div>
  )
}

export default function PlatformSettings() {
  const { t } = useTranslation('platform')
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabKey>('general')
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery<{ data: PlatformSettings }>({
    queryKey: ['platform-settings'],
    queryFn: () => api.get('/platform/settings').then(r => r.data),
  })

  const [form, setForm] = useState<Partial<PlatformSettings>>({})
  const settings = { ...(data?.data ?? {}), ...form } as PlatformSettings

  const update = (field: string, value: unknown) =>
    setForm(prev => ({ ...prev, [field]: value }))

  const saveMut = useMutation({
    mutationFn: () => api.patch('/platform/settings', form),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      queryClient.invalidateQueries({ queryKey: ['platform-settings'] })
      setForm({})
    },
  })

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('settings.subtitle', { version: settings.version ?? '1.0.0', environment: settings.environment ?? 'development' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <CheckCircle className="h-4 w-4" /> {t('settings.saved')}
            </span>
          )}
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || Object.keys(form).length === 0}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('settings.save')}
          </button>
        </div>
      </div>

      {/* Statut systèmes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: t('settings.systemStatus.aiClaude'),    ok: settings.aiConfigured,   icon: Bot,   hint: settings.aiConfigured ? t('settings.systemStatus.aiOk') : t('settings.systemStatus.aiKo') },
          { label: t('settings.systemStatus.smtp'),         ok: settings.smtpConfigured, icon: Mail,  hint: settings.smtpConfigured ? t('settings.systemStatus.smtpOk') : t('settings.systemStatus.smtpKo') },
          { label: t('settings.systemStatus.maintenance'),  ok: !settings.maintenance_mode, icon: AlertCircle, hint: settings.maintenance_mode ? t('settings.systemStatus.maintenanceOn') : t('settings.systemStatus.maintenanceOff') },
          { label: t('settings.systemStatus.newTenants'),   ok: settings.allow_new_tenants, icon: Building2, hint: settings.allow_new_tenants ? t('settings.systemStatus.newTenantsOpen') : t('settings.systemStatus.newTenantsClosed') },
        ].map(({ label, ok, icon: Icon, hint }) => (
          <div key={label} className={`rounded-xl border p-3 ${ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
            <div className="flex items-center gap-2">
              <Icon className={`h-4 w-4 ${ok ? 'text-green-600' : 'text-red-500'}`} />
              <span className={`text-xs font-semibold ${ok ? 'text-green-700' : 'text-red-700'}`}>{label}</span>
            </div>
            <p className="text-xs mt-1 text-muted-foreground">{hint}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-6">
        {/* Sidebar tabs */}
        <div className="w-48 shrink-0 space-y-1">
          {TABS.map(({ key, labelKey, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-left transition-colors ${
                tab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t(`settings.tabs.${labelKey}`)}
            </button>
          ))}
        </div>

        {/* Contenu */}
        <div className="flex-1 rounded-xl border border-border bg-card p-6 space-y-5">
          {tab === 'general' && (
            <>
              <h2 className="font-semibold">{t('settings.general.title')}</h2>
              <Field label={t('settings.general.appName')} hint={t('settings.general.appNameHint')}>
                <input className={inputCls} value={settings.app_name ?? 'NexusRH CI'}
                  onChange={e => update('app_name', e.target.value)} />
              </Field>
              <Field label={t('settings.general.trialDays')}>
                <input type="number" className={inputCls} value={settings.default_trial_days ?? 30}
                  onChange={e => update('default_trial_days', parseInt(e.target.value))} min={7} max={90} />
              </Field>
              <Field label={t('settings.general.maxTenants')} hint={t('settings.general.maxTenantsHint')}>
                <input type="number" className={inputCls} value={settings.max_tenants ?? 9999}
                  onChange={e => update('max_tenants', parseInt(e.target.value))} min={0} />
              </Field>
              <div className="space-y-3 pt-2">
                <Toggle checked={settings.allow_new_tenants ?? true}
                  onChange={v => update('allow_new_tenants', v)}
                  label={t('settings.general.allowNewTenants')} />
                <Toggle checked={settings.maintenance_mode ?? false}
                  onChange={v => update('maintenance_mode', v)}
                  label={t('settings.general.maintenanceMode')} />
              </div>
              {(form.maintenance_mode) && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-red-700">{t('settings.general.maintenanceWarning')}</p>
                </div>
              )}

              {/* ── Mise hors ligne (tenant / cabinet) : variable système ── */}
              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">{t('settings.general.offline.title')}</p>
                <Field label={t('settings.general.offline.defaultMessage')}
                  hint={t('settings.general.offline.defaultMessageHint')}>
                  <textarea className={inputCls} rows={3} maxLength={2000}
                    value={settings.offline_message_default ?? ''}
                    onChange={e => update('offline_message_default', e.target.value)} />
                </Field>
                <Toggle
                  checked={settings.offline_message_required !== false}
                  onChange={v => update('offline_message_required', v)}
                  label={t('settings.general.offline.required')} />
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('settings.general.offline.requiredHint')}
                </p>
              </div>
            </>
          )}

          {tab === 'security' && (
            <>
              <h2 className="font-semibold">{t('settings.security.title')}</h2>

              {/* ── Politiques paramétrables (OWASP A07) ── */}
              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">{t('settings.security.mfaTitle')}</p>
                <Toggle
                  checked={settings.mfa_required_super_admin ?? false}
                  onChange={v => update('mfa_required_super_admin', v)}
                  label={t('settings.security.mfaSuperAdmin')} />
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('settings.security.mfaSuperAdminHint')}
                </p>
                <Toggle
                  checked={settings.mfa_required_tenant_users ?? false}
                  onChange={v => update('mfa_required_tenant_users', v)}
                  label={t('settings.security.mfaTenantUsers')} />
                <p className="text-xs text-muted-foreground -mt-2">
                  <Trans i18nKey="settings.security.mfaTenantUsersHint" ns="platform" components={[<strong />]} />
                </p>
              </div>

              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">{t('settings.security.passwordTitle')}</p>
                <Field label={t('settings.security.passwordMaxAge')} hint={t('settings.security.passwordMaxAgeHint')}>
                  <input type="number" min={0} max={3650} className={inputCls}
                    value={settings.password_max_age_days ?? 30}
                    onChange={e => update('password_max_age_days', parseInt(e.target.value || '0', 10))} />
                </Field>
                <Field label={t('settings.security.passwordHistory')} hint={t('settings.security.passwordHistoryHint')}>
                  <input type="number" min={0} max={50} className={inputCls}
                    value={settings.password_history_count ?? 5}
                    onChange={e => update('password_history_count', parseInt(e.target.value || '0', 10))} />
                </Field>
                <Toggle
                  checked={settings.breach_check_enabled ?? true}
                  onChange={v => update('breach_check_enabled', v)}
                  label={t('settings.security.breachCheck')} />
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('settings.security.breachCheckHint')}
                </p>
              </div>

              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">{t('settings.security.lockoutTitle')}</p>
                <Toggle
                  checked={settings.lockout_enabled ?? true}
                  onChange={v => update('lockout_enabled', v)}
                  label={t('settings.security.lockoutEnabled')} />
                <div className="grid grid-cols-3 gap-3">
                  <Field label={t('settings.security.lockoutMaxAttempts')} hint={t('settings.security.lockoutMaxAttemptsHint')}>
                    <input type="number" min={0} max={50} className={inputCls}
                      value={settings.lockout_max_attempts ?? 5}
                      onChange={e => update('lockout_max_attempts', parseInt(e.target.value || '0', 10))} />
                  </Field>
                  <Field label={t('settings.security.lockoutWindow')} hint={t('settings.security.lockoutWindowHint')}>
                    <input type="number" min={1} max={1440} className={inputCls}
                      value={settings.lockout_window_minutes ?? 15}
                      onChange={e => update('lockout_window_minutes', parseInt(e.target.value || '1', 10))} />
                  </Field>
                  <Field label={t('settings.security.lockoutDuration')} hint={t('settings.security.lockoutDurationHint')}>
                    <input type="number" min={1} max={1440} className={inputCls}
                      value={settings.lockout_duration_minutes ?? 15}
                      onChange={e => update('lockout_duration_minutes', parseInt(e.target.value || '1', 10))} />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('settings.security.lockoutSummary', {
                    attempts: settings.lockout_max_attempts ?? 5,
                    window: settings.lockout_window_minutes ?? 15,
                    duration: settings.lockout_duration_minutes ?? 15,
                  })}
                </p>
              </div>

              <div className="rounded-lg bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">{t('settings.security.envTitle')}</p>
                {[
                  { label: t('settings.security.env.jwtSecret'), status: t('settings.security.env.jwtSecretStatus'), ok: true },
                  { label: t('settings.security.env.jwtExpiration'), status: t('settings.security.env.jwtExpirationStatus'), ok: true },
                  { label: t('settings.security.env.mfaAvailable'), status: t('settings.security.env.mfaAvailableStatus'), ok: true },
                  { label: t('settings.security.env.bcrypt'), status: t('settings.security.env.bcryptStatus'), ok: true },
                  { label: t('settings.security.env.cors'), status: t('settings.security.env.corsStatus'), ok: true },
                  { label: t('settings.security.env.rateLimit'), status: t('settings.security.env.rateLimitStatus'), ok: true },
                ].map(({ label, status, ok }) => (
                  <div key={label} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`flex items-center gap-1.5 font-medium ${ok ? 'text-green-600' : 'text-red-600'}`}>
                      <CheckCircle className="h-3.5 w-3.5" />
                      {status}
                    </span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-800 mb-2">{t('settings.security.recommendationsTitle')}</p>
                <ul className="text-xs text-amber-700 space-y-1 list-disc list-inside">
                  <li>{t('settings.security.recommendations.https')}</li>
                  <li>{t('settings.security.recommendations.mfa')}</li>
                  <li>{t('settings.security.recommendations.backup')}</li>
                  <li>{t('settings.security.recommendations.sovereign')}</li>
                </ul>
              </div>
            </>
          )}

          {tab === 'notifications' && (
            <>
              <h2 className="font-semibold">{t('settings.notifications.title')}</h2>
              <div className={`flex items-center gap-2 rounded-lg p-3 text-sm ${settings.smtpConfigured ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
                <Mail className={`h-4 w-4 ${settings.smtpConfigured ? 'text-green-600' : 'text-amber-600'}`} />
                <span className={settings.smtpConfigured ? 'text-green-700' : 'text-amber-700'}>
                  {settings.smtpConfigured ? t('settings.notifications.smtpOk') : t('settings.notifications.smtpKo')}
                </span>
              </div>
              <Field label={t('settings.notifications.supportEmail')} hint={t('settings.notifications.supportEmailHint')}>
                <input type="email" className={inputCls} value={settings.support_email ?? 'support@nexusrh-ci.com'}
                  onChange={e => update('support_email', e.target.value)} />
              </Field>
              <Field label={t('settings.notifications.supportPhone')} hint={t('settings.notifications.supportPhoneHint')}>
                <input className={inputCls} value={settings.support_phone ?? '+225 07 09 32 05 94'}
                  onChange={e => update('support_phone', e.target.value)} />
              </Field>
              <Field label={t('settings.notifications.supportWhatsapp')} hint={t('settings.notifications.supportWhatsappHint')}>
                <input className={inputCls} value={settings.support_whatsapp ?? '+225 07 09 32 05 94'}
                  onChange={e => update('support_whatsapp', e.target.value)}
                  placeholder="+225 07 09 32 05 94" />
              </Field>
              <Field label={t('settings.notifications.welcomeSignature')} hint={t('settings.notifications.welcomeSignatureHint')}>
                <textarea rows={3} className={inputCls}
                  value={settings.welcome_email_signature ?? t('settings.notifications.defaultSignature')}
                  onChange={e => update('welcome_email_signature', e.target.value)} />
              </Field>
              <div className="rounded-lg bg-muted/30 p-4">
                <p className="text-sm font-medium mb-2">{t('settings.notifications.autoEmailsTitle')}</p>
                <div className="space-y-2">
                  {[
                    t('settings.notifications.autoEmails.welcome'),
                    t('settings.notifications.autoEmails.resetPassword'),
                    t('settings.notifications.autoEmails.payslip'),
                    t('settings.notifications.autoEmails.absence'),
                    t('settings.notifications.autoEmails.expense'),
                  ].map(e => (
                    <div key={e} className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                      <span className="text-muted-foreground">{e}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              <h2 className="font-semibold">{t('settings.ai.title')}</h2>
              <div className={`flex items-start gap-3 rounded-lg p-4 ${settings.aiConfigured ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
                <Bot className={`h-5 w-5 mt-0.5 ${settings.aiConfigured ? 'text-green-600' : 'text-amber-600'}`} />
                <div>
                  <p className={`text-sm font-semibold ${settings.aiConfigured ? 'text-green-800' : 'text-amber-800'}`}>
                    {settings.aiConfigured ? t('settings.ai.operationalTitle') : t('settings.ai.missingKeyTitle')}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {settings.aiConfigured
                      ? t('settings.ai.operationalDesc')
                      : t('settings.ai.missingKeyDesc')}
                  </p>
                </div>
              </div>
              <Toggle checked={settings.ai_enabled ?? true}
                onChange={v => update('ai_enabled', v)}
                label={t('settings.ai.enableToggle')} />
              <div className="rounded-lg bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">{t('settings.ai.featuresTitle')}</p>
                {[
                  { label: t('settings.ai.features.chat'), roles: t('settings.ai.features.chatRoles') },
                  { label: t('settings.ai.features.simulator'), roles: t('settings.ai.features.simulatorRoles') },
                  { label: t('settings.ai.features.docs'), roles: t('settings.ai.features.docsRoles') },
                  { label: t('settings.ai.features.retention'), roles: t('settings.ai.features.retentionRoles') },
                ].map(({ label, roles }) => (
                  <div key={label} className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-2">
                      <CheckCircle className={`h-3.5 w-3.5 mt-0.5 ${settings.aiConfigured ? 'text-green-500' : 'text-muted-foreground'}`} />
                      <span className="text-sm">{label}</span>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{roles}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-sm font-medium mb-1">{t('settings.ai.modelTitle')}</p>
                <code className="text-xs bg-muted px-2 py-1 rounded">claude-sonnet-4-20250514</code>
                <p className="text-xs text-muted-foreground mt-2">
                  {t('settings.ai.modelNote')}
                </p>
              </div>
            </>
          )}

          {tab === 'store-lois' && <StoreDeLoisTab />}

          {tab === 'multi-leg' && <MultiLegTab />}

          {tab === 'sourcing-ia' && <SourcingIaConfigTab />}

          {tab === 'legal' && (
            <>
              <h2 className="font-semibold">{t('settings.legal.title')}</h2>
              <Field label={t('settings.legal.legalName')}>
                <input className={inputCls} value={settings.legal_name ?? t('settings.legal.defaultLegalName')}
                  onChange={e => update('legal_name', e.target.value)} />
              </Field>
              <Field label={t('settings.legal.address')}>
                <textarea className={inputCls} rows={2}
                  value={settings.legal_address ?? t('settings.legal.defaultAddress')}
                  onChange={e => update('legal_address', e.target.value)} />
              </Field>
              <div className="rounded-lg bg-muted/30 p-4 space-y-2">
                <p className="text-sm font-medium">{t('settings.legal.complianceTitle')}</p>
                {[
                  t('settings.legal.compliance.dataLaw'),
                  t('settings.legal.compliance.labourCode'),
                  t('settings.legal.compliance.cnps'),
                  t('settings.legal.compliance.disa'),
                  t('settings.legal.compliance.ohada'),
                ].map(item => (
                  <div key={item} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CheckCircle className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Onglet Sourcing IA — paramétrage 100% via DB platform.*
// ─────────────────────────────────────────────────────────────────────────────

interface AiModel {
  id: string; provider: string; model_id: string; display_name: string
  max_tokens: number; input_cost_per_1m_eur: number; output_cost_per_1m_eur: number
  is_active: boolean; sort_order: number
}

interface SourcingPlatform {
  id: string; code: string; name: string
  country_code: string | null; url: string | null; est_pool: number | null
  is_active: boolean; is_panafrican: boolean; sort_order: number
}

type SourcingSettingsDto = {
  max_profiles_min?: number; max_profiles_max?: number; max_profiles_default?: number
  max_cost_eur_per_request?: number
  claude_system_prompt?: string; mistral_system_prompt?: string
  richness_weights?: Record<string, number>
}

function SourcingIaConfigTab() {
  const { t } = useTranslation('platform')
  const queryClient = useQueryClient()
  const [section, setSection] = useState<'models' | 'platforms' | 'prompts' | 'advanced'>('models')

  const sections: Array<{ key: typeof section; labelKey: string }> = [
    { key: 'models',    labelKey: 'models' },
    { key: 'platforms', labelKey: 'platforms' },
    { key: 'prompts',   labelKey: 'prompts' },
    { key: 'advanced',  labelKey: 'advanced' },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          {t('settings.sourcingIa.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('settings.sourcingIa.subtitle')}
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {sections.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${section === s.key ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t(`settings.sourcingIa.sections.${s.labelKey}`)}
          </button>
        ))}
      </div>

      {section === 'models'    && <ModelsSection qc={queryClient} />}
      {section === 'platforms' && <PlatformsSection qc={queryClient} />}
      {section === 'prompts'   && <PromptsSection qc={queryClient} />}
      {section === 'advanced'  && <AdvancedSection qc={queryClient} />}
    </div>
  )
}

function ModelsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('platform')
  const [editing, setEditing] = useState<AiModel | null>(null)
  const [showNew, setShowNew] = useState(false)

  const { data } = useQuery<{ data: AiModel[] }>({
    queryKey: ['sourcing-models'],
    queryFn: () => api.get('/platform/sourcing/models').then(r => r.data),
  })
  const models = data?.data ?? []

  const save = useMutation({
    mutationFn: (m: Partial<AiModel> & { id?: string }) => {
      return m.id
        ? api.patch(`/platform/sourcing/models/${m.id}`, m)
        : api.post('/platform/sourcing/models', m)
    },
    onSuccess: () => { setEditing(null); setShowNew(false); qc.invalidateQueries({ queryKey: ['sourcing-models'] }) },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/platform/sourcing/models/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sourcing-models'] }),
  })

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          {t('settings.sourcingIa.models.count', { count: models.length })}
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> {t('settings.sourcingIa.models.addButton')}
        </button>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">{t('settings.sourcingIa.models.table.provider')}</th>
              <th className="p-3">{t('settings.sourcingIa.models.table.model')}</th>
              <th className="p-3 text-right">{t('settings.sourcingIa.models.table.inputCost')}</th>
              <th className="p-3 text-right">{t('settings.sourcingIa.models.table.outputCost')}</th>
              <th className="p-3 text-right">{t('settings.sourcingIa.models.table.maxTokens')}</th>
              <th className="p-3 text-center">{t('settings.sourcingIa.models.table.active')}</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.map(m => (
              <tr key={m.id} className="hover:bg-muted/20">
                <td className="p-3 font-medium uppercase text-xs">{m.provider}</td>
                <td className="p-3">
                  <div>{m.display_name}</div>
                  <code className="text-[10px] text-muted-foreground">{m.model_id}</code>
                </td>
                <td className="p-3 text-right font-mono text-xs">{m.input_cost_per_1m_eur.toFixed(2)} €</td>
                <td className="p-3 text-right font-mono text-xs">{m.output_cost_per_1m_eur.toFixed(2)} €</td>
                <td className="p-3 text-right font-mono text-xs">{m.max_tokens}</td>
                <td className="p-3 text-center">
                  {m.is_active
                    ? <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">ON</span>
                    : <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">OFF</span>}
                </td>
                <td className="p-3 text-right space-x-1">
                  <button onClick={() => setEditing(m)} className="text-muted-foreground hover:text-primary" title={t('settings.sourcingIa.models.edit')}>
                    <Edit3 className="inline h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { if (confirm(t('settings.sourcingIa.models.deleteConfirm'))) remove.mutate(m.id) }}
                    className="text-red-400 hover:text-red-600" title={t('settings.sourcingIa.models.delete')}>
                    <Trash2 className="inline h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground text-sm">{t('settings.sourcingIa.models.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(editing || showNew) && (
        <ModelEditModal
          model={editing}
          onClose={() => { setEditing(null); setShowNew(false) }}
          onSave={(m) => save.mutate(m)}
          submitting={save.isPending}
        />
      )}
    </div>
  )
}

function ModelEditModal({ model, onClose, onSave, submitting }: {
  model: AiModel | null
  onClose: () => void
  onSave: (m: Partial<AiModel> & { id?: string }) => void
  submitting: boolean
}) {
  const { t } = useTranslation('platform')
  const [form, setForm] = useState<Partial<AiModel>>(model ?? {
    provider: 'claude', model_id: '', display_name: '',
    max_tokens: 4000, input_cost_per_1m_eur: 0, output_cost_per_1m_eur: 0,
    is_active: true, sort_order: 0,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-3 font-semibold">
          {model ? t('settings.sourcingIa.models.modal.editTitle') : t('settings.sourcingIa.models.modal.newTitle')}
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.models.modal.provider')}</label>
              <select value={form.provider} onChange={e => setForm(p => ({ ...p, provider: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="claude">{t('settings.sourcingIa.models.modal.providerClaude')}</option>
                <option value="mistral">{t('settings.sourcingIa.models.modal.providerMistral')}</option>
                <option value="openai">{t('settings.sourcingIa.models.modal.providerOpenai')}</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.models.modal.modelId')}</label>
              <input value={form.model_id ?? ''} onChange={e => setForm(p => ({ ...p, model_id: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
                placeholder="claude-sonnet-4-20250514" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.models.modal.displayName')}</label>
            <input value={form.display_name ?? ''} onChange={e => setForm(p => ({ ...p, display_name: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.models.modal.maxTokens')}</label>
              <input type="number" value={form.max_tokens ?? 0}
                onChange={e => setForm(p => ({ ...p, max_tokens: parseInt(e.target.value) || 0 }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.models.modal.inputCost')}</label>
              <input type="number" step="0.01" value={form.input_cost_per_1m_eur ?? 0}
                onChange={e => setForm(p => ({ ...p, input_cost_per_1m_eur: parseFloat(e.target.value) || 0 }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.models.modal.outputCost')}</label>
              <input type="number" step="0.01" value={form.output_cost_per_1m_eur ?? 0}
                onChange={e => setForm(p => ({ ...p, output_cost_per_1m_eur: parseFloat(e.target.value) || 0 }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.is_active ?? true}
                onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))} />
              {t('settings.sourcingIa.models.modal.active')}
            </label>
            <div>
              <label className="text-xs text-muted-foreground mr-2">{t('settings.sourcingIa.models.modal.order')}</label>
              <input type="number" value={form.sort_order ?? 0}
                onChange={e => setForm(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))}
                className="w-20 rounded border border-input bg-background px-2 py-1 text-sm" />
            </div>
          </div>
        </div>
        <div className="border-t border-border px-5 py-3 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('settings.sourcingIa.models.modal.cancel')}</button>
          <button onClick={() => onSave({ ...form, id: model?.id })}
            disabled={!form.provider || !form.model_id || !form.display_name || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? t('settings.sourcingIa.models.modal.saving') : t('settings.sourcingIa.models.modal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function PlatformsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('platform')
  const [editing, setEditing] = useState<SourcingPlatform | null>(null)
  const [showNew, setShowNew] = useState(false)

  const { data } = useQuery<{ data: SourcingPlatform[] }>({
    queryKey: ['sourcing-platforms-all'],
    queryFn: () => api.get('/platform/sourcing/platforms').then(r => r.data),
  })
  const platforms = data?.data ?? []

  const save = useMutation({
    mutationFn: (p: Partial<SourcingPlatform> & { id?: string }) => {
      return p.id
        ? api.patch(`/platform/sourcing/platforms/${p.id}`, p)
        : api.post('/platform/sourcing/platforms', p)
    },
    onSuccess: () => { setEditing(null); setShowNew(false); qc.invalidateQueries({ queryKey: ['sourcing-platforms-all'] }) },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/platform/sourcing/platforms/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sourcing-platforms-all'] }),
  })

  const panafrican = platforms.filter(p => p.is_panafrican)
  const byCountry = new Map<string, SourcingPlatform[]>()
  for (const p of platforms.filter(p => !p.is_panafrican)) {
    const cc = p.country_code ?? '—'
    if (!byCountry.has(cc)) byCountry.set(cc, [])
    byCountry.get(cc)!.push(p)
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          {t('settings.sourcingIa.platforms.count', { count: platforms.length, panafrican: panafrican.length, local: platforms.length - panafrican.length })}
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> {t('settings.sourcingIa.platforms.addButton')}
        </button>
      </div>

      {panafrican.length > 0 && (
        <PlatformGroup title={t('settings.sourcingIa.platforms.groupPanafrican')} platforms={panafrican}
          onEdit={setEditing} onRemove={id => remove.mutate(id)} />
      )}
      {Array.from(byCountry.entries()).sort().map(([cc, list]) => (
        <PlatformGroup key={cc} title={t('settings.sourcingIa.platforms.groupCountry', { country: cc })} platforms={list}
          onEdit={setEditing} onRemove={id => remove.mutate(id)} />
      ))}
      {platforms.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('settings.sourcingIa.platforms.empty')}
        </div>
      )}

      {(editing || showNew) && (
        <PlatformEditModal platform={editing}
          onClose={() => { setEditing(null); setShowNew(false) }}
          onSave={(p) => save.mutate(p)}
          submitting={save.isPending} />
      )}
    </div>
  )
}

function PlatformGroup({ title, platforms, onEdit, onRemove }: {
  title: string
  platforms: SourcingPlatform[]
  onEdit: (p: SourcingPlatform) => void
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation('platform')
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground uppercase">
        {t('settings.sourcingIa.platforms.groupCount', { title, count: platforms.length })}
      </div>
      <div className="divide-y divide-border">
        {platforms.map(p => (
          <div key={p.id} className="flex items-center justify-between px-3 py-2 hover:bg-muted/20">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {p.name}
                {!p.is_active && <span className="text-[10px] text-muted-foreground">{t('settings.sourcingIa.platforms.inactive')}</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                <code>{p.code}</code>
                {p.url && <> · {p.url}</>}
                {p.est_pool && <> · {t('settings.sourcingIa.platforms.profiles', { count: p.est_pool })}</>}
              </div>
            </div>
            <div className="flex gap-1">
              <button onClick={() => onEdit(p)} className="text-muted-foreground hover:text-primary p-1">
                <Edit3 className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => { if (confirm(t('settings.sourcingIa.platforms.deleteConfirm'))) onRemove(p.id) }}
                className="text-red-400 hover:text-red-600 p-1">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PlatformEditModal({ platform, onClose, onSave, submitting }: {
  platform: SourcingPlatform | null
  onClose: () => void
  onSave: (p: Partial<SourcingPlatform> & { id?: string }) => void
  submitting: boolean
}) {
  const { t } = useTranslation('platform')
  const [form, setForm] = useState<Partial<SourcingPlatform>>(platform ?? {
    code: '', name: '', country_code: null, url: null, est_pool: null,
    is_active: true, is_panafrican: false, sort_order: 0,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-3 font-semibold">
          {platform ? t('settings.sourcingIa.platforms.modal.editTitle') : t('settings.sourcingIa.platforms.modal.newTitle')}
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.platforms.modal.code')}</label>
              <input value={form.code ?? ''} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
                placeholder="emploi_ci" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.platforms.modal.name')}</label>
              <input value={form.name ?? ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="Emploi.ci" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.platforms.modal.countryCode')}</label>
              <input value={form.country_code ?? ''}
                onChange={e => setForm(p => ({ ...p, country_code: e.target.value || null }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
                placeholder="CI" maxLength={5} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.platforms.modal.url')}</label>
              <input value={form.url ?? ''}
                onChange={e => setForm(p => ({ ...p, url: e.target.value || null }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 items-center">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('settings.sourcingIa.platforms.modal.estPool')}</label>
              <input type="number" value={form.est_pool ?? ''}
                onChange={e => setForm(p => ({ ...p, est_pool: e.target.value ? parseInt(e.target.value) : null }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
            <label className="flex items-center gap-2 text-sm pt-5">
              <input type="checkbox" checked={form.is_active ?? true}
                onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))} />
              {t('settings.sourcingIa.platforms.modal.active')}
            </label>
            <label className="flex items-center gap-2 text-sm pt-5">
              <input type="checkbox" checked={form.is_panafrican ?? false}
                onChange={e => setForm(p => ({ ...p, is_panafrican: e.target.checked }))} />
              {t('settings.sourcingIa.platforms.modal.panafrican')}
            </label>
          </div>
        </div>
        <div className="border-t border-border px-5 py-3 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('settings.sourcingIa.platforms.modal.cancel')}</button>
          <button onClick={() => onSave({ ...form, id: platform?.id })}
            disabled={!form.code || !form.name || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? t('settings.sourcingIa.platforms.modal.saving') : t('settings.sourcingIa.platforms.modal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function PromptsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('platform')
  const { data } = useQuery<{ data: SourcingSettingsDto }>({
    queryKey: ['sourcing-settings'],
    queryFn: () => api.get('/platform/sourcing/settings').then(r => r.data),
  })
  const settings = data?.data ?? {}
  const [claude, setClaude]   = useState('')
  const [mistral, setMistral] = useState('')
  const [dirty, setDirty]     = useState(false)

  React.useEffect(() => {
    setClaude(settings.claude_system_prompt ?? '')
    setMistral(settings.mistral_system_prompt ?? '')
  }, [settings.claude_system_prompt, settings.mistral_system_prompt])

  const save = useMutation({
    mutationFn: (body: SourcingSettingsDto) => api.patch('/platform/sourcing/settings', body),
    onSuccess: () => { setDirty(false); qc.invalidateQueries({ queryKey: ['sourcing-settings'] }) },
  })

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-xs text-blue-900">
        <Trans i18nKey="settings.sourcingIa.prompts.tip" ns="platform" components={[<strong />]} />
      </div>

      <div>
        <label className="text-xs font-semibold uppercase text-muted-foreground">
          {t('settings.sourcingIa.prompts.claudeLabel')}
        </label>
        <textarea
          value={claude}
          onChange={e => { setClaude(e.target.value); setDirty(true) }}
          rows={10}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono"
          placeholder={t('settings.sourcingIa.prompts.promptPlaceholder')}
        />
      </div>

      <div>
        <label className="text-xs font-semibold uppercase text-muted-foreground">
          {t('settings.sourcingIa.prompts.mistralLabel')}
        </label>
        <textarea
          value={mistral}
          onChange={e => { setMistral(e.target.value); setDirty(true) }}
          rows={10}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono"
          placeholder={t('settings.sourcingIa.prompts.promptPlaceholder')}
        />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={() => save.mutate({ claude_system_prompt: claude, mistral_system_prompt: mistral })}
          disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t('settings.sourcingIa.prompts.save')}
        </button>
      </div>
    </div>
  )
}

function AdvancedSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('platform')
  const { data } = useQuery<{ data: SourcingSettingsDto }>({
    queryKey: ['sourcing-settings'],
    queryFn: () => api.get('/platform/sourcing/settings').then(r => r.data),
  })
  const s = data?.data ?? {}

  const [form, setForm] = useState({
    min: 1, max: 20, def: 8, budget: 0,
    weights: '{}',
  })
  const [dirty, setDirty] = useState(false)

  React.useEffect(() => {
    setForm({
      min:    s.max_profiles_min     ?? 1,
      max:    s.max_profiles_max     ?? 20,
      def:    s.max_profiles_default ?? 8,
      budget: s.max_cost_eur_per_request ?? 0,
      weights: JSON.stringify(s.richness_weights ?? {
        hasProfiles: 20, fiveProfiles: 10, perProfile: 2,
        hasBooleanSearch: 10, hasKeywords: 10, hasSalaryBenchmark: 10,
        hasBestPlatforms: 10, hasTips: 5,
        firstProfileLinkedin: 5, firstProfileApproach: 5, firstProfileSkills: 5,
      }, null, 2),
    })
  }, [s.max_profiles_min, s.max_profiles_max, s.max_profiles_default, s.max_cost_eur_per_request, s.richness_weights])

  const save = useMutation({
    mutationFn: (body: SourcingSettingsDto) => api.patch('/platform/sourcing/settings', body),
    onSuccess: () => { setDirty(false); qc.invalidateQueries({ queryKey: ['sourcing-settings'] }) },
  })

  const onSave = () => {
    let weights: Record<string, number>
    try { weights = JSON.parse(form.weights) }
    catch { alert(t('settings.sourcingIa.advanced.weightsInvalid')); return }
    save.mutate({
      max_profiles_min:         form.min,
      max_profiles_max:         form.max,
      max_profiles_default:     form.def,
      max_cost_eur_per_request: form.budget,
      richness_weights:         weights,
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="font-semibold text-sm mb-3">{t('settings.sourcingIa.advanced.sliderTitle')}</h3>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">{t('settings.sourcingIa.advanced.min')}</label>
            <input type="number" value={form.min}
              onChange={e => { setForm(p => ({ ...p, min: parseInt(e.target.value) || 1 })); setDirty(true) }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('settings.sourcingIa.advanced.max')}</label>
            <input type="number" value={form.max}
              onChange={e => { setForm(p => ({ ...p, max: parseInt(e.target.value) || 20 })); setDirty(true) }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('settings.sourcingIa.advanced.default')}</label>
            <input type="number" value={form.def}
              onChange={e => { setForm(p => ({ ...p, def: parseInt(e.target.value) || 8 })); setDirty(true) }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="font-semibold text-sm mb-3">{t('settings.sourcingIa.advanced.budgetTitle')}</h3>
        <div className="flex items-center gap-3">
          <input type="number" step="0.01" value={form.budget}
            onChange={e => { setForm(p => ({ ...p, budget: parseFloat(e.target.value) || 0 })); setDirty(true) }}
            className="w-32 rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          <span className="text-sm text-muted-foreground">{t('settings.sourcingIa.advanced.budgetUnit')}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {t('settings.sourcingIa.advanced.budgetHint')}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="font-semibold text-sm mb-3">{t('settings.sourcingIa.advanced.weightsTitle')}</h3>
        <textarea value={form.weights}
          onChange={e => { setForm(p => ({ ...p, weights: e.target.value })); setDirty(true) }}
          rows={14}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono" />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onSave} disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t('settings.sourcingIa.advanced.save')}
        </button>
      </div>
    </div>
  )
}
