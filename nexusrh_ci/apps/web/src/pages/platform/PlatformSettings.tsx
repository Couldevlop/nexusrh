import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import {
  Settings, Save, Loader2, Bot, Mail, Shield,
  Bell, Building2, AlertCircle, CheckCircle, Scale, Globe,
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
  aiConfigured: boolean
  smtpConfigured: boolean
  version: string
  environment: string
}

type TabKey = 'general' | 'security' | 'notifications' | 'ai' | 'legal' | 'store-lois' | 'multi-leg'

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

  const FLAG: Record<string, string> = { CI: '🇨🇮', SN: '🇸🇳', BF: '🇧🇫', ML: '🇲🇱', TG: '🇹🇬' }
  const STATUS_COLOR: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    beta: 'bg-blue-100 text-blue-700',
    planned: 'bg-gray-100 text-gray-600',
  }

  if (isLoading) return <div className="flex justify-center p-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold">Multi-législatif — Expansion UEMOA</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Moteurs de paie par pays. Chaque pays a ses propres taux CNPS/SECU, barèmes fiscaux et constantes légales.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {configs.map(c => (
          <div key={c.country_code} className={`rounded-xl border p-4 ${c.is_active ? 'border-border bg-card' : 'border-border/50 bg-muted/20 opacity-70'}`}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{FLAG[c.country_code] ?? '🌍'}</span>
                <div>
                  <p className="font-semibold text-sm">{c.country_name}</p>
                  <p className="text-xs text-muted-foreground">{c.country_code} · {c.currency} · {c.timezone}</p>
                </div>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.is_active ? STATUS_COLOR['active'] : STATUS_COLOR['planned']}`}>
                {c.is_active ? 'Actif' : 'Planifié'}
              </span>
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
        ))}
      </div>

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm">
        <p className="font-semibold text-blue-800 mb-2">Feuille de route UEMOA</p>
        <div className="space-y-1 text-blue-700 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-green-600 font-bold">✓</span>
            <span><strong>Côte d'Ivoire</strong> — Moteur complet CNPS + ITS/DGI · Production</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-blue-600 font-bold">~</span>
            <span><strong>Sénégal</strong> — IPRES + IR · En développement (Q3 2025)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400">○</span>
            <span><strong>Burkina Faso, Mali, Togo</strong> — Planifié 2026</span>
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
              <div className="rounded-lg bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">Politiques de sécurité (configurées via .env)</p>
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
