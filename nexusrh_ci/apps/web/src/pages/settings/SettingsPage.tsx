import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Settings, Users, Building2, Save, Plus, ShieldCheck, Trash2,
  FileText, Layers, GitBranch, Banknote, Edit2, X, Check,
  Download, Upload, AlertCircle, CheckCircle2, Database, Mail, KeyRound,
  Users2, CalendarDays, Smartphone, Receipt, RefreshCw, Copy, Lock,
} from 'lucide-react'
import MfaSettingsPage from './MfaSettingsPage'

// ── Types ──────────────────────────────────────────────────────────────────────
interface TenantSettings {
  id: string; name: string; slug: string; plan_type: string; status: string
  sector: string | null; city: string | null; cnps_number: string | null
  dgi_number: string | null; rccm: string | null; at_rate: string | null
  primary_color: string; secondary_color: string; logo_url: string | null
  max_users: number; max_employees: number
  mfa_required?: boolean
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
const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrateur', hr_manager: 'Responsable RH',
  hr_officer: 'Chargé RH', manager: 'Manager',
  employee: 'Employé', readonly: 'Lecture seule',
}
const RULE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  earning:             { label: 'Gain',            color: 'bg-green-100 text-green-700' },
  deduction:           { label: 'Retenue',          color: 'bg-red-100 text-red-700' },
  employee_contrib:    { label: 'Cotis. salariale', color: 'bg-orange-100 text-orange-700' },
  employer_contrib:    { label: 'Cotis. patronale', color: 'bg-blue-100 text-blue-700' },
}
const TABS = [
  { id: 'general',        label: 'Général',           icon: Settings },
  { id: 'users',          label: 'Utilisateurs',      icon: Users },
  { id: 'departments',    label: 'Départements',      icon: Building2 },
  { id: 'absence-types',  label: 'Types absences',    icon: FileText },
  { id: 'payroll-rules',  label: 'Rubriques de paie', icon: Banknote },
  { id: 'legal-entities', label: 'Entités juridiques',icon: Layers },
  { id: 'workflow',       label: 'Workflow',          icon: GitBranch },
  { id: 'data-import',   label: 'Reprise de données',icon: Database },
  { id: 'mfa',           label: 'Sécurité (MFA)',    icon: Lock },
] as const
type TabId = typeof TABS[number]['id']

// ── Main component ────────────────────────────────────────────────────────────
export default function SettingsPage() {
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
        <h1 className="text-2xl font-bold">Paramètres</h1>
        <p className="text-sm text-muted-foreground mt-1">{tenantConfig?.name}</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/30 p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}>
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
      </div>

      {tab === 'general'        && <GeneralTab qc={qc} />}
      {tab === 'users'          && <UsersTab qc={qc} />}
      {tab === 'departments'    && <DepartmentsTab qc={qc} />}
      {tab === 'absence-types'  && <AbsenceTypesTab qc={qc} />}
      {tab === 'payroll-rules'  && <PayrollRulesTab qc={qc} />}
      {tab === 'legal-entities' && <LegalEntitiesTab qc={qc} />}
      {tab === 'workflow'       && <WorkflowTab qc={qc} />}
      {tab === 'data-import'   && <DataImportTab />}
      {tab === 'mfa'           && <MfaSettingsPage />}
    </div>
  )
}

// ── Tab: Général ──────────────────────────────────────────────────────────────
function GeneralTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [form, setForm] = useState<Partial<TenantSettings>>({})
  const { data } = useQuery<{ data: TenantSettings }>({
    queryKey: ['settings-tenant'],
    queryFn: () => api.get('/settings/tenant').then(r => r.data),
  })
  const update = useMutation({
    mutationFn: (d: Partial<TenantSettings>) => api.patch('/settings/tenant', d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings-tenant'] }); setForm({}) },
  })
  const s = data?.data
  if (!s) return <div className="p-8 text-center text-muted-foreground">Chargement...</div>

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
        <h2 className="font-semibold">Informations entreprise</h2>
        <div className="grid grid-cols-2 gap-4">
          {field('name', 'Nom entreprise')}
          {field('city', 'Ville (CI)')}
          {field('cnps_number', 'N° CNPS employeur')}
          {field('dgi_number', 'N° DGI')}
          {field('rccm', 'RCCM')}
          {field('at_rate', 'Taux AT CNPS (ex: 0.03)')}
        </div>

        <h2 className="font-semibold pt-2">Secteur d'activité</h2>
        <select defaultValue={s.sector || ''}
          onChange={e => setForm(p => ({ ...p, sector: e.target.value }))}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
          <option value="">— Sélectionner —</option>
          {['transport','commerce','industrie','services','btp','finance','sante','ong','public'].map(v => (
            <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
          ))}
        </select>

        <h2 className="font-semibold pt-2">Apparence & thème</h2>
        <div className="grid grid-cols-2 gap-4">
          {(['primary_color', 'secondary_color'] as const).map(k => (
            <div key={k}>
              <label className="text-xs font-medium text-muted-foreground">
                {k === 'primary_color' ? 'Couleur primaire' : 'Couleur secondaire'}
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

        <h2 className="font-semibold pt-2">Sécurité</h2>
        <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer">
          <input type="checkbox"
            defaultChecked={!!s.mfa_required}
            onChange={e => setForm(p => ({ ...p, mfa_required: e.target.checked }))}
            className="mt-0.5 h-4 w-4" />
          <span className="text-sm">
            <span className="font-medium">Imposer le MFA à tous les employés de ce tenant</span>
            <span className="block text-xs text-muted-foreground">
              Durcit la politique plateforme — vous pouvez l'imposer ici même si elle n'est pas globalement obligatoire,
              mais pas l'assouplir si la plateforme l'exige déjà.
            </span>
          </span>
        </label>

        <div className="pt-2 flex items-center justify-between border-t border-border">
          <p className="text-xs text-muted-foreground">
            Plan <span className="font-semibold">{s.plan_type}</span> ·
            Max {s.max_users} users · Max {s.max_employees} employés
          </p>
          <button onClick={() => update.mutate(form)}
            disabled={Object.keys(form).length === 0 || update.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {update.isPending ? 'Sauvegarde...' : 'Sauvegarder'}
          </button>
        </div>
        {update.isSuccess && <p className="text-xs text-green-600">Paramètres mis à jour.</p>}
      </div>
    </div>
  )
}

// ── Tab: Utilisateurs ─────────────────────────────────────────────────────────
const EMPTY_USER_FORM = { email: '', first_name: '', last_name: '', role: 'employee', department_id: '', is_active: true }

function UsersTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
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
          <Plus className="h-4 w-4" /> Ajouter un utilisateur
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-4">Utilisateur</th>
              <th className="p-4">Rôle</th>
              <th className="p-4">Poste</th>
              <th className="p-4">Dernière connexion</th>
              <th className="p-4">Statut</th>
              <th className="p-4">Actions</th>
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
                    {ROLE_LABELS[u.role] ?? u.role}
                  </span>
                </td>
                <td className="p-4 text-muted-foreground">{u.job_title ?? '—'}</td>
                <td className="p-4 text-xs text-muted-foreground">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('fr-CI') : 'Jamais'}
                </td>
                <td className="p-4">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {u.is_active ? 'Actif' : 'Inactif'}
                  </span>
                </td>
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggle.mutate({ id: u.id, is_active: !u.is_active })}
                      className={`text-xs ${u.is_active ? 'text-orange-600 hover:underline' : 'text-green-600 hover:underline'}`}>
                      {u.is_active ? 'Désactiver' : 'Activer'}
                    </button>
                    <button
                      onClick={() => { if (confirm(`Réinitialiser le mot de passe de ${u.first_name} ${u.last_name} ?`)) resetPwd.mutate({ id: u.id }) }}
                      disabled={resetPwd.isPending}
                      title="Réinitialiser le mot de passe"
                      className="text-blue-500 hover:text-blue-700 disabled:opacity-40">
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => { if (confirm('Supprimer cet utilisateur ?')) remove.mutate(u.id) }}
                      className="text-red-500 hover:text-red-700"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">
                <Users className="mx-auto mb-2 h-8 w-8 opacity-30" />Aucun utilisateur
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
            <h3 className="font-semibold">Mot de passe réinitialisé</h3>
            <p className="text-sm text-muted-foreground">Nouveau mot de passe temporaire pour <strong>{resetResult.name}</strong> :</p>
            <div className="flex items-center gap-2 rounded-lg bg-muted px-4 py-3">
              <span className="flex-1 font-mono text-base font-bold tracking-wider">{resetResult.pwd}</span>
              <button onClick={() => { void navigator.clipboard.writeText(resetResult.pwd); setCopied(true) }}
                className="text-muted-foreground hover:text-foreground">
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            {resetResult.emailSent
              ? <p className="text-xs text-green-600 flex items-center justify-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Email envoyé à l'utilisateur</p>
              : <p className="text-xs text-amber-600">Email non envoyé — communiquez ce mot de passe manuellement.</p>
            }
            <button onClick={() => { setResetResult(null); setCopied(false) }}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Fermer</button>
          </div>
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowNew(false); setTempPwd(null) }}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            {tempPwd ? (
              <div className="text-center space-y-3">
                <ShieldCheck className="mx-auto h-10 w-10 text-green-600" />
                <h3 className="font-semibold">Utilisateur créé !</h3>
                <p className="text-sm text-muted-foreground">Mot de passe temporaire :</p>
                <div className="rounded-lg bg-muted px-4 py-3 font-mono text-lg font-bold tracking-widest">{tempPwd}</div>
                <p className="text-xs text-muted-foreground">Communiquez ce mot de passe de façon sécurisée.</p>
                <button onClick={() => { setShowNew(false); setTempPwd(null); setForm(EMPTY_USER_FORM) }}
                  className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Fermer</button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Ajouter un utilisateur</h3>
                  <button onClick={() => setShowNew(false)}><X className="h-4 w-4" /></button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Email *</label>
                    <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                      type="email" className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(['first_name', 'last_name'] as const).map(k => (
                      <div key={k}>
                        <label className="text-xs font-medium text-muted-foreground">{k === 'first_name' ? 'Prénom' : 'Nom'} *</label>
                        <input value={form[k]} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
                          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                      </div>
                    ))}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Rôle</label>
                    <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Département</label>
                    <select value={form.department_id} onChange={e => setForm(p => ({ ...p, department_id: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      <option value="">— Aucun —</option>
                      {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Statut</label>
                    <select value={form.is_active ? 'true' : 'false'} onChange={e => setForm(p => ({ ...p, is_active: e.target.value === 'true' }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                      <option value="true">Actif</option>
                      <option value="false">Inactif</option>
                    </select>
                  </div>
                </div>
                <div className="mt-5 flex gap-2 justify-end">
                  <button onClick={() => setShowNew(false)}
                    className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
                  <button onClick={() => create.mutate(form)}
                    disabled={!form.email || !form.first_name || !form.last_name || create.isPending}
                    className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {create.isPending ? 'Création...' : 'Créer'}
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
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? 'Erreur'),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> Nouveau département
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
                  placeholder="Code" className="w-full rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none" />
                <div className="flex gap-2">
                  <button onClick={() => update.mutate(editing)}
                    className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground">
                    <Check className="h-3 w-3" /> OK
                  </button>
                  <button onClick={() => setEditing(null)} className="rounded border border-border px-2 py-1 text-xs">Annuler</button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">{d.name}</p>
                  {d.code && <p className="text-xs text-muted-foreground">{d.code}</p>}
                  {d.manager_name && <p className="text-xs text-muted-foreground mt-1">Manager : {d.manager_name}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-sm font-medium text-primary">
                    <Users className="h-3.5 w-3.5" />{d.employees_count}
                  </span>
                  <button onClick={() => setEditing({ id: d.id, name: d.name, code: d.code ?? '' })}
                    className="text-muted-foreground hover:text-foreground"><Edit2 className="h-3.5 w-3.5" /></button>
                  <button onClick={() => { if (confirm('Supprimer ce département ?')) remove.mutate(d.id) }}
                    className="text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        ))}
        {depts.length === 0 && (
          <div className="col-span-3 p-8 text-center text-muted-foreground">
            <Building2 className="mx-auto mb-2 h-8 w-8 opacity-30" />Aucun département
          </div>
        )}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNew(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">Nouveau département</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Nom *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="Ex: Direction Exploitation" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Code</label>
                <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="EXPL" />
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => create.mutate(form)} disabled={!form.name || create.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {create.isPending ? 'Création...' : 'Créer'}
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
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? 'Erreur'),
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> Nouveau type
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-4">Type</th>
              <th className="p-4">Code</th>
              <th className="p-4">Calcul</th>
              <th className="p-4">Max jours/an</th>
              <th className="p-4">Payé</th>
              <th className="p-4">Approbation</th>
              <th className="p-4">Statut</th>
              <th className="p-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {types.map(t => (
              <tr key={t.id} className="hover:bg-muted/30">
                <td className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="font-medium">{t.label}</span>
                  </div>
                </td>
                <td className="p-4 font-mono text-xs text-muted-foreground">{t.code}</td>
                <td className="p-4 text-xs">{t.calculation_mode === 'working_days' ? 'Jours ouvrables' : 'Jours calendaires'}</td>
                <td className="p-4">{t.max_days_per_year ?? '—'}</td>
                <td className="p-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.is_paid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{t.is_paid ? 'Oui' : 'Non'}</span></td>
                <td className="p-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.requires_approval ? 'bg-orange-100 text-orange-700' : 'bg-muted text-muted-foreground'}`}>{t.requires_approval ? 'Requise' : 'Auto'}</span></td>
                <td className="p-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.is_active ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>{t.is_active ? 'Actif' : 'Inactif'}</span></td>
                <td className="p-4 flex items-center gap-2">
                  <button onClick={() => toggleActive.mutate({ id: t.id, is_active: !t.is_active })}
                    className="text-xs text-muted-foreground hover:text-foreground">{t.is_active ? 'Désactiver' : 'Activer'}</button>
                  <button onClick={() => { if (confirm('Supprimer ce type ?')) remove.mutate(t.id) }}
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
            <h3 className="font-semibold mb-4">Nouveau type d'absence</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Code *</label>
                  <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="RTT" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Libellé *</label>
                  <input value={form.label} onChange={e => setForm(p => ({ ...p, label: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="Récupération" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Couleur</label>
                  <input type="color" value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                    className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-input" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Max jours/an</label>
                  <input value={form.max_days_per_year} onChange={e => setForm(p => ({ ...p, max_days_per_year: e.target.value }))}
                    type="number" className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="26" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Mode de calcul</label>
                <select value={form.calculation_mode} onChange={e => setForm(p => ({ ...p, calculation_mode: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                  <option value="working_days">Jours ouvrables (Code Travail CI)</option>
                  <option value="calendar_days">Jours calendaires</option>
                </select>
              </div>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.is_paid} onChange={e => setForm(p => ({ ...p, is_paid: e.target.checked }))} />
                  Absence payée
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.requires_approval} onChange={e => setForm(p => ({ ...p, requires_approval: e.target.checked }))} />
                  Approbation requise
                </label>
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => create.mutate(form)} disabled={!form.code || !form.label || create.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {create.isPending ? 'Création...' : 'Créer'}
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
          {rules.length} rubrique(s) configurée(s) — Conformes CNPS 2024 & ITS/DGI CI
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> Nouvelle rubrique
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-3">Code</th>
              <th className="p-3">Libellé</th>
              <th className="p-3">Type</th>
              <th className="p-3">Formule / Taux</th>
              <th className="p-3">Statut</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rules.map(r => {
              const typeInfo = RULE_TYPE_LABELS[r.type] ?? { label: r.type, color: 'bg-muted text-muted-foreground' }
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
                      {r.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-3 flex items-center gap-2">
                    <button onClick={() => toggleActive.mutate({ id: r.id, is_active: !r.is_active })}
                      className="text-xs text-muted-foreground hover:text-foreground">
                      {r.is_active ? 'Désactiver' : 'Activer'}
                    </button>
                    <button onClick={() => { if (confirm('Supprimer cette rubrique ?')) remove.mutate(r.id) }}
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
            <h3 className="font-semibold mb-4">Nouvelle rubrique de paie</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Code *</label>
                  <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="6000" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Type *</label>
                  <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    {Object.entries(RULE_TYPE_LABELS).map(([v, { label }]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Libellé *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" placeholder="Prime de rendement" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Formule (ex: BRUT_MENSUEL * 0.05)</label>
                <input value={form.formula} onChange={e => setForm(p => ({ ...p, formula: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono outline-none" placeholder="VAR:PRIME_RENDEMENT" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Taux (si cotisation, ex: 0.063)</label>
                <input value={form.rate} onChange={e => setForm(p => ({ ...p, rate: e.target.value }))}
                  type="number" step="0.001" className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => create.mutate(form)} disabled={!form.code || !form.name || create.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {create.isPending ? 'Création...' : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Entités juridiques ───────────────────────────────────────────────────
const COUNTRY_OPTIONS: Array<{ code: string; label: string; flag: string; pack: string; currency: string }> = [
  { code: 'CIV', label: 'Côte d\'Ivoire',  flag: '🇨🇮', pack: 'ci_2024', currency: 'XOF' },
  { code: 'SEN', label: 'Sénégal',         flag: '🇸🇳', pack: 'sn_2024', currency: 'XOF' },
  { code: 'BEN', label: 'Bénin',           flag: '🇧🇯', pack: 'bj_2024', currency: 'XOF' },
  { code: 'TGO', label: 'Togo',            flag: '🇹🇬', pack: 'tg_2024', currency: 'XOF' },
  { code: 'BFA', label: 'Burkina Faso',    flag: '🇧🇫', pack: 'bf_2024', currency: 'XOF' },
  { code: 'MLI', label: 'Mali',            flag: '🇲🇱', pack: 'ml_2024', currency: 'XOF' },
  { code: 'NER', label: 'Niger',           flag: '🇳🇪', pack: 'ne_2024', currency: 'XOF' },
  { code: 'CMR', label: 'Cameroun',        flag: '🇨🇲', pack: 'cm_2024', currency: 'XAF' },
  { code: 'TCD', label: 'Tchad',           flag: '🇹🇩', pack: 'td_2024', currency: 'XAF' },
  { code: 'NGA', label: 'Nigeria',         flag: '🇳🇬', pack: 'ng_2024', currency: 'NGN' },
  { code: 'GHA', label: 'Ghana',           flag: '🇬🇭', pack: 'gh_2024', currency: 'GHS' },
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
  country_code: 'CIV', legislation_pack_code: 'ci_2024',
}

function LegalEntitiesTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
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
      legislation_pack_code: e.legislation_pack_code ?? 'ci_2024',
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
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? 'Erreur'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/legal-entities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-legal-entities'] }),
    onError: (e: { response?: { data?: { error?: string } } }) => alert(e.response?.data?.error ?? 'Erreur'),
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
          {hasSubsidiaries ? 'Filiales du groupe' : 'Entité juridique'}
        </p>
        {hasSubsidiaries ? (
          <p className="text-xs text-blue-800/90">
            Chaque filiale représente un établissement avec ses propres N° CNPS,
            RCCM, pays et pack législatif. <strong>Les employés sont rattachés à
            une filiale via leur fiche</strong>. Le moteur de paie applique alors
            le pack législatif de la filiale du salarié (CNPS, IPRES, etc. selon
            le pays). CNPS/DISA peut être générée par filiale ou consolidée.
          </p>
        ) : (
          <p className="text-xs text-blue-800/90">
            Renseignez ici les informations légales de votre entreprise
            (N° CNPS employeur, RCCM, taux AT, convention collective). Ces
            informations sont utilisées sur les bulletins de paie, contrats
            et déclarations sociales.
          </p>
        )}
      </div>

      {canCreateMore && (
        <div className="flex justify-end">
          <button onClick={openCreate}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" />
            {hasSubsidiaries ? 'Nouvelle filiale' : 'Renseigner l\'entité'}
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
                          Filiale
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {e.legal_form} · {e.city} · {countryOpt.label}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-sm font-medium text-primary" title="Employés rattachés">
                    <Users className="h-3.5 w-3.5" />{e.employees_count}
                  </span>
                  <button onClick={() => openEdit(e)}
                    className="text-muted-foreground hover:text-primary" title="Modifier">
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { if (confirm('Supprimer cette entité ?')) remove.mutate(e.id) }}
                    className="text-red-400 hover:text-red-600" title="Supprimer">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {e.cnps_number && <div><span className="text-muted-foreground">CNPS : </span><span className="font-mono">{e.cnps_number}</span></div>}
                {e.dgi_number  && <div><span className="text-muted-foreground">DGI : </span><span className="font-mono">{e.dgi_number}</span></div>}
                {e.rccm        && <div><span className="text-muted-foreground">RCCM : </span><span className="font-mono">{e.rccm}</span></div>}
                <div><span className="text-muted-foreground">Taux AT : </span><span className="font-medium">{(parseFloat(e.at_rate) * 100).toFixed(2)} %</span></div>
                {e.legislation_pack_code && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Pack législatif : </span>
                    <code className="rounded bg-muted px-1.5 py-0.5">{e.legislation_pack_code}</code>
                    <span className="ml-1 text-muted-foreground">({countryOpt.currency})</span>
                  </div>
                )}
                {e.collective_agreement && <div className="col-span-2"><span className="text-muted-foreground">CCN : </span>{e.collective_agreement}</div>}
              </div>
            </div>
          )
        })}
        {entities.length === 0 && (
          <div className="col-span-2 rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
            <Layers className="mx-auto mb-2 h-8 w-8 opacity-30" />
            Aucune entité juridique — créez votre première entité (siège social ou filiale).
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
                  ? (hasSubsidiaries ? 'Modifier la filiale' : 'Modifier l\'entité juridique')
                  : (hasSubsidiaries ? 'Nouvelle filiale' : 'Entité juridique principale')}
              </h3>
              <button onClick={() => setShowModal(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Raison sociale *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder={hasSubsidiaries ? "Ex: SOTRA Bouaké" : "Ex: OpenLab Consulting"} />
              </div>

              {/* Pays + Pack législatif — visible uniquement si tenant multi-pays */}
              {hasSubsidiaries && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/30 p-3 space-y-3">
                <p className="text-xs font-semibold text-blue-900">Conformité légale par pays</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Pays</label>
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
                        <option key={c.code} value={c.code}>{c.flag} {c.label} · {c.currency}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Pack législatif</label>
                    <input value={form.legislation_pack_code}
                      onChange={e => setForm(p => ({ ...p, legislation_pack_code: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono"
                      placeholder="ci_2024" />
                  </div>
                </div>
                {selectedCountry && (
                  <p className="text-[11px] text-blue-700">
                    Moteur de paie appliqué : <code className="bg-blue-100 px-1 rounded">{form.legislation_pack_code}</code>
                    {' '}({selectedCountry.currency})
                  </p>
                )}
              </div>
              )}

              {/* Identité OHADA */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Forme juridique</label>
                  <select value={form.legal_form} onChange={e => setForm(p => ({ ...p, legal_form: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    {LEGAL_FORMS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Ville</label>
                  <input value={form.city} onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                    placeholder="Abidjan" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">N° CNPS employeur</label>
                  <input value={form.cnps_number} onChange={e => setForm(p => ({ ...p, cnps_number: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">N° DGI</label>
                  <input value={form.dgi_number} onChange={e => setForm(p => ({ ...p, dgi_number: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">RCCM</label>
                  <input value={form.rccm} onChange={e => setForm(p => ({ ...p, rccm: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Taux AT CNPS (0.02 = 2%)</label>
                  <input value={form.at_rate} onChange={e => setForm(p => ({ ...p, at_rate: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none font-mono" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium text-muted-foreground">Convention collective applicable</label>
                  <input value={form.collective_agreement} onChange={e => setForm(p => ({ ...p, collective_agreement: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                    placeholder="Ex: Convention Transport Urbain CI" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium text-muted-foreground">Adresse</label>
                  <input value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 flex gap-2 justify-end border-t border-border bg-card px-5 py-3 rounded-b-xl">
              <button onClick={() => setShowModal(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => save.mutate(form)} disabled={!form.name || save.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {save.isPending
                  ? (editingId ? 'Mise à jour...' : 'Création...')
                  : (editingId ? 'Enregistrer' : (hasSubsidiaries ? 'Créer la filiale' : 'Enregistrer'))}
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
  label: string
  description: string
  icon: React.ElementType
  color: string
  headers: string[]
  example: string[][]
  endpoint: string
}

const IMPORT_TEMPLATES: ImportTemplate[] = [
  {
    id: 'employees',
    label: 'Employés',
    description: 'État civil, poste, département, salaire — fichier principal',
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
    label: 'Départements',
    description: 'Structure organisationnelle et responsables',
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
    label: 'Historique absences',
    description: 'Absences passées et soldes de congés',
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
    label: 'Bulletins de paie',
    description: 'Bulletins historiques (net, cotisations CNPS, ITS)',
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
    label: 'Contrats OHADA',
    description: 'CDI, CDD, apprentissage avec clauses légales CI',
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
    label: 'Mobile Money',
    description: 'Numéros Wave / MTN / Orange par employé',
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
    label: 'Notes de frais',
    description: 'Historique des notes de frais et remboursements',
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

interface ValidationIssue {
  type: 'missing_col' | 'extra_col' | 'empty_file' | 'wrong_format' | 'row_error'
  message: string
  details?: string[]
}

function validateFile(file: File, template: ImportTemplate, text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { headers, rows } = parseCSV(text)

  if (!file.name.toLowerCase().endsWith('.csv')) {
    issues.push({ type: 'wrong_format', message: 'Format incorrect — seuls les fichiers .csv sont acceptés' })
    return issues
  }
  if (headers.length === 0 || rows.length === 0) {
    issues.push({ type: 'empty_file', message: 'Le fichier est vide ou ne contient pas de données' })
    return issues
  }

  const missing = template.headers.filter(h => !headers.includes(h))
  if (missing.length > 0) {
    issues.push({
      type: 'missing_col',
      message: `${missing.length} colonne${missing.length > 1 ? 's' : ''} manquante${missing.length > 1 ? 's' : ''}`,
      details: missing,
    })
  }

  const extra = headers.filter(h => !template.headers.includes(h))
  if (extra.length > 0) {
    issues.push({
      type: 'extra_col',
      message: `${extra.length} colonne${extra.length > 1 ? 's' : ''} inconnue${extra.length > 1 ? 's' : ''} (sera ignorée${extra.length > 1 ? 's' : ''})`,
      details: extra,
    })
  }

  return issues
}

function TemplateImportCard({ template, onSuccess }: { template: ImportTemplate; onSuccess: () => void }) {
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
      setServerError(e.response?.data?.error ?? 'Erreur lors de l\'import. Vérifiez les données.')
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
          <p className="font-semibold text-sm">{template.label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); downloadTemplate(template) }}
            title="Télécharger le modèle CSV"
            className="flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
          >
            <Download className="h-3 w-3" /> Modèle
          </button>
          <button
            onClick={() => { setOpen(o => !o); setFile(null); setIssues([]); setResult(null); setServerError(null) }}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              open ? 'bg-primary text-primary-foreground' : 'border border-border bg-background hover:bg-accent'
            }`}
          >
            <Upload className="h-3 w-3" /> Importer
          </button>
        </div>
      </div>

      {/* Zone d'import dépliable */}
      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          {/* Colonnes requises */}
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Colonnes requises ({template.headers.length})
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
                  <span className="text-xs text-muted-foreground">({(file.size / 1024).toFixed(1)} Ko)</span>
                  <button onClick={() => { setFile(null); setIssues([]); setServerError(null) }}
                    className="ml-1 text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="mx-auto h-6 w-6 text-muted-foreground mb-2" />
                  <p className="text-xs text-muted-foreground">Glissez le fichier CSV rempli ou</p>
                  <label className="mt-2 inline-block cursor-pointer rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
                    Parcourir
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
                  Fichier non conforme — import bloqué
                </p>
              </div>
              {blockingIssues.map((issue, i) => (
                <div key={i} className="pl-6">
                  <p className="text-xs text-red-700 font-medium">• {issue.message}</p>
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
                Téléchargez le modèle pour obtenir les colonnes exactes.
              </p>
            </div>
          )}

          {/* Avertissements non bloquants */}
          {warningIssues.length > 0 && blockingIssues.length === 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <p className="text-xs font-semibold text-amber-800">Avertissement — colonnes supplémentaires détectées</p>
              </div>
              {warningIssues.map((issue, i) => (
                <div key={i} className="pl-6">
                  <p className="text-xs text-amber-700">• {issue.message}</p>
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
                <p className="text-sm font-semibold text-green-800">Import réussi</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  { label: 'Total', value: result.total, cls: 'text-foreground' },
                  { label: 'Importées', value: result.inserted, cls: 'text-green-700' },
                  { label: 'Ignorées', value: result.skipped, cls: 'text-amber-700' },
                ].map(({ label, value, cls }) => (
                  <div key={label} className="rounded bg-white border border-green-100 py-2">
                    <p className={`text-lg font-bold ${cls}`}>{value}</p>
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
              {result.errors.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 max-h-28 overflow-auto">
                  <p className="text-[10px] font-semibold text-amber-800 mb-1">{result.errors.length} avertissement(s)</p>
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-[10px] text-amber-700">• {err}</p>
                  ))}
                </div>
              )}
              <button onClick={() => setResult(null)} className="text-xs text-green-700 underline hover:text-green-900">
                Importer un autre fichier
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
                ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" /> Import en cours...</>
                : <><Upload className="h-3.5 w-3.5" /> Valider et importer</>
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
      setGenError(e.response?.data?.error ?? 'Erreur lors de la génération')
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
          <p className="font-semibold text-blue-800 text-sm">Reprise de données historiques</p>
          <p className="text-xs text-blue-600 mt-0.5">
            Téléchargez le modèle CSV de chaque section, renseignez-le avec vos données, puis uploadez-le directement sur la carte.
            Les colonnes en rouge indiquent une non-conformité bloquante. L'import est incrémental — les doublons sont ignorés.
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
              <h2 className="font-semibold">Générer les accès utilisateurs</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Crée un compte + envoie un email avec mot de passe temporaire pour chaque employé sans accès
              </p>
            </div>
          </div>
          {status && (
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold text-primary">{status.withoutAccount}</p>
              <p className="text-xs text-muted-foreground">sans compte</p>
            </div>
          )}
        </div>

        {status && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Employés actifs', value: status.totalEmployees, color: 'text-foreground' },
              { label: 'Avec accès', value: status.withAccount, color: 'text-green-600' },
              { label: 'Sans accès', value: status.withoutAccount, color: status.withoutAccount > 0 ? 'text-amber-600' : 'text-muted-foreground' },
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
                {genResult.message ?? `${genResult.created} compte(s) créé(s) sur ${genResult.total} employés`}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div><p className="font-bold text-green-700">{genResult.created}</p><p className="text-muted-foreground">Créés</p></div>
              <div><p className="font-bold text-blue-700">{genResult.emailSent}</p><p className="text-muted-foreground">Emails envoyés</p></div>
              <div><p className="font-bold text-amber-700">{genResult.emailFailed}</p><p className="text-muted-foreground">Emails échoués</p></div>
            </div>
            {genResult.emailFailed > 0 && genResult.emailError && (
              <div className="rounded bg-amber-100 border border-amber-200 px-3 py-2 text-xs text-amber-800 font-mono break-all">
                Erreur SMTP : {genResult.emailError}
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
            ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />Génération en cours...</>
            : <><Mail className="h-4 w-4" />Générer les accès + envoyer les emails</>
          }
        </button>
        {(status?.withoutAccount ?? 0) === 0 && !generating && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Tous les employés actifs ont déjà un compte.
          </p>
        )}
      </div>

      {/* Grille des templates avec upload intégré */}
      <div>
        <h2 className="font-semibold mb-1">Modules de reprise de données</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Cliquez sur <strong>Importer</strong> pour déplier la zone d'upload de chaque section.
          Téléchargez d'abord le <strong>Modèle</strong>, remplissez-le, puis uploadez-le.
        </p>
        <div className="space-y-2">
          {IMPORT_TEMPLATES.map(t => (
            <TemplateImportCard
              key={t.id}
              template={t}
              onSuccess={() => { setHasImported(true); void refetchStatus() }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Tab: Workflow ─────────────────────────────────────────────────────────────
const LEVEL_NAMES = ['Manager direct', 'DRH / RH Manager', 'Comptabilité', 'Direction Générale', 'PDG / Gérant']

const MODULE_META: Record<string, { label: string; desc: string; icon: React.ElementType; color: string }> = {
  absences: {
    label: 'Absences',
    desc:  'Approbation des demandes d\'absence',
    icon:  CalendarDays,
    color: 'bg-orange-100 text-orange-600',
  },
  expenses: {
    label: 'Notes de frais',
    desc:  'Validation des notes de frais',
    icon:  Receipt,
    color: 'bg-rose-100 text-rose-600',
  },
  payroll: {
    label: 'Clôture de paie',
    desc:  'Validation avant virement Mobile Money',
    icon:  Banknote,
    color: 'bg-green-100 text-green-600',
  },
}

function WorkflowTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
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
          <h2 className="font-semibold">Workflow d'approbation — Niveaux paramétrables</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Définissez jusqu'à 5 niveaux hiérarchiques par module. Chaque niveau correspond à un approbateur supplémentaire avant finalisation.
          </p>
        </div>

        {allModules.map(module => {
          const meta = MODULE_META[module]!
          const current = localConfigs[module] ?? configMap[module]?.levels_count ?? 1
          return (
            <div key={module} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${meta.color}`}>
                  <meta.icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{meta.label}</p>
                  <p className="text-xs text-muted-foreground">{meta.desc}</p>
                </div>
                <span className="ml-auto rounded-full bg-primary/10 text-primary text-xs font-bold px-2 py-0.5">
                  {current} niveau{current > 1 ? 'x' : ''}
                </span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n}
                    onClick={() => setLocalConfigs(p => ({ ...p, [module]: n }))}
                    title={LEVEL_NAMES.slice(0, n).join(' → ')}
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
                Chaîne : {LEVEL_NAMES.slice(0, current).join(' → ')}
              </p>
            </div>
          )
        })}

        <div className="flex items-center gap-3">
          <button onClick={() => save.mutate()}
            disabled={save.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {save.isPending ? 'Sauvegarde...' : 'Sauvegarder le workflow'}
          </button>
          {save.isSuccess && <span className="text-xs text-green-600">✓ Workflow mis à jour</span>}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 space-y-3">
        <h2 className="font-semibold">Constantes légales CI 2024</h2>
        <p className="text-xs text-muted-foreground">Mis à jour automatiquement via le Store de Lois de la plateforme.</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['SMIG mensuel', '75 000 FCFA (2026)'],
            ['Congés / mois travaillé', '2,5 jours ouvrables'],
            ['CNPS retraite (salarié)', '6,3 %'],
            ['CNPS retraite (patronal)', '7,7 %'],
            ['Plafond retraite / mois', '1 647 315 FCFA'],
            ['Plafond AT/PF / mois', '70 000 FCFA'],
            ['ITS — Abattement forfaitaire', '15 % du brut'],
            ['Contribution FDFP', '0,4 % masse salariale'],
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
