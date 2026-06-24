import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api } from '@/lib/api'
import { useAuthStore, type TenantConfig } from '@/stores/authStore'
import {
  Settings, Users, Building2, Save, Plus, ShieldCheck, Trash2,
  FileText, Layers, GitBranch, Banknote, Edit2, X, Check,
  Download, Upload, AlertCircle, CheckCircle2, Database, Mail, KeyRound,
  Users2, CalendarDays, Smartphone, Receipt, RefreshCw, Copy, Lock, Bot, Plug, Globe,
} from 'lucide-react'
import MfaSettingsPage from './MfaSettingsPage'
import ConnectivityTab from './ConnectivityTab'
import MobileMoneyTab from './MobileMoneyTab'
import PayslipBuilder from './PayslipBuilder'

// ── Types ──────────────────────────────────────────────────────────────────────
interface TenantSettings {
  id: string; name: string; slug: string; plan_type: string; status: string
  sector: string | null; city: string | null; cnps_number: string | null
  dgi_number: string | null; rccm: string | null; at_rate: string | null
  primary_color: string; secondary_color: string; logo_url: string | null
  max_users: number; max_employees: number
  mfa_required?: boolean
  sender_email?: string | null; sender_name?: string | null
}
interface TenantUser {
  id: string; email: string; first_name: string; last_name: string
  role: string; is_active: boolean; last_login_at: string | null; job_title: string | null
}
interface Department {
  id: string; name: string; code: string | null; employees_count: number; manager_name: string | null
}
interface AbsenceType {
  id: string; code: string; label: string; color: string
  requires_approval: boolean; max_days_per_year: number | null
  is_paid: boolean; calculation_mode: string; is_active: boolean
}
interface PayrollRule {
  id: string; code: string; name: string; type: string
  formula: string | null; rate: string | null; ceiling_type: string | null
  is_active: boolean; order: number; description: string | null
}
interface LegalEntity {
  id: string; name: string; rccm: string | null; cnps_number: string | null
  dgi_number: string | null; address: string | null; city: string; legal_form: string
  collective_agreement: string | null; at_rate: string; employees_count: number
  country_code: string | null; legislation_pack_code: string | null
  is_active: boolean
}
interface WorkflowConfig { id: string; module: string; levels_count: number }

// ── Constants ─────────────────────────────────────────────────────────────────
// Rôles disponibles (clé technique = valeur API ; libellé traduit via roles.<key>).
const ROLE_KEYS = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly'] as const
// Couleur par type de rubrique (clé technique = valeur API ; libellé traduit via ruleTypes.<key>).
const RULE_TYPE_COLORS: Record<string, string> = {
  earning:                'bg-green-100 text-green-700',
  deduction:              'bg-red-100 text-red-700',
  employee_contribution:  'bg-orange-100 text-orange-700',
  employer_contribution:  'bg-blue-100 text-blue-700',
}
// Valeurs canoniques alignées sur l'API + le moteur de paie (le seed stocke
// déjà employee_contribution/employer_contribution).
const RULE_TYPE_KEYS = ['earning', 'deduction', 'employee_contribution', 'employer_contribution'] as const
const TABS = [
  { id: 'general',        labelKey: 'tabs.general',       icon: Settings },
  { id: 'legislation',    labelKey: 'tabs.legislation',   icon: Globe },
  { id: 'users',          labelKey: 'tabs.users',         icon: Users },
  { id: 'departments',    labelKey: 'tabs.departments',   icon: Building2 },
  { id: 'absence-types',  labelKey: 'tabs.absenceTypes',  icon: FileText },
  { id: 'payroll-rules',  labelKey: 'tabs.payrollRules',  icon: Banknote },
  { id: 'payslip-template', labelKey: 'tabs.payslipTemplate', icon: FileText },
  { id: 'legal-entities', labelKey: 'tabs.legalEntities', icon: Layers },
  { id: 'workflow',       labelKey: 'tabs.workflow',      icon: GitBranch },
  { id: 'data-import',   labelKey: 'tabs.dataImport',    icon: Database },
  { id: 'mfa',           labelKey: 'tabs.mfa',           icon: Lock },
  { id: 'ai',            labelKey: 'tabs.ai',            icon: Bot },
  { id: 'connectivity',  labelKey: 'tabs.connectivity',  icon: Plug },
  { id: 'mobile-money',  labelKey: 'tabs.mobileMoney',    icon: Smartphone },
] as const
type TabId = typeof TABS[number]['id']

// ── Main component ────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const { tenantConfig } = useAuthStore()
  // Onglet initial sélectionnable par URL (?tab=mfa) — utilisé notamment par la
  // redirection « MFA obligatoire » du login (OWASP A07).
  const initialTab = ((): TabId => {
    const t = new URLSearchParams(window.location.search).get('tab')
    return (TABS as readonly { id: string }[]).some(x => x.id === t) ? (t as TabId) : 'general'
  })()
  const [tab, setTab] = useState<TabId>(initialTab)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{tenantConfig?.name}</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/30 p-1">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}>
            <Icon className="h-3.5 w-3.5" />{t(labelKey)}
          </button>
        ))}
      </div>

      {tab === 'general'        && <GeneralTab qc={qc} />}
      {tab === 'legislation'    && <LegislationTab qc={qc} />}
      {tab === 'users'          && <UsersTab qc={qc} />}
      {tab === 'departments'    && <DepartmentsTab qc={qc} />}
      {tab === 'absence-types'  && <AbsenceTypesTab qc={qc} />}
      {tab === 'payroll-rules'  && <PayrollRulesTab qc={qc} />}
      {tab === 'payslip-template' && <PayslipBuilder />}
      {tab === 'legal-entities' && <LegalEntitiesTab qc={qc} />}
      {tab === 'workflow'       && <WorkflowTab qc={qc} />}
      {tab === 'data-import'   && <DataImportTab />}
      {tab === 'mfa'           && <MfaSettingsPage />}
      {tab === 'ai'            && <AiTab qc={qc} />}
      {tab === 'connectivity'  && <ConnectivityTab />}
      {tab === 'mobile-money'  && <MobileMoneyTab qc={qc} />}
    </div>
  )
}

// ── Tab: Légal / Pays (pack législatif appliqué au tenant) ─────────────────────
interface ItsBracket { min: number; max: number; taux: number }
interface LeaveRules {
  maternityWeeks: number; paternityDays: number
  annualLeaveDaysPerMonth: number; workingDaysPerWeek: number
}
interface LegislationPackView {
  code: string; name: string; countryCode: string; year: number; currency: string
  status: 'active' | 'stub'; smigMensuel: number
  plafondCnpsRetraite: number; plafondCnpsAtPf: number
  tauxCotisationRetraiteSalarie: number; tauxCotisationRetraitePatronal: number
  tauxCotisationPfPatronal: number; tauxCotisationMaternitePatronal: number
  tauxAtDefaultPatronal: number; abattementImpotSalaire: number
  tranchesImpotSalaire: ItsBracket[]
  creditImpotMarieSansEnfant: number; creditImpotParEnfant: number[]
  labelImpotSalaire: string; labelCaisseSociale: string
  leaveRules?: LeaveRules
}
interface LegislationConfig {
  countryCode: string; countryLabel: string; supported: boolean; usable: boolean
  pack: LegislationPackView
  available: Array<{ countryCode: string; packCode: string; name: string; status: 'active' | 'stub'; currency: string; smigMensuel: number }>
}

function LegislationTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useQuery<{ data: LegislationConfig }>({
    queryKey: ['settings-legislation'],
    queryFn: () => api.get('/settings/legislation').then(r => r.data),
  })
  const cfg = data?.data
  const [country, setCountry] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: (countryCode: string) => api.put('/settings/legislation', { countryCode }),
    onSuccess: () => {
      setSaved(true); setCountry(null)
      qc.invalidateQueries({ queryKey: ['settings-legislation'] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading || !cfg) return <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>

  const selected = country ?? cfg.countryCode
  const pack = cfg.pack
  const pct = (n: number) => `${(n * 100).toFixed(2).replace(/\.00$/, '')} %`
  const fcfa = (n: number) => n.toLocaleString('fr-FR')
  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
  const card = 'rounded-xl border border-border bg-card p-4 space-y-2'
  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium font-mono">{value}</span>
    </div>
  )

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">{t('legislation.intro')}</p>

      {/* Sélecteur de pays */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <label className="text-xs font-medium text-muted-foreground">{t('legislation.countryLabel')}</label>
        <select className={inputCls} value={selected} onChange={e => setCountry(e.target.value)}>
          {cfg.available.map(c => (
            <option key={c.countryCode} value={c.countryCode}>
              {c.name} — {c.packCode}{c.status === 'stub' ? ` (${t('legislation.toValidate')})` : ''}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-xs text-green-600">{t('legislation.saved')}</span>}
          <button onClick={() => save.mutate(selected)}
            disabled={selected === cfg.countryCode || save.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-4 w-4" />{save.isPending ? t('legislation.applying') : t('legislation.apply')}
          </button>
        </div>
        {save.isError && <p className="text-xs text-red-600 text-right">{(save.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('legislation.saveError')}</p>}
      </div>

      {/* Avertissement pack non validé */}
      {!pack.status || pack.status === 'stub' ? (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">{t('legislation.stubWarning')}</p>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg bg-green-50 border border-green-200 p-3">
          <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
          <p className="text-xs text-green-800">{t('legislation.activeInfo', { name: cfg.countryLabel })}</p>
        </div>
      )}

      {/* Aperçu du paramétrage appliqué */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className={card}>
          <h3 className="font-semibold text-sm">{t('legislation.sections.base')}</h3>
          {row(t('legislation.fields.country'), `${cfg.countryLabel} (${pack.year})`)}
          {row(t('legislation.fields.currency'), pack.currency)}
          {row(t('legislation.fields.smig'), `${fcfa(pack.smigMensuel)} ${pack.currency}`)}
          {row(t('legislation.fields.caisse'), pack.labelCaisseSociale)}
          {row(t('legislation.fields.tax'), pack.labelImpotSalaire)}
          {row(t('legislation.fields.abattement'), pct(pack.abattementImpotSalaire))}
        </div>

        <div className={card}>
          <h3 className="font-semibold text-sm">{t('legislation.sections.social')}</h3>
          {row(t('legislation.fields.retraiteSal'), pct(pack.tauxCotisationRetraiteSalarie))}
          {row(t('legislation.fields.retraitePat'), pct(pack.tauxCotisationRetraitePatronal))}
          {row(t('legislation.fields.pfPat'), pct(pack.tauxCotisationPfPatronal))}
          {row(t('legislation.fields.maternitePat'), pct(pack.tauxCotisationMaternitePatronal))}
          {row(t('legislation.fields.atDefault'), pct(pack.tauxAtDefaultPatronal))}
          {pack.plafondCnpsRetraite > 0 && row(t('legislation.fields.plafondRetraite'), `${fcfa(pack.plafondCnpsRetraite)} ${pack.currency}`)}
          {pack.plafondCnpsAtPf > 0 && row(t('legislation.fields.plafondAtPf'), `${fcfa(pack.plafondCnpsAtPf)} ${pack.currency}`)}
        </div>
      </div>

      {/* Barème d'imposition */}
      <div className={card}>
        <h3 className="font-semibold text-sm">{t('legislation.sections.tax')} — {pack.labelImpotSalaire}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1.5">{t('legislation.bracketFrom')}</th>
              <th className="py-1.5">{t('legislation.bracketTo')}</th>
              <th className="py-1.5 text-right">{t('legislation.bracketRate')}</th>
            </tr>
          </thead>
          <tbody>
            {pack.tranchesImpotSalaire.map((b, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 font-mono">{fcfa(b.min)}</td>
                <td className="py-1.5 font-mono">{Number.isFinite(b.max) ? fcfa(b.max) : '∞'}</td>
                <td className="py-1.5 text-right font-mono">{pct(b.taux)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Congés & conventions */}
      {pack.leaveRules && (
        <div className={card}>
          <h3 className="font-semibold text-sm">{t('legislation.sections.leave')}</h3>
          {row(t('legislation.fields.maternity'), t('legislation.weeks', { n: pack.leaveRules.maternityWeeks }))}
          {row(t('legislation.fields.paternity'), t('legislation.days', { n: pack.leaveRules.paternityDays }))}
          {row(t('legislation.fields.annualLeave'), t('legislation.daysPerMonth', { n: pack.leaveRules.annualLeaveDaysPerMonth }))}
          {row(t('legislation.fields.workingDays'), t('legislation.daysPerWeek', { n: pack.leaveRules.workingDaysPerWeek }))}
        </div>
      )}
    </div>
  )
}

// ── Tab: IA (clé API + modèle par fournisseur) ─────────────────────────────────
interface AiConfig {
  claude:  { hasKey: boolean; keyMask: string | null; model: string | null }
  mistral: { hasKey: boolean; keyMask: string | null; model: string | null }
  preferredProvider: 'claude' | 'mistral'
  encryptionAvailable: boolean
  platformClaude: boolean
  platformMistral: boolean
  models: Array<{ provider: string; modelId: string; displayName: string }>
}

function AiTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useQuery<{ data: AiConfig }>({
    queryKey: ['settings-ai'],
    queryFn: () => api.get('/settings/ai').then(r => r.data),
  })
  const cfg = data?.data
  // Saisie : clé vide = inchangée ; on n'envoie une clé que si l'admin en tape une.
  const [form, setForm] = useState<{
    claudeApiKey?: string; mistralApiKey?: string
    claudeModel?: string; mistralModel?: string
    preferredProvider?: 'claude' | 'mistral'
  }>({})
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.put('/settings/ai', payload),
    onSuccess: () => {
      setSaved(true); setForm({})
      qc.invalidateQueries({ queryKey: ['settings-ai'] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading || !cfg) return <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
  const modelsOf = (provider: string) => cfg.models.filter(m => m.provider === provider)

  const ProviderBlock = ({
    provider, label, current, platformFallback,
  }: { provider: 'claude' | 'mistral'; label: string; current: { hasKey: boolean; keyMask: string | null; model: string | null }; platformFallback: boolean }) => {
    const keyField  = provider === 'claude' ? 'claudeApiKey'  : 'mistralApiKey'
    const modelField = provider === 'claude' ? 'claudeModel'  : 'mistralModel'
    const models = modelsOf(provider)
    return (
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{label}</h3>
          <span className={`text-xs rounded-full px-2 py-0.5 ${current.hasKey ? 'bg-green-100 text-green-700' : platformFallback ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
            {current.hasKey ? t('ai.badge.tenantKey', { mask: current.keyMask }) : platformFallback ? t('ai.badge.platformFallback') : t('ai.badge.noKey')}
          </span>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('ai.apiKeyLabel', { provider: label })}</label>
          <input type="password" autoComplete="new-password" className={inputCls}
            placeholder={current.hasKey ? t('ai.apiKeyConfiguredPlaceholder', { mask: current.keyMask }) : t('ai.apiKeyEmptyPlaceholder')}
            value={(form as Record<string, string>)[keyField] ?? ''}
            onChange={e => setForm(p => ({ ...p, [keyField]: e.target.value }))}
            disabled={!cfg.encryptionAvailable} />
          {current.hasKey && (
            <button type="button"
              onClick={() => setForm(p => ({ ...p, [keyField]: '' }))}
              className="mt-1 text-xs text-red-600 hover:underline">
              {t('ai.clearKey')}
            </button>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('ai.modelLabel', { provider: label })}</label>
          <select className={inputCls}
            value={(form as Record<string, string>)[modelField] ?? current.model ?? ''}
            onChange={e => setForm(p => ({ ...p, [modelField]: e.target.value }))}>
            <option value="">{t('ai.modelDefaultOption')}</option>
            {models.map(m => <option key={m.modelId} value={m.modelId}>{m.displayName}</option>)}
          </select>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4">
      {!cfg.encryptionAvailable && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">{t('ai.encryptionUnavailable')}</p>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{t('ai.intro')}</p>

      <ProviderBlock provider="claude"  label={t('ai.providerClaude')} current={cfg.claude}  platformFallback={cfg.platformClaude} />
      <ProviderBlock provider="mistral" label={t('ai.providerMistral')} current={cfg.mistral} platformFallback={cfg.platformMistral} />

      <div className="rounded-xl border border-border p-4">
        <label className="text-xs font-medium text-muted-foreground">{t('ai.preferredProviderLabel')}</label>
        <select className={inputCls}
          value={form.preferredProvider ?? cfg.preferredProvider}
          onChange={e => setForm(p => ({ ...p, preferredProvider: e.target.value as 'claude' | 'mistral' }))}>
          <option value="claude">{t('ai.providerClaude')}</option>
          <option value="mistral">{t('ai.providerMistral')}</option>
        </select>
      </div>

      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-xs text-green-600">{t('ai.saved')}</span>}
        <button onClick={() => save.mutate(form)}
          disabled={Object.keys(form).length === 0 || save.isPending}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          <Save className="h-4 w-4" />{save.isPending ? t('ai.saving') : t('ai.save')}
        </button>
      </div>
      {save.isError && <p className="text-xs text-red-600 text-right">{(save.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('ai.saveError')}</p>}
    </div>
  )
}

// ── Tab: Général ──────────────────────────────────────────────────────────────
function GeneralTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [form, setForm] = useState<Partial<TenantSettings>>({})
  const { data } = useQuery<{ data: TenantSettings }>({
    queryKey: ['settings-tenant'],
    queryFn: () => api.get('/settings/tenant').then(r => r.data),
  })
  const updateTenantConfig = useAuthStore(st => st.updateTenantConfig)
  const update = useMutation({
    mutationFn: (d: Partial<TenantSettings>) => api.patch('/settings/tenant', d),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['settings-tenant'] })
      // Reflète immédiatement l'apparence/le nom dans l'UI (thème + sidebar)
      // sans nécessiter une reconnexion (le bug : la couleur ne changeait pas).
      const patch: Partial<TenantConfig> = {}
      if (vars.primary_color !== undefined)   patch.primaryColor = vars.primary_color
      if (vars.secondary_color !== undefined) patch.secondaryColor = vars.secondary_color
      if (vars.logo_url !== undefined)        patch.logoUrl = vars.logo_url
      if (vars.name !== undefined)            patch.name = vars.name
      if (vars.city != null)                  patch.city = vars.city
      if (Object.keys(patch).length) updateTenantConfig(patch)
      setForm({})
    },
  })
  const s = data?.data
  if (!s) return <div className="p-8 text-center text-muted-foreground">{t('loading')}</div>

  const field = (key: keyof TenantSettings, label: string, type = 'text') => (
    <div key={key}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input type={type}
        defaultValue={(s as unknown as Record<string, string>)[key] ?? ''}
        onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
    </div>
  )

  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h2 className="font-semibold">{t('general.companyInfo')}</h2>
        <div className="grid grid-cols-2 gap-4">
          {field('name', t('general.fields.name'))}
          {field('city', t('general.fields.city'))}
          {field('cnps_number', t('general.fields.cnpsNumber'))}
          {field('dgi_number', t('general.fields.dgiNumber'))}
          {field('rccm', t('general.fields.rccm'))}
          {field('at_rate', t('general.fields.atRate'))}
        </div>

        <h2 className="font-semibold pt-2">{t('general.sector')}</h2>
        <select defaultValue={s.sector || ''}
          onChange={e => setForm(p => ({ ...p, sector: e.target.value }))}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
          <option value="">{t('general.selectOption')}</option>
          {['transport','commerce','industrie','services','btp','finance','sante','ong','public'].map(v => (
            <option key={v} value={v}>{t(`general.sectors.${v}`)}</option>
          ))}
        </select>

        <h2 className="font-semibold pt-2">{t('general.appearance')}</h2>
        <div className="grid grid-cols-2 gap-4">
          {(['primary_color', 'secondary_color'] as const).map(k => (
            <div key={k}>
              <label className="text-xs font-medium text-muted-foreground">
                {k === 'primary_color' ? t('general.primaryColor') : t('general.secondaryColor')}
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input type="color" defaultValue={(s as unknown as Record<string,string>)[k]}
                  onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
                  className="h-9 w-16 cursor-pointer rounded-lg border border-input" />
                <span className="text-sm text-muted-foreground font-mono">
                  {(form as Record<string,string>)[k] ?? (s as unknown as Record<string,string>)[k]}
                </span>
              </div>
            </div>
          ))}
        </div>

        <h2 className="font-semibold pt-2">{t('general.emailSender')}</h2>
        <p className="text-xs text-muted-foreground -mt-2">{t('general.emailSenderHint')}</p>
        <div className="grid grid-cols-2 gap-4">
          {field('sender_name', t('general.fields.senderName'))}
          {field('sender_email', t('general.fields.senderEmail'), 'email')}
        </div>

        <h2 className="font-semibold pt-2">{t('general.security')}</h2>
        <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer">
          <input type="checkbox"
            defaultChecked={!!s.mfa_required}
            onChange={e => setForm(p => ({ ...p, mfa_required: e.target.checked }))}
            className="mt-0.5 h-4 w-4" />
          <span className="text-sm">
            <span className="font-medium">{t('general.mfaRequiredLabel')}</span>
            <span className="block text-xs text-muted-foreground">{t('general.mfaRequiredHint')}</span>
          </span>
        </label>

        <div className="pt-2 flex items-center justify-between border-t border-border">
          <p className="text-xs text-muted-foreground">
            <Trans i18nKey="general.planSummary" ns="settings"
              values={{ plan: s.plan_type, maxUsers: s.max_users, maxEmployees: s.max_employees }}
              components={[<span className="font-semibold" />]} />
          </p>
          <button onClick={() => update.mutate(form)}
            disabled={Object.keys(form).length === 0 || update.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {update.isPending ? t('general.saving') : t('general.save')}
          </button>
        </div>
        {update.isSuccess && <p className="text-xs text-green-600">{t('general.updated')}</p>}
      </div>

      <EmailSmtpCard />
    </div>
  )
}

// ── Carte: Serveur SMTP propre au tenant (option C) ─────────────────────────────
interface EmailConfig {
  smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean
  smtpUser: string | null; hasPassword: boolean; smtpConfigured: boolean
  encryptionAvailable: boolean
}

function EmailSmtpCard() {
  const { t } = useTranslation('settings')
  const { data, refetch } = useQuery<{ data: EmailConfig }>({
    queryKey: ['settings-email'],
    queryFn: () => api.get('/settings/email').then(r => r.data),
  })
  const cfg = data?.data
  const [form, setForm] = useState<Partial<{ smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpUser: string; smtpPassword: string }>>({})
  const save = useMutation({
    mutationFn: (d: typeof form) => api.put('/settings/email', d),
    onSuccess: () => { setForm({}); refetch() },
  })

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="font-semibold">{t('smtp.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('smtp.hint')}</p>
      </div>
      {cfg && !cfg.encryptionAvailable && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{t('smtp.noEncryption')}</p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('smtp.host')}</label>
          <input type="text" defaultValue={cfg?.smtpHost ?? ''} placeholder="smtp.masociete.ci"
            onChange={e => setForm(p => ({ ...p, smtpHost: e.target.value }))}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('smtp.port')}</label>
          <input type="number" defaultValue={cfg?.smtpPort ?? 587}
            onChange={e => setForm(p => ({ ...p, smtpPort: Number(e.target.value) }))}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('smtp.user')}</label>
          <input type="text" defaultValue={cfg?.smtpUser ?? ''} placeholder="rh@masociete.ci"
            onChange={e => setForm(p => ({ ...p, smtpUser: e.target.value }))}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('smtp.password')}</label>
          <input type="password" placeholder={cfg?.hasPassword ? '•••••••• (inchangé)' : ''}
            onChange={e => setForm(p => ({ ...p, smtpPassword: e.target.value }))}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" defaultChecked={!!cfg?.smtpSecure}
          onChange={e => setForm(p => ({ ...p, smtpSecure: e.target.checked }))} className="h-4 w-4" />
        {t('smtp.secure')}
      </label>
      <div className="flex items-center justify-between border-t border-border pt-2">
        <p className="text-xs text-muted-foreground">
          {cfg?.smtpConfigured ? t('smtp.configured') : t('smtp.notConfigured')}
        </p>
        <button onClick={() => save.mutate(form)}
          disabled={Object.keys(form).length === 0 || save.isPending}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          <Save className="h-4 w-4" />
          {save.isPending ? t('general.saving') : t('general.save')}
        </button>
      </div>
      {save.isSuccess && <p className="text-xs text-green-600">{t('general.updated')}</p>}
      {save.isError && <p className="text-xs text-destructive">{t('smtp.saveError')}</p>}
    </div>
  )
}

// ── Tab: Utilisateurs ─────────────────────────────────────────────────────────
const EMPTY_USER_FORM = { email: '', first_name: '', last_name: '', role: 'employee', department_id: '', is_active: true }

function UsersTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [showNew, setShowNew] = useState(false)
  const [tempPwd, setTempPwd] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_USER_FORM)

  const { data } = useQuery<{ data: TenantUser[] }>({
    queryKey: ['settings-users'],
    queryFn: () => api.get('/settings/users').then(r => r.data),
  })
  const { data: deptsData } = useQuery<{ data: { id: string; name: string }[] }>({
    queryKey: ['settings-departments'],
    queryFn: () => api.get('/settings/departments').then(r => r.data),
  })
  const users = data?.data ?? []
  const depts = deptsData?.data ?? []

  const [resetResult, setResetResult] = useState<{ name: string; pwd: string; emailSent: boolean } | null>(null)
  const [copied, setCopied] = useState(false)

  const create = useMutation({
    mutationFn: (d: typeof form) => api.post('/settings/users', { ...d, department_id: d.department_id || undefined }),
    onSuccess: (res) => { setTempPwd(res.data.tempPassword); qc.invalidateQueries({ queryKey: ['settings-users'] }) },
  })
  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => api.patch(`/settings/users/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-users'] }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-users'] }),
  })
  const resetPwd = useMutation({
    mutationFn: ({ id }: { id: string }) => api.post<{ tempPassword: string; emailSent: boolean }>(`/settings/users/${id}/reset-password`, {}),
    onSuccess: (res, vars) => {
      const u = users.find(x => x.id === vars.id)
      setResetResult({ name: u ? `${u.first_name} ${u.last_name}` : '?', pwd: res.data.tempPassword, emailSent: res.data.emailSent })
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('users.add')}
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-4">{t('users.table.user')}</th>
              <th className="p-4">{t('users.table.role')}</th>
              <th className="p-4">{t('users.table.jobTitle')}</th>
              <th className="p-4">{t('users.table.lastLogin')}</th>
              <th className="p-4">{t('users.table.status')}</th>
              <th className="p-4">{t('users.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-muted/30">
                <td className="p-4">
                  <p className="font-medium">{u.first_name} {u.last_name}</p>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                </td>
                <td className="p-4">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {ROLE_KEYS.includes(u.role as typeof ROLE_KEYS[number]) ? t(`roles.${u.role}`) : u.role}
                  </span>
                </td>
                <td className="p-4 text-muted-foreground">{u.job_title ?? '—'}</td>
                <td className="p-4 text-xs text-muted-foreground">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('fr-CI') : t('users.never')}
                </td>
                <td className="p-4">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {u.is_active ? t('users.active') : t('users.inactive')}
                  </span>
                </td>
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggle.mutate({ id: u.id, is_active: !u.is_active })}
                      className={`text-xs ${u.is_active ? 'text-orange-600 hover:underline' : 'text-green-600 hover:underline'}`}>
                      {u.is_active ? t('users.deactivate') : t('users.activate')}
                    </button>
                    <button
                      onClick={() => { if (confirm(t('users.confirmReset', { name: `${u.first_name} ${u.last_name}` }))) resetPwd.mutate({ id: u.id }) }}
                      disabled={resetPwd.isPending}
                      title={t('users.resetPasswordTitle')}
                      className="text-blue-500 hover:text-blue-700 disabled:opacity-40">
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => { if (confirm(t('users.confirmDelete'))) remove.mutate(u.id) }}
                      className="text-red-500 hover:text-red-700"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">
                <Users className="mx-auto mb-2 h-8 w-8 opacity-30" />{t('users.empty')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Popup résultat reset mot de passe */}
      {resetResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setResetResult(null); setCopied(false) }}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl text-center space-y-3" onClick={e => e.stopPropagation()}>
            <RefreshCw className="mx-auto h-9 w-9 text-blue-500" />
            <h3 className="font-semibold">{t('users.resetResult.title')}</h3>
            <p className="text-sm text-muted-foreground">
              <Trans i18nKey="users.resetResult.description" ns="settings"
                values={{ name: resetResult.name }} components={[<strong />]} />
            </p>
            <div className="flex items-center gap-2 rounded-lg bg-muted px-4 py-3">
              <span className="flex-1 font-mono text-base font-bold tracking-wider">{resetResult.pwd}</span>
              <button onClick={() => { void navigator.clipboard.writeText(resetResult.pwd); setCopied(true) }}
                className="text-muted-foreground hover:text-foreground">
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            {resetResult.emailSent
              ? <p className="text-xs text-green-600 flex items-center justify-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> {t('users.resetResult.emailSent')}</p>
              : <p className="text-xs text-amber-600">{t('users.resetResult.emailNotSent')}</p>
            }
            <button onClick={() => { setResetResult(null); setCopied(false) }}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{t('users.resetResult.close')}</button>
          </div>
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowNew(false); setTempPwd(null) }}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            {tempPwd ? (
              <div className="text-center space-y-3">
                <ShieldCheck className="mx-auto h-10 w-10 text-green-600" />
                <h3 className="font-semibold">{t('users.createResult.title')}</h3>
                <p className="text-sm text-muted-foreground">{t('users.createResult.tempPasswordLabel')}</p>
                <div className="rounded-lg bg-muted px-4 py-3 font-mono text-lg font-bold tracking-widest">{tempPwd}</div>
                <p className="text-xs text-muted-foreground">{t('users.createResult.hint')}</p>
                <button onClick={() => { setShowNew(false); setTempPwd(null); setForm(EMPTY_USER_FORM) }}
                  className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{t('users.createResult.close')}</button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">{t('users.form.title')}</h3>
                  <button onClick={() => setShowNew(false)}><X className="h-4 w-4" /></button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{t('users.form.email')}</label>
                    <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                      type="email" className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(['first_name', 'last_name'] as const).map(k => (
                      <div key={k}>
                        <label className="text-xs font-medium text-muted-foreground">{k === 'first_name' ? t('users.form.firstName') : t('users.form.lastName')}</label>
                        <input value={form[k]} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
                          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{t('users.form.role')}</label>
                    <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      {ROLE_KEYS.map(v => <option key={v} value={v}>{t(`roles.${v}`)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{t('users.form.department')}</label>
                    <select value={form.department_id} onChange={e => setForm(p => ({ ...p, department_id: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      <option value="">{t('users.form.noDepartment')}</option>
                      {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{t('users.form.status')}</label>
                    <select value={form.is_active ? 'true' : 'false'} onChange={e => setForm(p => ({ ...p, is_active: e.target.value === 'true' }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      <option value="true">{t('users.form.active')}</option>
                      <option value="false">{t('users.form.inactive')}</option>
                    </select>
                  </div>
                </div>
                <div className="mt-5 flex gap-2 justify-end">
                  <button onClick={() => setShowNew(false)}
                    className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('users.form.cancel')}</button>
                  <button onClick={() => create.mutate(form)}
                    disabled={!form.email || !form.first_name || !form.last_name || create.isPending}
                    className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {create.isPending ? t('users.form.creating') : t('users.form.create')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Départements ─────────────────────────────────────────────────────────
function DepartmentsTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<{ id: string; name: string; code: string } | null>(null)
  const [form, setForm] = useState({ name: '', code: '' })

  const { data } = useQuery<{ data: Department[] }>({
    queryKey: ['settings-departments'],
    queryFn: () => api.get('/settings/departments').then(r => r.data),
  })
  const depts = data?.data ?? []

  const create = useMutation({
    mutationFn: (d: typeof form) => api.post('/settings/departments', d),
    onSuccess: () => { setShowNew(false); setForm({ name: '', code: '' }); qc.invalidateQueries({ queryKey: ['settings-departments'] }) },
  })
  const update = useMutation({
    mutationFn: ({ id, ...d }: { id: string; name: string; code: string }) => api.patch(`/settings/departments/${id}`, d),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['settings-departments'] }) },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/departments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-departments'] }),
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? t('error')),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('departments.add')}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {depts.map(d => (
          <div key={d.id} className="rounded-xl border border-border bg-card p-4">
            {editing?.id === d.id ? (
              <div className="space-y-2">
                <input value={editing.name} onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : p)}
                  className="w-full rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none" />
                <input value={editing.code} onChange={e => setEditing(p => p ? { ...p, code: e.target.value } : p)}
                  placeholder={t('departments.codePlaceholder')} className="w-full rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none" />
                <div className="flex gap-2">
                  <button onClick={() => update.mutate(editing)}
                    className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground">
                    <Check className="h-3 w-3" /> {t('departments.ok')}
                  </button>
                  <button onClick={() => setEditing(null)} className="rounded border border-border px-2 py-1 text-xs">{t('departments.cancel')}</button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">{d.name}</p>
                  {d.code && <p className="text-xs text-muted-foreground">{d.code}</p>}
                  {d.manager_name && <p className="text-xs text-muted-foreground mt-1">{t('departments.manager', { name: d.manager_name })}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-sm font-medium text-primary">
                    <Users className="h-3.5 w-3.5" />{d.employees_count}
                  </span>
                  <button onClick={() => setEditing({ id: d.id, name: d.name, code: d.code ?? '' })}
                    className="text-muted-foreground hover:text-foreground"><Edit2 className="h-3.5 w-3.5" /></button>
                  <button onClick={() => { if (confirm(t('departments.confirmDelete'))) remove.mutate(d.id) }}
                    className="text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        ))}
        {depts.length === 0 && (
          <div className="col-span-3 p-8 text-center text-muted-foreground">
            <Building2 className="mx-auto mb-2 h-8 w-8 opacity-30" />{t('departments.empty')}
          </div>
        )}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNew(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">{t('departments.form.title')}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('departments.form.name')}</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('departments.form.namePlaceholder')} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('departments.form.code')}</label>
                <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('departments.form.codePlaceholder')} />
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('departments.form.cancel')}</button>
              <button onClick={() => create.mutate(form)} disabled={!form.name || create.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {create.isPending ? t('departments.form.creating') : t('departments.form.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Types d'absences ─────────────────────────────────────────────────────
function AbsenceTypesTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ code: '', label: '', color: '#6366F1', requires_approval: true, is_paid: true, max_days_per_year: '', calculation_mode: 'working_days' })

  const { data } = useQuery<{ data: AbsenceType[] }>({
    queryKey: ['settings-absence-types'],
    queryFn: () => api.get('/settings/absence-types').then(r => r.data),
  })
  const types = data?.data ?? []

  const create = useMutation({
    mutationFn: (d: typeof form) => api.post('/settings/absence-types', {
      ...d, max_days_per_year: d.max_days_per_year ? parseInt(d.max_days_per_year) : null
    }),
    onSuccess: () => { setShowNew(false); qc.invalidateQueries({ queryKey: ['settings-absence-types'] }) },
  })
  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.patch(`/settings/absence-types/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-absence-types'] }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/absence-types/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-absence-types'] }),
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? t('error')),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('absenceTypes.add')}
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-4">{t('absenceTypes.table.type')}</th>
              <th className="p-4">{t('absenceTypes.table.code')}</th>
              <th className="p-4">{t('absenceTypes.table.calculation')}</th>
              <th className="p-4">{t('absenceTypes.table.maxDaysPerYear')}</th>
              <th className="p-4">{t('absenceTypes.table.paid')}</th>
              <th className="p-4">{t('absenceTypes.table.approval')}</th>
              <th className="p-4">{t('absenceTypes.table.status')}</th>
              <th className="p-4">{t('absenceTypes.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {types.map(at => (
              <tr key={at.id} className="hover:bg-muted/30">
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: at.color }} />
                    <span className="font-medium">{at.label}</span>
                  </div>
                </td>
                <td className="p-4 font-mono text-xs text-muted-foreground">{at.code}</td>
                <td className="p-4 text-xs">{at.calculation_mode === 'working_days' ? t('absenceTypes.workingDays') : t('absenceTypes.calendarDays')}</td>
                <td className="p-4">{at.max_days_per_year ?? '—'}</td>
                <td className="p-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${at.is_paid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{at.is_paid ? t('absenceTypes.yes') : t('absenceTypes.no')}</span></td>
                <td className="p-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${at.requires_approval ? 'bg-orange-100 text-orange-700' : 'bg-muted text-muted-foreground'}`}>{at.requires_approval ? t('absenceTypes.approvalRequired') : t('absenceTypes.approvalAuto')}</span></td>
                <td className="p-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${at.is_active ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>{at.is_active ? t('absenceTypes.active') : t('absenceTypes.inactive')}</span></td>
                <td className="p-4 flex items-center gap-2">
                  <button onClick={() => toggleActive.mutate({ id: at.id, is_active: !at.is_active })}
                    className="text-xs text-muted-foreground hover:text-foreground">{at.is_active ? t('absenceTypes.deactivate') : t('absenceTypes.activate')}</button>
                  <button onClick={() => { if (confirm(t('absenceTypes.confirmDelete'))) remove.mutate(at.id) }}
                    className="text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNew(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">{t('absenceTypes.form.title')}</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('absenceTypes.form.code')}</label>
                  <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('absenceTypes.form.codePlaceholder')} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('absenceTypes.form.label')}</label>
                  <input value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('absenceTypes.form.labelPlaceholder')} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('absenceTypes.form.color')}</label>
                  <input type="color" value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                    className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-input" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('absenceTypes.form.maxDaysPerYear')}</label>
                  <input value={form.max_days_per_year} onChange={e => setForm(p => ({ ...p, max_days_per_year: e.target.value }))}
                    type="number" className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('absenceTypes.form.maxDaysPlaceholder')} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('absenceTypes.form.calculationMode')}</label>
                <select value={form.calculation_mode} onChange={e => setForm(p => ({ ...p, calculation_mode: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                  <option value="working_days">{t('absenceTypes.form.workingDaysOption')}</option>
                  <option value="calendar_days">{t('absenceTypes.form.calendarDaysOption')}</option>
                </select>
              </div>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.is_paid} onChange={e => setForm(p => ({ ...p, is_paid: e.target.checked }))} />
                  {t('absenceTypes.form.isPaid')}
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.requires_approval} onChange={e => setForm(p => ({ ...p, requires_approval: e.target.checked }))} />
                  {t('absenceTypes.form.requiresApproval')}
                </label>
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('absenceTypes.form.cancel')}</button>
              <button onClick={() => create.mutate(form)} disabled={!form.code || !form.label || create.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {create.isPending ? t('absenceTypes.form.creating') : t('absenceTypes.form.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Rubriques de paie ────────────────────────────────────────────────────
function PayrollRulesTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', type: 'earning', formula: '', rate: '', description: '' })

  const { data } = useQuery<{ data: PayrollRule[] }>({
    queryKey: ['settings-payroll-rules'],
    queryFn: () => api.get('/settings/payroll-rules').then(r => r.data),
  })
  const rules = data?.data ?? []

  const create = useMutation({
    mutationFn: (d: typeof form) => api.post('/settings/payroll-rules', {
      ...d, rate: d.rate ? parseFloat(d.rate) : null
    }),
    onSuccess: () => { setShowNew(false); qc.invalidateQueries({ queryKey: ['settings-payroll-rules'] }) },
  })
  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.patch(`/settings/payroll-rules/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-payroll-rules'] }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/payroll-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-payroll-rules'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('payrollRules.count', { count: rules.length })}
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('payrollRules.add')}
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-3">{t('payrollRules.table.code')}</th>
              <th className="p-3">{t('payrollRules.table.label')}</th>
              <th className="p-3">{t('payrollRules.table.type')}</th>
              <th className="p-3">{t('payrollRules.table.formulaOrRate')}</th>
              <th className="p-3">{t('payrollRules.table.status')}</th>
              <th className="p-3">{t('payrollRules.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rules.map(r => {
              const typeInfo = {
                label: (RULE_TYPE_KEYS as readonly string[]).includes(r.type) ? t(`ruleTypes.${r.type}`) : r.type,
                color: RULE_TYPE_COLORS[r.type] ?? 'bg-muted text-muted-foreground',
              }
              return (
                <tr key={r.id} className={`hover:bg-muted/30 ${!r.is_active ? 'opacity-50' : ''}`}>
                  <td className="p-3 font-mono text-xs font-bold">{r.code}</td>
                  <td className="p-3">
                    <p className="font-medium">{r.name}</p>
                    {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                  </td>
                  <td className="p-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeInfo.color}`}>{typeInfo.label}</span>
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {r.formula ?? (r.rate ? `${(parseFloat(r.rate) * 100).toFixed(2)} %` : '—')}
                  </td>
                  <td className="p-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>
                      {r.is_active ? t('payrollRules.active') : t('payrollRules.inactive')}
                    </span>
                  </td>
                  <td className="p-3 flex items-center gap-2">
                    <button onClick={() => toggleActive.mutate({ id: r.id, is_active: !r.is_active })}
                      className="text-xs text-muted-foreground hover:text-foreground">
                      {r.is_active ? t('payrollRules.deactivate') : t('payrollRules.activate')}
                    </button>
                    <button onClick={() => { if (confirm(t('payrollRules.confirmDelete'))) remove.mutate(r.id) }}
                      className="text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNew(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">{t('payrollRules.form.title')}</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('payrollRules.form.code')}</label>
                  <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('payrollRules.form.codePlaceholder')} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('payrollRules.form.type')}</label>
                  <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    {RULE_TYPE_KEYS.map(v => <option key={v} value={v}>{t(`ruleTypes.${v}`)}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('payrollRules.form.label')}</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder={t('payrollRules.form.labelPlaceholder')} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('payrollRules.form.formula')}</label>
                <input value={form.formula} onChange={e => setForm(p => ({ ...p, formula: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono outline-none" placeholder={t('payrollRules.form.formulaPlaceholder')} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('payrollRules.form.rate')}</label>
                <input value={form.rate} onChange={e => setForm(p => ({ ...p, rate: e.target.value }))}
                  type="number" step="0.001" className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('payrollRules.form.description')}</label>
                <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('payrollRules.form.cancel')}</button>
              <button onClick={() => create.mutate(form)} disabled={!form.code || !form.name || create.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {create.isPending ? t('payrollRules.form.creating') : t('payrollRules.form.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Entités juridiques ───────────────────────────────────────────────────
// Libellé du pays traduit via legalEntities.countries.<code> ; ici uniquement
// les données techniques (code, drapeau, pack législatif, devise).
// Les codes `pack` doivent correspondre EXACTEMENT aux clés du moteur de paie
// (LEGISLATION_PACKS dans legislation-packs.ts : ISO-3 + '-2024'). Un code non
// reconnu retomberait silencieusement sur le pack CIV par défaut → paie fausse.
// Ghana (GHA) n'a pas encore de pack paie modélisé : il reste au catalogue
// commercial (onglet Multi-législatif super_admin) mais n'est pas proposé comme
// filiale tant que la paie ghanéenne n'est pas implémentée.
const COUNTRY_OPTIONS: Array<{ code: string; flag: string; pack: string; currency: string }> = [
  { code: 'CIV', flag: '🇨🇮', pack: 'CIV-2024', currency: 'XOF' },
  { code: 'SEN', flag: '🇸🇳', pack: 'SEN-2024', currency: 'XOF' },
  { code: 'BEN', flag: '🇧🇯', pack: 'BEN-2024', currency: 'XOF' },
  { code: 'TGO', flag: '🇹🇬', pack: 'TGO-2024', currency: 'XOF' },
  { code: 'BFA', flag: '🇧🇫', pack: 'BFA-2024', currency: 'XOF' },
  { code: 'MLI', flag: '🇲🇱', pack: 'MLI-2024', currency: 'XOF' },
  { code: 'NER', flag: '🇳🇪', pack: 'NER-2024', currency: 'XOF' },
  { code: 'CMR', flag: '🇨🇲', pack: 'CMR-2024', currency: 'XAF' },
  { code: 'TCD', flag: '🇹🇩', pack: 'TCD-2024', currency: 'XAF' },
  { code: 'NGA', flag: '🇳🇬', pack: 'NGA-2024', currency: 'NGN' },
]

interface LegalEntityForm {
  name: string; rccm: string; cnps_number: string; dgi_number: string
  address: string; city: string; legal_form: string
  collective_agreement: string; at_rate: string
  country_code: string; legislation_pack_code: string
}

const EMPTY_LE_FORM: LegalEntityForm = {
  name: '', rccm: '', cnps_number: '', dgi_number: '',
  address: '', city: 'Abidjan', legal_form: 'SARL',
  collective_agreement: '', at_rate: '0.02',
  country_code: 'CIV', legislation_pack_code: 'CIV-2024',
}

function LegalEntitiesTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<LegalEntityForm>(EMPTY_LE_FORM)

  // Source de vérité : flag has_subsidiaries du tenant (défini par super_admin
  // lors de la création), pas l'heuristique "plus d'1 entité". Permet à un
  // tenant mono-pays de ne JAMAIS voir le vocabulaire "filiale".
  const tenantConfig = useAuthStore((s) => s.tenantConfig)
  const hasSubsidiaries = tenantConfig?.hasSubsidiaries === true
  const tenantDefaultCountry = tenantConfig?.defaultCountryCode ?? 'CIV'

  const { data } = useQuery<{ data: LegalEntity[] }>({
    queryKey: ['settings-legal-entities'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data),
  })
  const entities = data?.data ?? []

  const openCreate = () => {
    setEditingId(null)
    // Pré-remplit avec le pays par défaut du tenant pour éviter erreurs.
    const country = COUNTRY_OPTIONS.find(c => c.code === tenantDefaultCountry) ?? COUNTRY_OPTIONS[0]!
    setForm({
      ...EMPTY_LE_FORM,
      country_code: country.code,
      legislation_pack_code: country.pack,
    })
    setShowModal(true)
  }
  const openEdit = (e: LegalEntity) => {
    setEditingId(e.id)
    setForm({
      name: e.name, rccm: e.rccm ?? '', cnps_number: e.cnps_number ?? '',
      dgi_number: e.dgi_number ?? '', address: e.address ?? '', city: e.city,
      legal_form: e.legal_form, collective_agreement: e.collective_agreement ?? '',
      at_rate: e.at_rate, country_code: e.country_code ?? 'CIV',
      legislation_pack_code: e.legislation_pack_code ?? 'CIV-2024',
    })
    setShowModal(true)
  }

  const save = useMutation({
    mutationFn: (d: LegalEntityForm) => {
      const payload = { ...d, at_rate: parseFloat(d.at_rate) }
      return editingId
        ? api.patch(`/settings/legal-entities/${editingId}`, payload)
        : api.post('/settings/legal-entities', payload)
    },
    onSuccess: () => {
      setShowModal(false)
      setEditingId(null)
      qc.invalidateQueries({ queryKey: ['settings-legal-entities'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? t('error')),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/legal-entities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-legal-entities'] }),
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? t('error')),
  })

  const LEGAL_FORMS = ['SARL', 'SA', 'SAS', 'SASU', 'SNC', 'GIE', 'Association', 'ONG', 'Établissement public']
  const selectedCountry = COUNTRY_OPTIONS.find(c => c.code === form.country_code)

  // Mono-tenant : pas de bouton "Nouvelle entité" si l'entité principale existe
  // déjà (une seule autorisée). Multi-pays : bouton libellé "Nouvelle filiale".
  const canCreateMore = hasSubsidiaries || entities.length === 0

  return (
    <div className="space-y-4">
      {/* Bloc d'aide adapté au mode du tenant */}
      <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 text-sm text-blue-900">
        <p className="font-semibold mb-1">
          {hasSubsidiaries ? t('legalEntities.help.titleSubsidiaries') : t('legalEntities.help.titleSingle')}
        </p>
        {hasSubsidiaries ? (
          <p className="text-xs text-blue-800/90">
            <Trans t={t} i18nKey="legalEntities.help.textSubsidiaries" components={[<strong />]} />
          </p>
        ) : (
          <p className="text-xs text-blue-800/90">
            {t('legalEntities.help.textSingle')}
          </p>
        )}
      </div>

      {canCreateMore && (
        <div className="flex justify-end">
          <button onClick={openCreate}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" />
            {hasSubsidiaries ? t('legalEntities.newSubsidiary') : t('legalEntities.fillEntity')}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {entities.map(e => {
          const countryOpt = COUNTRY_OPTIONS.find(c => c.code === e.country_code) ?? COUNTRY_OPTIONS[0]!
          return (
            <div key={e.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{countryOpt.flag}</span>
                  <div>
                    <h3 className="font-semibold flex items-center gap-2">
                      {e.name}
                      {hasSubsidiaries && (
                        <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700">
                          {t('legalEntities.subsidiaryBadge')}
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t('legalEntities.entityMeta', { legalForm: e.legal_form, city: e.city, country: t(`legalEntities.countries.${countryOpt.code}`) })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-sm font-medium text-primary" title={t('legalEntities.employeesTitle')}>
                    <Users className="h-3.5 w-3.5" />{e.employees_count}
                  </span>
                  <button onClick={() => openEdit(e)}
                    className="text-muted-foreground hover:text-primary" title={t('legalEntities.edit')}>
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { if (confirm(t('legalEntities.confirmDelete'))) remove.mutate(e.id) }}
                    className="text-red-400 hover:text-red-600" title={t('legalEntities.delete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {e.cnps_number && <div><span className="text-muted-foreground">{t('legalEntities.card.cnps')}</span><span className="font-mono">{e.cnps_number}</span></div>}
                {e.dgi_number  && <div><span className="text-muted-foreground">{t('legalEntities.card.dgi')}</span><span className="font-mono">{e.dgi_number}</span></div>}
                {e.rccm        && <div><span className="text-muted-foreground">{t('legalEntities.card.rccm')}</span><span className="font-mono">{e.rccm}</span></div>}
                <div><span className="text-muted-foreground">{t('legalEntities.card.atRate')}</span><span className="font-medium">{(parseFloat(e.at_rate) * 100).toFixed(2)} %</span></div>
                {e.legislation_pack_code && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{t('legalEntities.card.legislationPack')}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5">{e.legislation_pack_code}</code>
                    <span className="ml-1 text-muted-foreground">({countryOpt.currency})</span>
                  </div>
                )}
                {e.collective_agreement && <div className="col-span-2"><span className="text-muted-foreground">{t('legalEntities.card.collectiveAgreement')}</span>{e.collective_agreement}</div>}
              </div>
            </div>
          )
        })}
        {entities.length === 0 && (
          <div className="col-span-2 rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
            <Layers className="mx-auto mb-2 h-8 w-8 opacity-30" />
            {t('legalEntities.empty')}
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto"
          onClick={() => setShowModal(false)}>
          <div className="rounded-xl border border-border bg-card w-full max-w-2xl max-h-[min(90vh,720px)] flex flex-col shadow-xl my-auto"
            onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 flex items-center justify-between border-b border-border bg-card px-5 py-3 rounded-t-xl">
              <h3 className="font-semibold">
                {editingId
                  ? (hasSubsidiaries ? t('legalEntities.modal.editSubsidiary') : t('legalEntities.modal.editEntity'))
                  : (hasSubsidiaries ? t('legalEntities.modal.newSubsidiary') : t('legalEntities.modal.newEntity'))}
              </h3>
              <button onClick={() => setShowModal(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.name')}</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder={hasSubsidiaries ? t('legalEntities.modal.namePlaceholderSubsidiary') : t('legalEntities.modal.namePlaceholderSingle')} />
              </div>

              {/* Pays + Pack législatif — visible uniquement si tenant multi-pays */}
              {hasSubsidiaries && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/30 p-3 space-y-3">
                <p className="text-xs font-semibold text-blue-900">{t('legalEntities.modal.complianceTitle')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.country')}</label>
                    <select value={form.country_code}
                      onChange={e => {
                        const c = COUNTRY_OPTIONS.find(x => x.code === e.target.value)
                        setForm(p => ({
                          ...p,
                          country_code: e.target.value,
                          legislation_pack_code: c?.pack ?? p.legislation_pack_code,
                        }))
                      }}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      {COUNTRY_OPTIONS.map(c => (
                        <option key={c.code} value={c.code}>{c.flag} {t(`legalEntities.countries.${c.code}`)} · {c.currency}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.legislationPack')}</label>
                    <input value={form.legislation_pack_code}
                      onChange={e => setForm(p => ({ ...p, legislation_pack_code: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono"
                      placeholder={t('legalEntities.modal.legislationPackPlaceholder')} />
                  </div>
                </div>
                {selectedCountry && (
                  <p className="text-[11px] text-blue-700">
                    {t('legalEntities.modal.engineApplied')}<code className="bg-blue-100 px-1 rounded">{form.legislation_pack_code}</code>
                    {' '}({selectedCountry.currency})
                  </p>
                )}
              </div>
              )}

              {/* Identité OHADA */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.legalForm')}</label>
                  <select value={form.legal_form} onChange={e => setForm(p => ({ ...p, legal_form: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    {LEGAL_FORMS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.city')}</label>
                  <input value={form.city} onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                    placeholder={t('legalEntities.modal.cityPlaceholder')} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.cnpsNumber')}</label>
                  <input value={form.cnps_number} onChange={e => setForm(p => ({ ...p, cnps_number: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.dgiNumber')}</label>
                  <input value={form.dgi_number} onChange={e => setForm(p => ({ ...p, dgi_number: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.rccm')}</label>
                  <input value={form.rccm} onChange={e => setForm(p => ({ ...p, rccm: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.atRate')}</label>
                  <input value={form.at_rate} onChange={e => setForm(p => ({ ...p, at_rate: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.collectiveAgreement')}</label>
                  <input value={form.collective_agreement} onChange={e => setForm(p => ({ ...p, collective_agreement: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                    placeholder={t('legalEntities.modal.collectiveAgreementPlaceholder')} />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium text-muted-foreground">{t('legalEntities.modal.address')}</label>
                  <input value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 flex gap-2 justify-end border-t border-border bg-card px-5 py-3 rounded-b-xl">
              <button onClick={() => setShowModal(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('legalEntities.modal.cancel')}</button>
              <button onClick={() => save.mutate(form)} disabled={!form.name || save.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {save.isPending
                  ? (editingId ? t('legalEntities.modal.updating') : t('legalEntities.modal.creating'))
                  : (editingId ? t('legalEntities.modal.save') : (hasSubsidiaries ? t('legalEntities.modal.createSubsidiary') : t('legalEntities.modal.save')))}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Reprise de données ───────────────────────────────────────────────────

interface ImportTemplate {
  id: string
  icon: React.ElementType
  color: string
  headers: string[]
  example: string[][]
  endpoint: string
}

const IMPORT_TEMPLATES: ImportTemplate[] = [
  {
    id: 'employees',
    icon: Users2,
    color: 'bg-blue-100 text-blue-600',
    endpoint: '/settings/import/employees',
    headers: ['prenom','nom','email','date_naissance','telephone','poste','departement','date_embauche','salaire_brut','type_contrat','statut','sexe','numero_cnps','ville'],
    example: [
      ['Kouamé','Konan','k.konan@entreprise.ci','1985-03-15','+225 07 12 34 56','Développeur Senior','Engineering','2022-01-10','450000','CDI','active','M','CI-123456','Abidjan'],
      ['Aminata','Traoré','a.traore@entreprise.ci','1990-07-22','+225 05 98 76 54','Chef de projet','Direction','2021-06-01','650000','CDI','active','F','CI-789012','Abidjan'],
    ],
  },
  {
    id: 'departments',
    icon: Building2,
    color: 'bg-purple-100 text-purple-600',
    endpoint: '/settings/import/departments',
    // Conforme schéma DB tenant.departments (nom, code, manager_id).
    // responsable_email → lookup users.email → manager_id côté handler.
    // 'description' a été retirée (pas de colonne dans la table).
    headers: ['nom','code','responsable_email'],
    example: [
      ['Engineering','ENG','manager@entreprise.ci'],
      ['Finance','FIN','finance@entreprise.ci'],
    ],
  },
  {
    id: 'absences',
    icon: CalendarDays,
    color: 'bg-orange-100 text-orange-600',
    endpoint: '/settings/import/absences',
    headers: ['email_employe','type_absence','date_debut','date_fin','statut','motif'],
    example: [
      ['k.konan@entreprise.ci','CP','2024-07-15','2024-07-26','approved','Congés annuels'],
      ['a.traore@entreprise.ci','Maladie','2024-09-03','2024-09-05','approved','Certificat médical'],
    ],
  },
  {
    id: 'pay_slips',
    icon: Banknote,
    color: 'bg-green-100 text-green-600',
    endpoint: '/settings/import/pay-slips',
    headers: ['email_employe','periode','salaire_brut','cotis_cnps_sal','its','net_paye','cout_employeur'],
    example: [
      ['k.konan@entreprise.ci','2024-06','450000','28350','14700','407000','521400'],
      ['a.traore@entreprise.ci','2024-06','650000','40950','30000','579050','752900'],
    ],
  },
  {
    id: 'contracts',
    icon: FileText,
    color: 'bg-slate-100 text-slate-600',
    endpoint: '/settings/import/contracts',
    headers: ['email_employe','type_contrat','date_debut','date_fin','salaire_base','periode_essai_jours','convention_collective','lieu_travail'],
    example: [
      ['k.konan@entreprise.ci','CDI','2022-01-10','','450000','60','Transport CI','Abidjan'],
      ['a.traore@entreprise.ci','CDD','2021-06-01','2022-05-31','650000','30','SYNTEC','Abidjan'],
    ],
  },
  {
    id: 'mobile_money',
    icon: Smartphone,
    color: 'bg-teal-100 text-teal-600',
    endpoint: '/settings/import/mobile-money',
    headers: ['email_employe','operateur','numero_telephone'],
    example: [
      ['k.konan@entreprise.ci','wave','+225 07 12 34 56'],
      ['a.traore@entreprise.ci','mtn_momo','+225 05 98 76 54'],
    ],
  },
  {
    id: 'expenses',
    icon: Receipt,
    color: 'bg-rose-100 text-rose-600',
    endpoint: '/settings/import/expenses',
    headers: ['email_employe','titre','mois','montant_total','statut'],
    example: [
      ['k.konan@entreprise.ci','Déplacement client','2024-06','25000','approved'],
      ['a.traore@entreprise.ci','Formation FDFP','2024-05','45000','reimbursed'],
    ],
  },
]

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = clean.split('\n').filter(l => l.trim())
  if (!lines[0]) return { headers: [], rows: [] }
  const sep = lines[0].includes(';') ? ';' : ','
  const splitLine = (l: string) => l.split(sep).map(v => v.trim().replace(/^"|"$/g, ''))
  return {
    headers: splitLine(lines[0]),
    rows: lines.slice(1).map(splitLine).filter(r => r.some(v => v)),
  }
}

function generateCSV(template: ImportTemplate): string {
  const bom = '﻿'
  const lines = [
    template.headers.join(';'),
    ...template.example.map(row => row.map(v => `"${v}"`).join(';')),
  ]
  return bom + lines.join('\r\n')
}

function downloadTemplate(template: ImportTemplate) {
  const csv = generateCSV(template)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `modele_${template.id}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

interface ImportResult {
  total: number; inserted: number; skipped: number; errors: string[]
}
interface GenerateUsersResult {
  created: number; emailSent: number; emailFailed: number; emailError?: string | null
  skipped: number; total: number; message?: string
}
interface UsersStatus { totalEmployees: number; withAccount: number; withoutAccount: number }

// ── Composant carte d'import individuelle ──────────────────────────────────

// Les messages sont produits à l'affichage via t() à partir de messageKey + count
// (i18n des pluriels). Les types techniques restent en anglais (valeurs internes).
interface ValidationIssue {
  type: 'missing_col' | 'extra_col' | 'empty_file' | 'wrong_format' | 'row_error'
  messageKey: string
  count?: number
  details?: string[]
}

function validateFile(file: File, template: ImportTemplate, text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { headers, rows } = parseCSV(text)

  if (!file.name.toLowerCase().endsWith('.csv')) {
    issues.push({ type: 'wrong_format', messageKey: 'dataImport.validation.wrongFormat' })
    return issues
  }
  if (headers.length === 0 || rows.length === 0) {
    issues.push({ type: 'empty_file', messageKey: 'dataImport.validation.emptyFile' })
    return issues
  }

  const missing = template.headers.filter(h => !headers.includes(h))
  if (missing.length > 0) {
    issues.push({
      type: 'missing_col',
      messageKey: 'dataImport.validation.missingCols',
      count: missing.length,
      details: missing,
    })
  }

  const extra = headers.filter(h => !template.headers.includes(h))
  if (extra.length > 0) {
    issues.push({
      type: 'extra_col',
      messageKey: 'dataImport.validation.extraCols',
      count: extra.length,
      details: extra,
    })
  }

  return issues
}

function TemplateImportCard({ template, onSuccess }: { template: ImportTemplate; onSuccess: () => void }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  const blockingIssues = issues.filter(i => i.type === 'missing_col' || i.type === 'empty_file' || i.type === 'wrong_format')
  const warningIssues = issues.filter(i => i.type === 'extra_col')

  async function handleFile(f: File) {
    setFile(f)
    setResult(null)
    setServerError(null)
    setIssues([])
    const text = await f.text()
    setIssues(validateFile(f, template, text))
  }

  async function handleUpload() {
    if (!file || blockingIssues.length > 0) return
    setUploading(true)
    setServerError(null)
    try {
      const text = await file.text()
      const { headers, rows } = parseCSV(text)
      const res = await api.post<ImportResult>(template.endpoint, { headers, rows })
      setResult(res.data)
      setFile(null)
      setIssues([])
      onSuccess()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setServerError(e.response?.data?.error ?? t('dataImport.card.serverErrorDefault'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={`rounded-xl border transition-all ${open ? 'border-primary shadow-sm' : 'border-border bg-card'}`}>
      {/* En-tête carte */}
      <div className="flex items-start gap-3 p-4">
        <div className={`rounded-lg p-2 shrink-0 ${template.color}`}>
          <template.icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">{t(`dataImport.templates.${template.id}.label`)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t(`dataImport.templates.${template.id}.description`)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); downloadTemplate(template) }}
            title={t('dataImport.card.downloadTitle')}
            className="flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
          >
            <Download className="h-3 w-3" /> {t('dataImport.card.template')}
          </button>
          <button
            onClick={() => { setOpen(o => !o); setFile(null); setIssues([]); setResult(null); setServerError(null) }}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              open ? 'bg-primary text-primary-foreground' : 'border border-border bg-background hover:bg-accent'
            }`}
          >
            <Upload className="h-3 w-3" /> {t('dataImport.card.import')}
          </button>
        </div>
      </div>

      {/* Zone d'import dépliable */}
      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          {/* Colonnes requises */}
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              {t('dataImport.card.requiredColumns', { count: template.headers.length })}
            </p>
            <div className="flex flex-wrap gap-1">
              {template.headers.map(h => (
                <span key={h} className={`rounded px-1.5 py-0.5 text-[10px] font-mono border ${
                  issues.some(i => i.type === 'missing_col' && i.details?.includes(h))
                    ? 'bg-red-50 border-red-300 text-red-700'
                    : 'bg-background border-border text-foreground'
                }`}>{h}</span>
              ))}
            </div>
          </div>

          {/* Drop zone */}
          {!result && (
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault(); setDragOver(false)
                const f = e.dataTransfer.files[0]
                if (f) void handleFile(f)
              }}
              className={`rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              }`}
            >
              {file ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">{file.name}</span>
                  <span className="text-xs text-muted-foreground">{t('dataImport.card.fileSize', { size: (file.size / 1024).toFixed(1) })}</span>
                  <button onClick={() => { setFile(null); setIssues([]); setServerError(null) }}
                    className="ml-1 text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="mx-auto h-6 w-6 text-muted-foreground mb-2" />
                  <p className="text-xs text-muted-foreground">{t('dataImport.card.dropHint')}</p>
                  <label className="mt-2 inline-block cursor-pointer rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
                    {t('dataImport.card.browse')}
                    <input type="file" accept=".csv" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = '' }} />
                  </label>
                </>
              )}
            </div>
          )}

          {/* Erreurs bloquantes */}
          {blockingIssues.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
                <p className="text-xs font-semibold text-red-800">
                  {t('dataImport.card.blockedTitle')}
                </p>
              </div>
              {blockingIssues.map((issue, i) => (
                <div key={i} className="pl-6">
                  <p className="text-xs text-red-700 font-medium">• {t(issue.messageKey, { count: issue.count })}</p>
                  {issue.details && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {issue.details.map(d => (
                        <span key={d} className="rounded bg-red-100 border border-red-200 px-1.5 py-0.5 text-[10px] font-mono text-red-700">{d}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <p className="pl-6 text-[10px] text-red-600">
                {t('dataImport.card.blockedHint')}
              </p>
            </div>
          )}

          {/* Avertissements non bloquants */}
          {warningIssues.length > 0 && blockingIssues.length === 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <p className="text-xs font-semibold text-amber-800">{t('dataImport.card.warningTitle')}</p>
              </div>
              {warningIssues.map((issue, i) => (
                <div key={i} className="pl-6">
                  <p className="text-xs text-amber-700">• {t(issue.messageKey, { count: issue.count })}</p>
                  {issue.details && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {issue.details.map(d => (
                        <span key={d} className="rounded bg-amber-100 border border-amber-200 px-1.5 py-0.5 text-[10px] font-mono text-amber-700">{d}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Erreur serveur */}
          {serverError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
              <p className="text-xs text-red-700">{serverError}</p>
            </div>
          )}

          {/* Résultat import */}
          {result && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <p className="text-sm font-semibold text-green-800">{t('dataImport.card.successTitle')}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  { label: t('dataImport.card.resultStats.total'), value: result.total, cls: 'text-foreground' },
                  { label: t('dataImport.card.resultStats.inserted'), value: result.inserted, cls: 'text-green-700' },
                  { label: t('dataImport.card.resultStats.skipped'), value: result.skipped, cls: 'text-amber-700' },
                ].map(({ label, value, cls }) => (
                  <div key={label} className="rounded bg-white border border-green-100 py-2">
                    <p className={`text-lg font-bold ${cls}`}>{value}</p>
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
              {result.errors.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 max-h-28 overflow-auto">
                  <p className="text-[10px] font-semibold text-amber-800 mb-1">{t('dataImport.card.warnings', { count: result.errors.length })}</p>
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-[10px] text-amber-700">• {err}</p>
                  ))}
                </div>
              )}
              <button onClick={() => setResult(null)} className="text-xs text-green-700 underline hover:text-green-900">
                {t('dataImport.card.importAnother')}
              </button>
            </div>
          )}

          {/* Bouton valider */}
          {file && !result && (
            <button
              onClick={() => void handleUpload()}
              disabled={uploading || blockingIssues.length > 0}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {uploading
                ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" /> {t('dataImport.card.importing')}</>
                : <><Upload className="h-3.5 w-3.5" /> {t('dataImport.card.validateAndImport')}</>
              }
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── DataImportTab ─────────────────────────────────────────────────────────────

function DataImportTab() {
  const { t } = useTranslation('settings')
  const [genResult, setGenResult] = useState<GenerateUsersResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [hasImported, setHasImported] = useState(false)

  const { data: statusData, refetch: refetchStatus } = useQuery<{ data: UsersStatus }>({
    queryKey: ['users-status'],
    queryFn: () => api.get('/settings/import/users-status').then(r => r.data),
    staleTime: 0,
  })
  const status = statusData?.data

  async function handleGenerateUsers() {
    setGenerating(true)
    setGenError(null)
    setGenResult(null)
    try {
      const res = await api.post<GenerateUsersResult>('/settings/import/generate-users', {})
      setGenResult(res.data)
      void refetchStatus()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      setGenError(e.response?.data?.error ?? t('dataImport.generateUsers.defaultError'))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 flex items-start gap-3">
        <Database className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-blue-800 text-sm">{t('dataImport.header.title')}</p>
          <p className="text-xs text-blue-600 mt-0.5">
            {t('dataImport.header.description')}
          </p>
        </div>
      </div>

      {/* Section génération d'accès */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2 shrink-0">
              <KeyRound className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold">{t('dataImport.generateUsers.title')}</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t('dataImport.generateUsers.description')}
              </p>
            </div>
          </div>
          {status && (
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold text-primary">{status.withoutAccount}</p>
              <p className="text-xs text-muted-foreground">{t('dataImport.generateUsers.withoutAccount')}</p>
            </div>
          )}
        </div>

        {status && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: t('dataImport.generateUsers.stats.activeEmployees'), value: status.totalEmployees, color: 'text-foreground' },
              { label: t('dataImport.generateUsers.stats.withAccess'), value: status.withAccount, color: 'text-green-600' },
              { label: t('dataImport.generateUsers.stats.withoutAccess'), value: status.withoutAccount, color: status.withoutAccount > 0 ? 'text-amber-600' : 'text-muted-foreground' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-lg border border-border bg-muted/30 p-3 text-center">
                <p className={`text-xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        )}

        {genError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" /> {genError}
          </div>
        )}

        {genResult && (
          <div className={`rounded-lg border p-4 space-y-2 ${genResult.emailFailed > 0 && genResult.emailSent === 0 ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50'}`}>
            <div className="flex items-center gap-2">
              <CheckCircle2 className={`h-4 w-4 ${genResult.emailFailed > 0 && genResult.emailSent === 0 ? 'text-amber-600' : 'text-green-600'}`} />
              <p className={`font-medium text-sm ${genResult.emailFailed > 0 && genResult.emailSent === 0 ? 'text-amber-800' : 'text-green-800'}`}>
                {genResult.message ?? t('dataImport.generateUsers.resultMessage', { created: genResult.created, total: genResult.total })}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div><p className="font-bold text-green-700">{genResult.created}</p><p className="text-muted-foreground">{t('dataImport.generateUsers.resultStats.created')}</p></div>
              <div><p className="font-bold text-blue-700">{genResult.emailSent}</p><p className="text-muted-foreground">{t('dataImport.generateUsers.resultStats.emailsSent')}</p></div>
              <div><p className="font-bold text-amber-700">{genResult.emailFailed}</p><p className="text-muted-foreground">{t('dataImport.generateUsers.resultStats.emailsFailed')}</p></div>
            </div>
            {genResult.emailFailed > 0 && genResult.emailError && (
              <div className="rounded bg-amber-100 border border-amber-200 px-3 py-2 text-xs text-amber-800 font-mono break-all">
                {t('dataImport.generateUsers.smtpError', { error: genResult.emailError })}
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => void handleGenerateUsers()}
          disabled={generating || ((status?.withoutAccount ?? 0) === 0 && !hasImported)}
          className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {generating
            ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />{t('dataImport.generateUsers.generating')}</>
            : <><Mail className="h-4 w-4" />{t('dataImport.generateUsers.action')}</>
          }
        </button>
        {(status?.withoutAccount ?? 0) === 0 && !generating && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> {t('dataImport.generateUsers.allHaveAccount')}
          </p>
        )}
      </div>

      {/* Grille des templates avec upload intégré */}
      <div>
        <h2 className="font-semibold mb-1">{t('dataImport.modules.title')}</h2>
        <p className="text-xs text-muted-foreground mb-4">
          <Trans t={t} i18nKey="dataImport.modules.description" components={[<strong />, <strong />]} />
        </p>
        <div className="space-y-2">
          {IMPORT_TEMPLATES.map(tpl => (
            <TemplateImportCard
              key={tpl.id}
              template={tpl}
              onSuccess={() => { setHasImported(true); void refetchStatus() }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Tab: Workflow ─────────────────────────────────────────────────────────────
// Clés de traduction des niveaux d'approbation (libellés via workflow.levelNames.<key>).
const LEVEL_NAME_KEYS = ['directManager', 'hrManager', 'accounting', 'generalManagement', 'ceo'] as const

// Icône + couleur par module ; libellé/description traduits via workflow.modules.<module>.*
const MODULE_META: Record<string, { icon: React.ElementType; color: string }> = {
  absences: { icon: CalendarDays, color: 'bg-orange-100 text-orange-600' },
  expenses: { icon: Receipt,      color: 'bg-rose-100 text-rose-600' },
  payroll:  { icon: Banknote,     color: 'bg-green-100 text-green-600' },
}

function WorkflowTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { t } = useTranslation('settings')
  const [localConfigs, setLocalConfigs] = useState<Record<string, number>>({})

  const { data } = useQuery<{ data: WorkflowConfig[] }>({
    queryKey: ['settings-workflow'],
    queryFn: () => api.get('/settings/workflow').then(r => r.data),
  })

  const configs = data?.data ?? []
  // Ensure payroll module exists locally
  const allModules = ['absences', 'expenses', 'payroll']
  const configMap = Object.fromEntries(configs.map(c => [c.module, c]))

  const save = useMutation({
    mutationFn: () => api.patch('/settings/workflow',
      allModules.map(m => ({
        module: m,
        levels_count: localConfigs[m] ?? configMap[m]?.levels_count ?? 1,
      }))
    ),
    onSuccess: () => { setLocalConfigs({}); qc.invalidateQueries({ queryKey: ['settings-workflow'] }) },
  })

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-xl border border-border bg-card p-6 space-y-5">
        <div>
          <h2 className="font-semibold">{t('workflow.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('workflow.description')}
          </p>
        </div>

        {allModules.map(module => {
          const meta = MODULE_META[module]!
          const current = localConfigs[module] ?? configMap[module]?.levels_count ?? 1
          const chainFor = (count: number) => LEVEL_NAME_KEYS.slice(0, count).map(k => t(`workflow.levelNames.${k}`)).join(' → ')
          return (
            <div key={module} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${meta.color}`}>
                  <meta.icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{t(`workflow.modules.${module}.label`)}</p>
                  <p className="text-xs text-muted-foreground">{t(`workflow.modules.${module}.desc`)}</p>
                </div>
                <span className="ml-auto rounded-full bg-primary/10 text-primary text-xs font-bold px-2 py-0.5">
                  {t('workflow.levelBadge', { count: current })}
                </span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n}
                    onClick={() => setLocalConfigs(p => ({ ...p, [module]: n }))}
                    title={chainFor(n)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      current === n
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border hover:border-primary/50 text-muted-foreground'
                    }`}>
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {t('workflow.chain', { chain: chainFor(current) })}
              </p>
            </div>
          )
        })}

        <div className="flex items-center gap-3">
          <button onClick={() => save.mutate()}
            disabled={save.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {save.isPending ? t('workflow.saving') : t('workflow.save')}
          </button>
          {save.isSuccess && <span className="text-xs text-green-600">✓ {t('workflow.saved')}</span>}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 space-y-3">
        <h2 className="font-semibold">{t('workflow.constants.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('workflow.constants.subtitle')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            [t('workflow.constants.smigMonthly'), t('workflow.constants.smigMonthlyValue')],
            [t('workflow.constants.leavePerMonth'), t('workflow.constants.leavePerMonthValue')],
            [t('workflow.constants.cnpsRetirementEmployee'), t('workflow.constants.cnpsRetirementEmployeeValue')],
            [t('workflow.constants.cnpsRetirementEmployer'), t('workflow.constants.cnpsRetirementEmployerValue')],
            [t('workflow.constants.retirementCeiling'), t('workflow.constants.retirementCeilingValue')],
            [t('workflow.constants.atPfCeiling'), t('workflow.constants.atPfCeilingValue')],
            [t('workflow.constants.itsAbatement'), t('workflow.constants.itsAbatementValue')],
            [t('workflow.constants.fdfpContribution'), t('workflow.constants.fdfpContributionValue')],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Onglet : Modèle de bulletin (personnalisable par tenant) ──────────────────
