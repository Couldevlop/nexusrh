import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { Users, Search, Trash2, AlertTriangle, X, ExternalLink, Plus, Loader2, Rocket } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'

interface Employee {
  id: string; first_name: string; last_name: string; email: string
  job_title: string; department_name: string; base_salary: string
  mobile_money_provider: string; mobile_money_phone: string
  contract_type: string; hire_date: string; is_active: boolean
  cnps_number: string; nni: string
}

interface PendingAction { type: string; label: string; path: string; count: number }
interface CheckDeleteResult { canDelete: boolean; pendingActions: PendingAction[] }

const PROVIDER_LABEL: Record<string, string> = {
  wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
}

// Catégories professionnelles usuelles (convention collective interprofessionnelle CI).
// Saisie libre possible (datalist) : chaque CCN sectorielle a sa grille.
const CATEGORIES_CI = [
  '1ère catégorie', '2ème catégorie', '3ème catégorie', '4ème catégorie',
  '5ème catégorie', '6ème catégorie',
  'Agent de maîtrise (AM1)', 'Agent de maîtrise (AM2)', 'Agent de maîtrise (AM3)',
  'Cadre (C1)', 'Cadre (C2)', 'Cadre (C3)', 'Hors catégorie',
]

interface Department { id: string; name: string }

function CreateEmployeeModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (fullName: string) => void
}) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', gender: '',
    birthDate: '', nni: '', cnpsNumber: '',
    departmentId: '', jobTitle: '', jobLevel: '', professionalCategory: '',
    contractType: 'cdi', hireDate: new Date().toISOString().slice(0, 10),
    baseSalary: '', weeklyHours: '40',
    mobileMoneyProvider: '', mobileMoneyPhone: '',
    iban: '', bankName: '',
    city: 'Abidjan', maritalStatus: '', childrenCount: '0',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: deptData } = useQuery<{ data: Department[] }>({
    queryKey: ['departments'],
    queryFn: () => api.get('/employees/departments').then(r => r.data).catch(() => ({ data: [] })),
  })
  const departments = deptData?.data ?? []

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value })

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'
  const labelCls = 'block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const salary = parseInt(form.baseSalary, 10)
    if (!Number.isFinite(salary) || salary < 75000) {
      setError('Le salaire brut doit être ≥ 75 000 FCFA (SMIG).')
      return
    }
    setSaving(true)
    try {
      await api.post('/employees', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        ...(form.email ? { email: form.email.trim() } : {}),
        ...(form.phone ? { phone: form.phone.trim() } : {}),
        ...(form.gender ? { gender: form.gender } : {}),
        ...(form.birthDate ? { birthDate: form.birthDate } : {}),
        ...(form.nni ? { nni: form.nni.trim() } : {}),
        ...(form.cnpsNumber ? { cnpsNumber: form.cnpsNumber.trim() } : {}),
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        ...(form.jobTitle ? { jobTitle: form.jobTitle.trim() } : {}),
        ...(form.jobLevel ? { jobLevel: form.jobLevel } : {}),
        ...(form.professionalCategory ? { professionalCategory: form.professionalCategory.trim() } : {}),
        contractType: form.contractType,
        ...(form.hireDate ? { hireDate: form.hireDate } : {}),
        baseSalary: salary,
        weeklyHours: parseFloat(form.weeklyHours) || 40,
        ...(form.mobileMoneyProvider ? { mobileMoneyProvider: form.mobileMoneyProvider } : {}),
        ...(form.mobileMoneyPhone ? { mobileMoneyPhone: form.mobileMoneyPhone.trim() } : {}),
        ...(form.iban ? { iban: form.iban.replace(/\s+/g, '') } : {}),
        ...(form.bankName ? { bankName: form.bankName.trim() } : {}),
        city: form.city || 'Abidjan',
        ...(form.maritalStatus ? { maritalStatus: form.maritalStatus } : {}),
        childrenCount: parseInt(form.childrenCount, 10) || 0,
      })
      onCreated(`${form.firstName} ${form.lastName}`)
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; details?: Array<{ path: string; message: string }> } } }
      const details = ax.response?.data?.details?.map(d => `${d.path}: ${d.message}`).join(' · ')
      setError(details || ax.response?.data?.error || 'Erreur lors de la création')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <form onSubmit={submit}
        className="w-full max-w-3xl my-8 rounded-xl bg-background border border-border shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="font-semibold text-sm flex items-center gap-2">
            <Plus className="h-4 w-4 text-primary" /> Nouvel employé
          </span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Identité */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">Identité</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>Prénom *</label>
                <input className={inputCls} value={form.firstName} onChange={set('firstName')} required maxLength={100} /></div>
              <div><label className={labelCls}>Nom *</label>
                <input className={inputCls} value={form.lastName} onChange={set('lastName')} required maxLength={100} /></div>
              <div><label className={labelCls}>Sexe</label>
                <select className={inputCls} value={form.gender} onChange={set('gender')}>
                  <option value="">—</option><option value="M">Masculin</option>
                  <option value="F">Féminin</option><option value="X">Autre</option>
                </select></div>
              <div><label className={labelCls}>Email</label>
                <input type="email" className={inputCls} value={form.email} onChange={set('email')} maxLength={255} /></div>
              <div><label className={labelCls}>Téléphone</label>
                <input className={inputCls} value={form.phone} onChange={set('phone')} placeholder="+225 07 XX XX XX XX" maxLength={30} /></div>
              <div><label className={labelCls}>Date de naissance</label>
                <input type="date" className={inputCls} value={form.birthDate} onChange={set('birthDate')} /></div>
              <div><label className={labelCls}>NNI (chiffré)</label>
                <input className={inputCls} value={form.nni} onChange={set('nni')} maxLength={50} /></div>
              <div><label className={labelCls}>N° CNPS</label>
                <input className={inputCls} value={form.cnpsNumber} onChange={set('cnpsNumber')} maxLength={30} /></div>
              <div><label className={labelCls}>Ville</label>
                <input className={inputCls} value={form.city} onChange={set('city')} maxLength={100} /></div>
            </div>
          </fieldset>

          {/* Poste & contrat */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">Poste & contrat</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>Intitulé du poste</label>
                <input className={inputCls} value={form.jobTitle} onChange={set('jobTitle')} maxLength={200} /></div>
              <div><label className={labelCls}>Département</label>
                <select className={inputCls} value={form.departmentId} onChange={set('departmentId')}>
                  <option value="">—</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select></div>
              <div><label className={labelCls}>Séniorité</label>
                <select className={inputCls} value={form.jobLevel} onChange={set('jobLevel')}>
                  <option value="">—</option><option value="junior">Junior</option>
                  <option value="confirme">Confirmé</option><option value="senior">Senior</option>
                  <option value="cadre">Cadre</option><option value="direction">Direction</option>
                </select></div>
              <div><label className={labelCls}>Catégorie professionnelle</label>
                <input className={inputCls} list="categories-ci" value={form.professionalCategory}
                  onChange={set('professionalCategory')} maxLength={50} placeholder="ex. 3ème catégorie" />
                <datalist id="categories-ci">
                  {CATEGORIES_CI.map(c => <option key={c} value={c} />)}
                </datalist></div>
              <div><label className={labelCls}>Type de contrat</label>
                <select className={inputCls} value={form.contractType} onChange={set('contractType')}>
                  <option value="cdi">CDI</option><option value="cdd">CDD</option>
                  <option value="saisonnier">Saisonnier</option><option value="apprentissage">Apprentissage</option>
                  <option value="stage">Stage</option><option value="mise_a_disposition">Mise à disposition</option>
                </select></div>
              <div><label className={labelCls}>Date d'embauche</label>
                <input type="date" className={inputCls} value={form.hireDate} onChange={set('hireDate')} /></div>
              <div><label className={labelCls}>Heures hebdomadaires *</label>
                <input type="number" min={1} max={60} step={0.5} className={inputCls}
                  value={form.weeklyHours} onChange={set('weeklyHours')} required /></div>
            </div>
          </fieldset>

          {/* Rémunération & paiement */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">Rémunération & paiement</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>Salaire brut mensuel (FCFA) *</label>
                <input type="number" min={75000} step={1} className={inputCls}
                  value={form.baseSalary} onChange={set('baseSalary')} required placeholder="≥ 75 000" /></div>
              <div><label className={labelCls}>Opérateur Mobile Money</label>
                <select className={inputCls} value={form.mobileMoneyProvider} onChange={set('mobileMoneyProvider')}>
                  <option value="">—</option><option value="wave">Wave</option>
                  <option value="mtn">MTN MoMo</option><option value="orange">Orange Money</option>
                  <option value="cofina">COFINA</option>
                </select></div>
              <div><label className={labelCls}>N° Mobile Money</label>
                <input className={inputCls} value={form.mobileMoneyPhone} onChange={set('mobileMoneyPhone')}
                  placeholder="+2250XXXXXXXXX" maxLength={30} /></div>
              <div className="sm:col-span-2"><label className={labelCls}>RIB / IBAN (chiffré AES-256)</label>
                <input className={inputCls} value={form.iban} onChange={set('iban')}
                  placeholder="CIxx xxxx xxxx xxxx xxxx xxxx xxxx" maxLength={50} /></div>
              <div><label className={labelCls}>Banque</label>
                <input className={inputCls} value={form.bankName} onChange={set('bankName')} maxLength={100} /></div>
            </div>
          </fieldset>

          {/* Situation familiale (crédit d'impôt ITS) */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">Situation familiale <span className="font-normal text-xs text-muted-foreground">(impacte le crédit d'impôt ITS)</span></legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>Statut marital</label>
                <select className={inputCls} value={form.maritalStatus} onChange={set('maritalStatus')}>
                  <option value="">—</option><option value="single">Célibataire</option>
                  <option value="married">Marié(e)</option><option value="divorced">Divorcé(e)</option>
                  <option value="widowed">Veuf/Veuve</option><option value="cohabiting">Concubinage</option>
                </select></div>
              <div><label className={labelCls}>Enfants à charge</label>
                <input type="number" min={0} max={30} className={inputCls}
                  value={form.childrenCount} onChange={set('childrenCount')} /></div>
            </div>
          </fieldset>

          <div className="flex items-start gap-2 rounded-lg bg-indigo-50 border border-indigo-100 p-3">
            <Rocket className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
            <p className="text-xs text-indigo-800">
              Un <strong>parcours d'intégration</strong> sera créé automatiquement selon la séniorité
              et le poste (modèles configurés dans Intégration → Modèles).
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted">
            Annuler
          </button>
          <button type="submit" disabled={saving || !form.firstName.trim() || !form.lastName.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Créer l'employé
          </button>
        </div>
      </form>
    </div>
  )
}

function DeleteModal({
  employee, onClose, onDeleted,
}: { employee: Employee; onClose: () => void; onDeleted: () => void }) {
  const navigate = useNavigate()
  const [check, setCheck] = useState<CheckDeleteResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<CheckDeleteResult>(`/employees/${employee.id}/check-delete`)
      .then(r => setCheck(r.data))
      .catch(() => setCheck({ canDelete: true, pendingActions: [] }))
      .finally(() => setLoading(false))
  }, [employee.id])

  const doDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      await api.delete(`/employees/${employee.id}`)
      onDeleted()
    } catch {
      setError('Erreur lors de la suppression. Réessayez.')
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-background border border-border shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <span className="font-semibold text-sm">Archiver l'employé</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <p className="text-sm">
            Vous allez archiver <strong>{employee.first_name} {employee.last_name}</strong>.
            L'employé ne sera plus actif mais ses données seront conservées.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Vérification des actions en attente...
            </div>
          )}

          {!loading && check && !check.canDelete && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
              <p className="font-medium text-amber-800 text-sm flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                Actions en attente sur cet employé
              </p>
              <ul className="space-y-2">
                {check.pendingActions.map(a => (
                  <li key={a.type} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-amber-700">{a.label}</span>
                    <button
                      onClick={() => { onClose(); navigate(a.path) }}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:underline shrink-0"
                    >
                      Voir <ExternalLink className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-amber-600 border-t border-amber-200 pt-2">
                Clôturez ces actions avant d'archiver, ou forcez la suppression ci-dessous.
              </p>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted">
            Annuler
          </button>
          {!loading && check && !check.canDelete && (
            <button
              onClick={doDelete}
              disabled={deleting}
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
            >
              {deleting ? 'Archivage...' : 'Forcer l\'archivage'}
            </button>
          )}
          {!loading && check?.canDelete && (
            <button
              onClick={doDelete}
              disabled={deleting}
              className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? 'Archivage...' : 'Confirmer l\'archivage'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function EmployeesPage() {
  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createdMsg, setCreatedMsg] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canCreate = ['admin', 'hr_manager', 'hr_officer'].includes(role)

  const { data, isLoading } = useQuery<{ data: Employee[]; total: number }>({
    queryKey: ['employees', search],
    queryFn: () => api.get(`/employees?search=${encodeURIComponent(search)}`).then(r => r.data),
  })

  const employees = data?.data ?? []

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Employés</h1>
          <p className="text-sm text-muted-foreground mt-1">{data?.total ?? 0} employé(s) actif(s)</p>
        </div>
        {canCreate && (
          <button onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> Nouvel employé
          </button>
        )}
      </div>

      {createdMsg && (
        <div className="flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
          <Rocket className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
          <p className="text-sm text-emerald-800">
            <strong>{createdMsg}</strong> créé(e). Son parcours d'intégration démarre automatiquement
            (visible dans l'onglet Intégration).
          </p>
          <button onClick={() => setCreatedMsg(null)} className="ml-auto text-emerald-700 hover:text-emerald-900">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher un employé..."
          className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                  <th className="p-4">Employé</th>
                  <th className="p-4">Poste & Département</th>
                  <th className="p-4 text-right">Salaire brut</th>
                  <th className="p-4">Mobile Money</th>
                  <th className="p-4">Contrat</th>
                  <th className="p-4">Date d'embauche</th>
                  <th className="p-4 w-12" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {employees.map(emp => (
                  <tr key={emp.id} className="hover:bg-muted/30">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                          {emp.first_name?.[0]}{emp.last_name?.[0]}
                        </div>
                        <div>
                          <p className="font-medium">{emp.first_name} {emp.last_name}</p>
                          <p className="text-xs text-muted-foreground">{emp.email ?? '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <p>{emp.job_title ?? '—'}</p>
                      <p className="text-xs text-muted-foreground">{emp.department_name ?? '—'}</p>
                    </td>
                    <td className="p-4 text-right font-mono text-sm">
                      {formatFCFA(parseInt(emp.base_salary ?? '0'))}
                    </td>
                    <td className="p-4">
                      {emp.mobile_money_provider ? (
                        <div>
                          <p className="text-xs font-medium">{PROVIDER_LABEL[emp.mobile_money_provider] ?? emp.mobile_money_provider}</p>
                          <p className="text-xs text-muted-foreground font-mono">{emp.mobile_money_phone}</p>
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="p-4">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs uppercase font-medium">
                        {emp.contract_type ?? '—'}
                      </span>
                    </td>
                    <td className="p-4 text-muted-foreground">
                      {emp.hire_date ? formatDate(emp.hire_date) : '—'}
                    </td>
                    <td className="p-4">
                      <button
                        onClick={() => setDeleteTarget(emp)}
                        title="Archiver l'employé"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {employees.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-muted-foreground">
                      <Users className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      <p>Aucun employé trouvé</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete modal */}
      {deleteTarget && (
        <DeleteModal
          employee={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null)
            void queryClient.invalidateQueries({ queryKey: ['employees'] })
          }}
        />
      )}

      {/* Création */}
      {showCreate && (
        <CreateEmployeeModal
          onClose={() => setShowCreate(false)}
          onCreated={(fullName) => {
            setShowCreate(false)
            setCreatedMsg(fullName)
            void queryClient.invalidateQueries({ queryKey: ['employees'] })
            void queryClient.invalidateQueries({ queryKey: ['onboarding-journeys'] })
          }}
        />
      )}
    </div>
  )
}
