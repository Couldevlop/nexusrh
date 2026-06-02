import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
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

const TABS: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
  { key: 'general',       label: 'Général',         icon: Settings   },
  { key: 'security',      label: 'Sécurité',        icon: Shield     },
  { key: 'notifications', label: 'Notifications',   icon: Bell       },
  { key: 'ai',            label: 'IA & Claude',     icon: Bot        },
  { key: 'legal',         label: 'Entreprise',      icon: Building2  },
  { key: 'store-lois',    label: 'Store de Lois',   icon: Scale      },
  { key: 'multi-leg',     label: 'Multi-législatif',icon: Globe      },
  { key: 'sourcing-ia',   label: 'Sourcing IA',     icon: Sparkles   },
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

// Métadonnées locales pour transformer le JSONB constants en liste affichable
const CONSTANT_META: Record<string, { label: string; unit: string; category: string }> = {
  SMIG_MENSUEL:                 { label: 'SMIG mensuel',              unit: 'FCFA',   category: 'smig' },
  SMIG_HORAIRE:                 { label: 'SMIG horaire (173,33h)',     unit: 'FCFA/h', category: 'smig' },
  PLAFOND_CNPS_AT_PF_MENSUEL:   { label: 'Plafond AT / PF / Maternité', unit: 'FCFA/mois', category: 'cnps' },
  PLAFOND_CNPS_RETRAITE_MENSUEL:{ label: 'Plafond retraite',           unit: 'FCFA/mois', category: 'cnps' },
  TAUX_CNPS_RETRAITE_SAL:       { label: 'Retraite salarial',          unit: '%',      category: 'cnps' },
  TAUX_CNPS_RETRAITE_PAT:       { label: 'Retraite patronal',          unit: '%',      category: 'cnps' },
  TAUX_CNPS_PF_PAT:             { label: 'Prestations familiales pat.', unit: '%',     category: 'cnps' },
  TAUX_CNPS_MATERNITE_PAT:      { label: 'Assurance maternité pat.',   unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_COMMERCE:        { label: 'AT — Commerce/Services',     unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_BTP:             { label: 'AT — BTP/Transport',         unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_INDUSTRIE:       { label: 'AT — Industrie',             unit: '%',      category: 'cnps' },
  TAUX_CNPS_AT_EXTRACTION:      { label: 'AT — Extraction/Mines',      unit: '%',      category: 'cnps' },
  ABATTEMENT_ITS:               { label: 'Abattement forfaitaire ITS',  unit: '%',     category: 'its' },
  CREDIT_IMPOT_MARIE:           { label: "Crédit impôt — marié(e)",    unit: 'FCFA/mois', category: 'its' },
  CREDIT_IMPOT_1ENFANT:         { label: 'Crédit impôt — 1 enfant',    unit: 'FCFA/mois', category: 'its' },
  CREDIT_IMPOT_2ENFANTS:        { label: 'Crédit impôt — 2 enfants',   unit: 'FCFA/mois', category: 'its' },
  CREDIT_IMPOT_3ENFANTS_PLUS:   { label: 'Crédit impôt — 3 enfants+',  unit: 'FCFA/mois', category: 'its' },
  CONGES_JOURS_PAR_MOIS:        { label: 'Congés par mois travaillé',  unit: 'j/mois', category: 'conges' },
  CONTRIBUTION_FDFP:            { label: 'Contribution FDFP (>10 sal)', unit: '% masse sal.', category: 'fdfp' },
}

const CATEGORY_LABELS: Record<string, string> = {
  smig: 'SMIG & Salaires',
  cnps: 'CNPS — Cotisations',
  its: 'ITS / DGI — Impôt',
  conges: 'Congés & Absences',
  fdfp: 'FDFP — Formation',
}

function StoreDeLoisTab() {
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
      label: CONSTANT_META[key]!.label,
      unit:  CONSTANT_META[key]!.unit,
      category: CONSTANT_META[key]!.category,
      value: value as string | number,
      effective_date: '',
    }))

  const categories = Object.keys(CATEGORY_LABELS).filter(cat =>
    constants.some(c => c.category === cat)
  )

  if (isLoading) return <div className="flex justify-center p-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold">Store de Lois — CI 2024</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Constantes légales appliquées par le moteur de paie. Mis à jour lors des changements législatifs.
          </p>
        </div>
        <span className="rounded-full bg-green-100 text-green-700 text-xs font-medium px-3 py-1">
          CI · Version 2024 · En vigueur
        </span>
      </div>

      {categories.map(cat => {
        const items = constants.filter(c => c.category === cat)
        return (
          <div key={cat} className="rounded-xl border border-border overflow-hidden">
            <div className="bg-muted/40 border-b border-border px-4 py-2.5">
              <p className="text-sm font-semibold">{CATEGORY_LABELS[cat] ?? cat}</p>
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
                        Modifier
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
        <strong>Important :</strong> Toute modification est journalisée dans les logs d'audit.
        Les changements de SMIG sont notifiés aux tenants concernés. Vérifiez les textes légaux avant de modifier.
      </div>
    </div>
  )
}

function MultiLegTab() {
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
        <h2 className="font-semibold">Multi-législatif — Couverture Afrique</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Moteurs de paie par pays. Chaque pays a ses propres taux sociaux, barèmes fiscaux et constantes légales.
          <span className="ml-2 inline-flex items-center gap-2 text-xs">
            <span className="rounded bg-green-100 px-1.5 py-0.5 font-medium text-green-700">{activeCount} actifs</span>
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
                    {c.is_active ? 'Actif' : 'Planifié'}
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
                  <span className="text-muted-foreground">Moteur de paie</span>
                  <code className="bg-muted px-1.5 rounded">{c.payroll_engine}</code>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SMIG mensuel</span>
                  <span className="font-mono font-semibold">
                    {(c.config?.smig ?? 0).toLocaleString('fr-FR')} {c.currency}
                  </span>
                </div>
              </div>
              {!c.is_active && (
                <div className="mt-3 rounded bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                  Disponible sur demande — contactez OpenLab Consulting
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm">
        <p className="font-semibold text-blue-800 mb-2">Couverture régionale Afrique</p>
        <div className="space-y-1 text-blue-700 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-green-600 font-bold">✓</span>
            <span><strong>UEMOA</strong> — Côte d'Ivoire (prod), Sénégal, Bénin, Togo, Burkina Faso, Mali, Niger · XOF</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-600 font-bold">✓</span>
            <span><strong>CEMAC</strong> — Cameroun, Tchad · XAF</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-blue-600 font-bold">✓</span>
            <span><strong>CEDEAO hors UEMOA</strong> — Nigeria (NGN), Ghana (GHS)</span>
          </div>
        </div>
      </div>

      <div className="rounded-lg bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">Architecture technique</p>
        <p className="text-xs text-muted-foreground">
          Chaque moteur de paie est un module indépendant (
          <code className="bg-muted px-1 rounded">payroll-engine-ci</code>,{' '}
          <code className="bg-muted px-1 rounded">payroll-engine-sn</code>…).
          Le middleware résout automatiquement le bon moteur selon le pays du tenant.
          Les constantes légales sont versionées dans <code className="bg-muted px-1 rounded">platform.legal_constants</code>.
        </p>
      </div>
    </div>
  )
}

export default function PlatformSettings() {
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
          <h1 className="text-2xl font-bold">Paramètres Plateforme</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configuration globale NexusRH CI · v{settings.version ?? '1.0.0'} · {settings.environment ?? 'development'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <CheckCircle className="h-4 w-4" /> Enregistré
            </span>
          )}
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || Object.keys(form).length === 0}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Enregistrer
          </button>
        </div>
      </div>

      {/* Statut systèmes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'IA Claude',      ok: settings.aiConfigured,   icon: Bot,   hint: settings.aiConfigured ? 'API key configurée' : 'ANTHROPIC_API_KEY manquant' },
          { label: 'Email SMTP',     ok: settings.smtpConfigured, icon: Mail,  hint: settings.smtpConfigured ? 'Transporter actif' : 'SMTP_USER manquant' },
          { label: 'Mode maintenance', ok: !settings.maintenance_mode, icon: AlertCircle, hint: settings.maintenance_mode ? 'ACTIF — site inaccessible' : 'Désactivé' },
          { label: 'Nouveaux tenants', ok: settings.allow_new_tenants, icon: Building2, hint: settings.allow_new_tenants ? 'Inscriptions ouvertes' : 'Fermé' },
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
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-left transition-colors ${
                tab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Contenu */}
        <div className="flex-1 rounded-xl border border-border bg-card p-6 space-y-5">
          {tab === 'general' && (
            <>
              <h2 className="font-semibold">Paramètres généraux</h2>
              <Field label="Nom de l'application" hint="Affiché dans les emails et l'interface">
                <input className={inputCls} value={settings.app_name ?? 'NexusRH CI'}
                  onChange={e => update('app_name', e.target.value)} />
              </Field>
              <Field label="Période d'essai par défaut (jours)">
                <input type="number" className={inputCls} value={settings.default_trial_days ?? 30}
                  onChange={e => update('default_trial_days', parseInt(e.target.value))} min={7} max={90} />
              </Field>
              <Field label="Nombre max de tenants" hint="0 = illimité">
                <input type="number" className={inputCls} value={settings.max_tenants ?? 9999}
                  onChange={e => update('max_tenants', parseInt(e.target.value))} min={0} />
              </Field>
              <div className="space-y-3 pt-2">
                <Toggle checked={settings.allow_new_tenants ?? true}
                  onChange={v => update('allow_new_tenants', v)}
                  label="Autoriser la création de nouveaux tenants" />
                <Toggle checked={settings.maintenance_mode ?? false}
                  onChange={v => update('maintenance_mode', v)}
                  label="Mode maintenance (bloque tous les accès)" />
              </div>
              {(form.maintenance_mode) && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-red-700">Attention : activer le mode maintenance rendra l'application inaccessible pour tous les utilisateurs.</p>
                </div>
              )}
            </>
          )}

          {tab === 'security' && (
            <>
              <h2 className="font-semibold">Sécurité de la plateforme</h2>

              {/* ── Politiques paramétrables (OWASP A07) ── */}
              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">Authentification à deux facteurs (MFA)</p>
                <Toggle
                  checked={settings.mfa_required_super_admin ?? false}
                  onChange={v => update('mfa_required_super_admin', v)}
                  label="Imposer le MFA aux super_admin" />
                <p className="text-xs text-muted-foreground -mt-2">
                  Désactivé : les super_admin accèdent à la plateforme sans MFA (peuvent créer des tenants).
                  Activé : le MFA doit être configuré avant tout accès.
                </p>
                <Toggle
                  checked={settings.mfa_required_tenant_users ?? false}
                  onChange={v => update('mfa_required_tenant_users', v)}
                  label="Imposer le MFA à tous les employés des tenants" />
                <p className="text-xs text-muted-foreground -mt-2">
                  Politique globale. Chaque tenant peut la <strong>durcir</strong> (jamais l'assouplir) depuis ses propres paramètres.
                </p>
              </div>

              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">Cycle de vie des mots de passe</p>
                <Field label="Durée de vie du mot de passe (jours)" hint="0 = pas d'expiration. Au-delà, l'utilisateur doit le changer à la connexion.">
                  <input type="number" min={0} max={3650} className={inputCls}
                    value={settings.password_max_age_days ?? 30}
                    onChange={e => update('password_max_age_days', parseInt(e.target.value || '0', 10))} />
                </Field>
                <Field label="Historique anti-réutilisation" hint="Nombre de derniers mots de passe interdits à la réutilisation (0 = aucun).">
                  <input type="number" min={0} max={50} className={inputCls}
                    value={settings.password_history_count ?? 5}
                    onChange={e => update('password_history_count', parseInt(e.target.value || '0', 10))} />
                </Field>
                <Toggle
                  checked={settings.breach_check_enabled ?? true}
                  onChange={v => update('breach_check_enabled', v)}
                  label="Vérifier les mots de passe contre les fuites connues (HaveIBeenPwned)" />
                <p className="text-xs text-muted-foreground -mt-2">
                  À chaque connexion (si accès internet), le mot de passe est comparé — en k-anonymat, sans jamais quitter le serveur —
                  aux fuites connues. S'il est compromis, le changement est imposé. Sans internet : contrôle ignoré (non bloquant).
                </p>
              </div>

              <div className="rounded-lg border border-border p-4 space-y-4">
                <p className="text-sm font-semibold">Verrouillage de compte (anti-force brute)</p>
                <Toggle
                  checked={settings.lockout_enabled ?? true}
                  onChange={v => update('lockout_enabled', v)}
                  label="Verrouiller un compte après trop d'échecs de connexion" />
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Seuil d'échecs" hint="0 = désactivé">
                    <input type="number" min={0} max={50} className={inputCls}
                      value={settings.lockout_max_attempts ?? 5}
                      onChange={e => update('lockout_max_attempts', parseInt(e.target.value || '0', 10))} />
                  </Field>
                  <Field label="Fenêtre (min)" hint="comptage">
                    <input type="number" min={1} max={1440} className={inputCls}
                      value={settings.lockout_window_minutes ?? 15}
                      onChange={e => update('lockout_window_minutes', parseInt(e.target.value || '1', 10))} />
                  </Field>
                  <Field label="Durée verrou (min)" hint="blocage">
                    <input type="number" min={1} max={1440} className={inputCls}
                      value={settings.lockout_duration_minutes ?? 15}
                      onChange={e => update('lockout_duration_minutes', parseInt(e.target.value || '1', 10))} />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">
                  Après {settings.lockout_max_attempts ?? 5} échecs en {settings.lockout_window_minutes ?? 15} min,
                  le compte est bloqué {settings.lockout_duration_minutes ?? 15} min (réponse 423). Le rate-limiting
                  par IP reste actif en complément ; en cas de panne Redis, le verrouillage est ignoré (fail-open).
                </p>
              </div>

              <div className="rounded-lg bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">Autres mesures (configurées via .env)</p>
                {[
                  { label: 'JWT Secret', status: 'Configuré', ok: true },
                  { label: 'JWT Expiration', status: '7 jours', ok: true },
                  { label: 'MFA disponible', status: 'TOTP activé', ok: true },
                  { label: 'Bcrypt rounds', status: '12 rounds', ok: true },
                  { label: 'CORS', status: 'Configuré', ok: true },
                  { label: 'Rate limiting', status: 'Actif', ok: true },
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
                <p className="text-sm font-medium text-amber-800 mb-2">Recommandations CI :</p>
                <ul className="text-xs text-amber-700 space-y-1 list-disc list-inside">
                  <li>Utiliser HTTPS en production (certificat Let's Encrypt)</li>
                  <li>Activer MFA pour tous les comptes super_admin</li>
                  <li>Configurer un backup PostgreSQL quotidien</li>
                  <li>Hébergement souverain CI pour clients secteur public</li>
                </ul>
              </div>
            </>
          )}

          {tab === 'notifications' && (
            <>
              <h2 className="font-semibold">Notifications & Email</h2>
              <div className={`flex items-center gap-2 rounded-lg p-3 text-sm ${settings.smtpConfigured ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
                <Mail className={`h-4 w-4 ${settings.smtpConfigured ? 'text-green-600' : 'text-amber-600'}`} />
                <span className={settings.smtpConfigured ? 'text-green-700' : 'text-amber-700'}>
                  {settings.smtpConfigured ? 'Email SMTP configuré et opérationnel' : 'SMTP non configuré — les emails ne seront pas envoyés'}
                </span>
              </div>
              <Field label="Email de support" hint="Affiché dans les emails envoyés aux clients">
                <input type="email" className={inputCls} value={settings.support_email ?? 'support@nexusrh-ci.com'}
                  onChange={e => update('support_email', e.target.value)} />
              </Field>
              <Field label="Téléphone de support CI" hint="Format : +225 XX XX XX XX XX">
                <input className={inputCls} value={settings.support_phone ?? '+225 07 09 32 05 94'}
                  onChange={e => update('support_phone', e.target.value)} />
              </Field>
              <Field label="WhatsApp support" hint="Affiché dans les emails de bienvenue tenant · Format +225 XXXXXXXXXX">
                <input className={inputCls} value={settings.support_whatsapp ?? '+225 07 09 32 05 94'}
                  onChange={e => update('support_whatsapp', e.target.value)}
                  placeholder="+225 07 09 32 05 94" />
              </Field>
              <Field label="Signature email de bienvenue" hint="Texte affiché en bas de l'email envoyé à la création d'un tenant">
                <textarea rows={3} className={inputCls}
                  value={settings.welcome_email_signature ?? 'L\'équipe NexusRH CI · OpenLab Consulting · Abidjan'}
                  onChange={e => update('welcome_email_signature', e.target.value)} />
              </Field>
              <div className="rounded-lg bg-muted/30 p-4">
                <p className="text-sm font-medium mb-2">Emails déclenchés automatiquement</p>
                <div className="space-y-2">
                  {[
                    'Bienvenue admin à la création du tenant',
                    'Réinitialisation mot de passe admin',
                    'Bulletin de paie disponible (employé)',
                    'Demande d\'absence en attente (manager)',
                    'Note de frais à valider',
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
              <h2 className="font-semibold">Intelligence Artificielle — Claude AI</h2>
              <div className={`flex items-start gap-3 rounded-lg p-4 ${settings.aiConfigured ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
                <Bot className={`h-5 w-5 mt-0.5 ${settings.aiConfigured ? 'text-green-600' : 'text-amber-600'}`} />
                <div>
                  <p className={`text-sm font-semibold ${settings.aiConfigured ? 'text-green-800' : 'text-amber-800'}`}>
                    {settings.aiConfigured ? 'Claude AI opérationnel' : 'Clé API manquante'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {settings.aiConfigured
                      ? 'L\'assistant IA est disponible pour tous les utilisateurs autorisés (admin, RH, managers)'
                      : 'Ajoutez ANTHROPIC_API_KEY dans votre .env pour activer l\'assistant IA'}
                  </p>
                </div>
              </div>
              <Toggle checked={settings.ai_enabled ?? true}
                onChange={v => update('ai_enabled', v)}
                label="Activer l'assistant IA dans l'interface" />
              <div className="rounded-lg bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">Fonctionnalités IA activées</p>
                {[
                  { label: 'Chat assistant RH CI (CNPS, CT, OHADA)', roles: 'Admin, RH, Managers' },
                  { label: 'Simulateur ITS/IGR quotient familial', roles: 'Tous (POST /ai/simulate-its)' },
                  { label: 'Génération documents RH (CDI, lettre...)', roles: 'Admin, RH' },
                  { label: 'Score rétention employés (analyse IA)', roles: 'Admin, RH Manager' },
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
                <p className="text-sm font-medium mb-1">Modèle utilisé</p>
                <code className="text-xs bg-muted px-2 py-1 rounded">claude-sonnet-4-20250514</code>
                <p className="text-xs text-muted-foreground mt-2">
                  Calibré contexte ivoirien : Code du Travail CI, CNPS 2024, barème ITS/DGI, OHADA, Mobile Money CI
                </p>
              </div>
            </>
          )}

          {tab === 'store-lois' && <StoreDeLoisTab />}

          {tab === 'multi-leg' && <MultiLegTab />}

          {tab === 'sourcing-ia' && <SourcingIaConfigTab />}

          {tab === 'legal' && (
            <>
              <h2 className="font-semibold">Informations légales — OpenLab Consulting</h2>
              <Field label="Raison sociale éditeur">
                <input className={inputCls} value={settings.legal_name ?? 'OpenLab Consulting'}
                  onChange={e => update('legal_name', e.target.value)} />
              </Field>
              <Field label="Adresse">
                <textarea className={inputCls} rows={2}
                  value={settings.legal_address ?? 'Cocody, Rivièra Faya Lauriers 8, Abidjan, Côte d\'Ivoire'}
                  onChange={e => update('legal_address', e.target.value)} />
              </Field>
              <div className="rounded-lg bg-muted/30 p-4 space-y-2">
                <p className="text-sm font-medium">Conformité réglementaire CI</p>
                {[
                  'Données hébergées conformément à la loi CI 2013-450 sur la protection des données personnelles',
                  'Respect du Code du Travail CI (loi n°2015-532 du 20 juillet 2015)',
                  'Déclarations CNPS conformes à la réglementation 2024',
                  'Génération DISA conforme loi 99-477 du 2 août 1999',
                  'Contrats OHADA — Acte Uniforme révisé sur le droit commercial',
                ].map(t => (
                  <div key={t} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CheckCircle className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    <span>{t}</span>
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
  const queryClient = useQueryClient()
  const [section, setSection] = useState<'models' | 'platforms' | 'prompts' | 'advanced'>('models')

  const sections: Array<{ key: typeof section; label: string }> = [
    { key: 'models',    label: 'Modèles IA' },
    { key: 'platforms', label: 'Plateformes' },
    { key: 'prompts',   label: 'Prompts système' },
    { key: 'advanced',  label: 'Paramètres avancés' },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Sourcing IA — Configuration paramétrable
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Tout est paramétrable : modèles IA, plateformes par pays, prompts système, slider profils,
          budget max, pondérations de richesse. Les changements sont propagés immédiatement (cache invalidé).
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {sections.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${section === s.key ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {s.label}
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
          {models.length} modèle(s) configuré(s). Tarifs en EUR par million de tokens.
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Ajouter un modèle
        </button>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Fournisseur</th>
              <th className="p-3">Modèle</th>
              <th className="p-3 text-right">Coût input/1M</th>
              <th className="p-3 text-right">Coût output/1M</th>
              <th className="p-3 text-right">Max tokens</th>
              <th className="p-3 text-center">Actif</th>
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
                  <button onClick={() => setEditing(m)} className="text-muted-foreground hover:text-primary" title="Modifier">
                    <Edit3 className="inline h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { if (confirm('Supprimer ce modèle ?')) remove.mutate(m.id) }}
                    className="text-red-400 hover:text-red-600" title="Supprimer">
                    <Trash2 className="inline h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground text-sm">Aucun modèle. Le système utilise les valeurs par défaut (Claude Sonnet 4 + Mistral Large).</td></tr>
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
  const [form, setForm] = useState<Partial<AiModel>>(model ?? {
    provider: 'claude', model_id: '', display_name: '',
    max_tokens: 4000, input_cost_per_1m_eur: 0, output_cost_per_1m_eur: 0,
    is_active: true, sort_order: 0,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-3 font-semibold">
          {model ? 'Modifier le modèle' : 'Nouveau modèle IA'}
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Fournisseur</label>
              <select value={form.provider} onChange={e => setForm(p => ({ ...p, provider: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="claude">Anthropic (Claude)</option>
                <option value="mistral">Mistral AI</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Identifiant modèle</label>
              <input value={form.model_id ?? ''} onChange={e => setForm(p => ({ ...p, model_id: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
                placeholder="claude-sonnet-4-20250514" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Nom affiché</label>
            <input value={form.display_name ?? ''} onChange={e => setForm(p => ({ ...p, display_name: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Max tokens</label>
              <input type="number" value={form.max_tokens ?? 0}
                onChange={e => setForm(p => ({ ...p, max_tokens: parseInt(e.target.value) || 0 }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Coût input / 1M (EUR)</label>
              <input type="number" step="0.01" value={form.input_cost_per_1m_eur ?? 0}
                onChange={e => setForm(p => ({ ...p, input_cost_per_1m_eur: parseFloat(e.target.value) || 0 }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Coût output / 1M (EUR)</label>
              <input type="number" step="0.01" value={form.output_cost_per_1m_eur ?? 0}
                onChange={e => setForm(p => ({ ...p, output_cost_per_1m_eur: parseFloat(e.target.value) || 0 }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.is_active ?? true}
                onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))} />
              Actif
            </label>
            <div>
              <label className="text-xs text-muted-foreground mr-2">Ordre</label>
              <input type="number" value={form.sort_order ?? 0}
                onChange={e => setForm(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))}
                className="w-20 rounded border border-input bg-background px-2 py-1 text-sm" />
            </div>
          </div>
        </div>
        <div className="border-t border-border px-5 py-3 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
          <button onClick={() => onSave({ ...form, id: model?.id })}
            disabled={!form.provider || !form.model_id || !form.display_name || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PlatformsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
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
          {platforms.length} plateforme(s). {panafrican.length} panafricaines + {platforms.length - panafrican.length} locales.
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Nouvelle plateforme
        </button>
      </div>

      {panafrican.length > 0 && (
        <PlatformGroup title="Panafricaines / Globales" platforms={panafrican}
          onEdit={setEditing} onRemove={id => remove.mutate(id)} />
      )}
      {Array.from(byCountry.entries()).sort().map(([cc, list]) => (
        <PlatformGroup key={cc} title={`Pays : ${cc}`} platforms={list}
          onEdit={setEditing} onRemove={id => remove.mutate(id)} />
      ))}
      {platforms.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Aucune plateforme configurée. Le système utilise les valeurs par défaut.
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
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground uppercase">
        {title} ({platforms.length})
      </div>
      <div className="divide-y divide-border">
        {platforms.map(p => (
          <div key={p.id} className="flex items-center justify-between px-3 py-2 hover:bg-muted/20">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {p.name}
                {!p.is_active && <span className="text-[10px] text-muted-foreground">(inactif)</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                <code>{p.code}</code>
                {p.url && <> · {p.url}</>}
                {p.est_pool && <> · ~{p.est_pool} profils</>}
              </div>
            </div>
            <div className="flex gap-1">
              <button onClick={() => onEdit(p)} className="text-muted-foreground hover:text-primary p-1">
                <Edit3 className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => { if (confirm('Supprimer cette plateforme ?')) onRemove(p.id) }}
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
  const [form, setForm] = useState<Partial<SourcingPlatform>>(platform ?? {
    code: '', name: '', country_code: null, url: null, est_pool: null,
    is_active: true, is_panafrican: false, sort_order: 0,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-3 font-semibold">
          {platform ? 'Modifier la plateforme' : 'Nouvelle plateforme de sourcing'}
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Code (slug)</label>
              <input value={form.code ?? ''} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
                placeholder="emploi_ci" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Nom</label>
              <input value={form.name ?? ''} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="Emploi.ci" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Code pays (CI, SN, NG…)</label>
              <input value={form.country_code ?? ''}
                onChange={e => setForm(p => ({ ...p, country_code: e.target.value || null }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
                placeholder="CI" maxLength={5} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">URL</label>
              <input value={form.url ?? ''}
                onChange={e => setForm(p => ({ ...p, url: e.target.value || null }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 items-center">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Pool estimé</label>
              <input type="number" value={form.est_pool ?? ''}
                onChange={e => setForm(p => ({ ...p, est_pool: e.target.value ? parseInt(e.target.value) : null }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
            </div>
            <label className="flex items-center gap-2 text-sm pt-5">
              <input type="checkbox" checked={form.is_active ?? true}
                onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))} />
              Active
            </label>
            <label className="flex items-center gap-2 text-sm pt-5">
              <input type="checkbox" checked={form.is_panafrican ?? false}
                onChange={e => setForm(p => ({ ...p, is_panafrican: e.target.checked }))} />
              Panafricaine
            </label>
          </div>
        </div>
        <div className="border-t border-border px-5 py-3 flex gap-2 justify-end">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
          <button onClick={() => onSave({ ...form, id: platform?.id })}
            disabled={!form.code || !form.name || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PromptsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
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
        <strong>Astuce :</strong> laisser vide pour utiliser le prompt par défaut codé en dur dans le service.
        Le prompt fourni ici remplace intégralement le prompt par défaut pour le modèle concerné.
      </div>

      <div>
        <label className="text-xs font-semibold uppercase text-muted-foreground">
          Prompt système Claude (Anthropic)
        </label>
        <textarea
          value={claude}
          onChange={e => { setClaude(e.target.value); setDirty(true) }}
          rows={10}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono"
          placeholder="Tu es un expert RH..."
        />
      </div>

      <div>
        <label className="text-xs font-semibold uppercase text-muted-foreground">
          Prompt système Mistral
        </label>
        <textarea
          value={mistral}
          onChange={e => { setMistral(e.target.value); setDirty(true) }}
          rows={10}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono"
          placeholder="Tu es un expert RH..."
        />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={() => save.mutate({ claude_system_prompt: claude, mistral_system_prompt: mistral })}
          disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer les prompts
        </button>
      </div>
    </div>
  )
}

function AdvancedSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
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
    catch { alert('JSON pondérations invalide'); return }
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
        <h3 className="font-semibold text-sm mb-3">Slider profils (limite par requête)</h3>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Min</label>
            <input type="number" value={form.min}
              onChange={e => { setForm(p => ({ ...p, min: parseInt(e.target.value) || 1 })); setDirty(true) }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Max</label>
            <input type="number" value={form.max}
              onChange={e => { setForm(p => ({ ...p, max: parseInt(e.target.value) || 20 })); setDirty(true) }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Défaut</label>
            <input type="number" value={form.def}
              onChange={e => { setForm(p => ({ ...p, def: parseInt(e.target.value) || 8 })); setDirty(true) }}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="font-semibold text-sm mb-3">Budget max par requête</h3>
        <div className="flex items-center gap-3">
          <input type="number" step="0.01" value={form.budget}
            onChange={e => { setForm(p => ({ ...p, budget: parseFloat(e.target.value) || 0 })); setDirty(true) }}
            className="w-32 rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono" />
          <span className="text-sm text-muted-foreground">EUR · 0 = pas de limite</span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Log warning si une requête dépasse ce budget (audit_log à venir). N'interrompt pas la requête.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="font-semibold text-sm mb-3">Pondérations score de richesse (JSON)</h3>
        <textarea value={form.weights}
          onChange={e => { setForm(p => ({ ...p, weights: e.target.value })); setDirty(true) }}
          rows={14}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono" />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onSave} disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer les paramètres
        </button>
      </div>
    </div>
  )
}
