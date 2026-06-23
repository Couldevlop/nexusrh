import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { Users, Search, Trash2, AlertTriangle, X, ExternalLink, Plus, Loader2, Rocket, Pencil, Download, Upload } from 'lucide-react'
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
  const { t } = useTranslation('employees')
  const { t: tContracts } = useTranslation('contracts')
  const { t: tCommon } = useTranslation('common')

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
      setError(t('form.errors.salaryBelowSmig'))
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
      setError(details || ax.response?.data?.error || t('form.errors.createGeneric'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <form onSubmit={submit}
        className="w-full max-w-3xl my-8 rounded-xl bg-background border border-border shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="font-semibold text-sm flex items-center gap-2">
            <Plus className="h-4 w-4 text-primary" /> {t('form.title')}
          </span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Identité */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">{t('form.sections.identity')}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>{t('form.fields.firstName')}</label>
                <input className={inputCls} value={form.firstName} onChange={set('firstName')} required maxLength={100} /></div>
              <div><label className={labelCls}>{t('form.fields.lastName')}</label>
                <input className={inputCls} value={form.lastName} onChange={set('lastName')} required maxLength={100} /></div>
              <div><label className={labelCls}>{t('form.fields.gender')}</label>
                <select className={inputCls} value={form.gender} onChange={set('gender')}>
                  <option value="">—</option><option value="M">{t('form.gender.male')}</option>
                  <option value="F">{t('form.gender.female')}</option><option value="X">{t('form.gender.other')}</option>
                </select></div>
              <div><label className={labelCls}>{t('form.fields.email')}</label>
                <input type="email" className={inputCls} value={form.email} onChange={set('email')} maxLength={255} /></div>
              <div><label className={labelCls}>{t('form.fields.phone')}</label>
                <input className={inputCls} value={form.phone} onChange={set('phone')} placeholder={t('form.placeholders.phone')} maxLength={30} /></div>
              <div><label className={labelCls}>{t('form.fields.birthDate')}</label>
                <input type="date" className={inputCls} value={form.birthDate} onChange={set('birthDate')} /></div>
              <div><label className={labelCls}>{t('form.fields.nni')}</label>
                <input className={inputCls} value={form.nni} onChange={set('nni')} maxLength={50} /></div>
              <div><label className={labelCls}>{t('form.fields.cnpsNumber')}</label>
                <input className={inputCls} value={form.cnpsNumber} onChange={set('cnpsNumber')} maxLength={30} /></div>
              <div><label className={labelCls}>{t('form.fields.city')}</label>
                <input className={inputCls} value={form.city} onChange={set('city')} maxLength={100} /></div>
            </div>
          </fieldset>

          {/* Poste & contrat */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">{t('form.sections.jobAndContract')}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>{t('form.fields.jobTitle')}</label>
                <input className={inputCls} value={form.jobTitle} onChange={set('jobTitle')} maxLength={200} /></div>
              <div><label className={labelCls}>{t('form.fields.department')}</label>
                <select className={inputCls} value={form.departmentId} onChange={set('departmentId')}>
                  <option value="">—</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select></div>
              <div><label className={labelCls}>{t('form.fields.seniority')}</label>
                <select className={inputCls} value={form.jobLevel} onChange={set('jobLevel')}>
                  <option value="">—</option><option value="junior">{t('form.seniorityOptions.junior')}</option>
                  <option value="confirme">{t('form.seniorityOptions.confirme')}</option><option value="senior">{t('form.seniorityOptions.senior')}</option>
                  <option value="cadre">{t('form.seniorityOptions.cadre')}</option><option value="direction">{t('form.seniorityOptions.direction')}</option>
                </select></div>
              <div><label className={labelCls}>{t('form.fields.professionalCategory')}</label>
                <input className={inputCls} list="categories-ci" value={form.professionalCategory}
                  onChange={set('professionalCategory')} maxLength={50} placeholder={t('form.placeholders.professionalCategory')} />
                <datalist id="categories-ci">
                  {CATEGORIES_CI.map(c => <option key={c} value={c} />)}
                </datalist></div>
              <div><label className={labelCls}>{t('form.fields.contractType')}</label>
                <select className={inputCls} value={form.contractType} onChange={set('contractType')}>
                  <option value="cdi">CDI</option><option value="cdd">CDD</option>
                  <option value="saisonnier">{tContracts('types.saisonnier')}</option><option value="apprentissage">{tContracts('types.apprentissage')}</option>
                  <option value="stage">{tContracts('types.stage')}</option><option value="mise_a_disposition">{tContracts('types.mise_a_disposition')}</option>
                </select></div>
              <div><label className={labelCls}>{t('form.fields.hireDate')}</label>
                <input type="date" className={inputCls} value={form.hireDate} onChange={set('hireDate')} /></div>
              <div><label className={labelCls}>{t('form.fields.weeklyHours')}</label>
                <input type="number" min={1} max={60} step={0.5} className={inputCls}
                  value={form.weeklyHours} onChange={set('weeklyHours')} required /></div>
            </div>
          </fieldset>

          {/* Rémunération & paiement */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">{t('form.sections.compensationAndPayment')}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>{t('form.fields.baseSalary')}</label>
                <input type="number" min={75000} step={1} className={inputCls}
                  value={form.baseSalary} onChange={set('baseSalary')} required placeholder={t('form.placeholders.baseSalary')} /></div>
              <div><label className={labelCls}>{t('form.fields.mobileMoneyProvider')}</label>
                <select className={inputCls} value={form.mobileMoneyProvider} onChange={set('mobileMoneyProvider')}>
                  <option value="">—</option><option value="wave">{t('form.providers.wave')}</option>
                  <option value="mtn">{t('form.providers.mtn')}</option><option value="orange">{t('form.providers.orange')}</option>
                  <option value="cofina">{t('form.providers.cofina')}</option>
                </select></div>
              <div><label className={labelCls}>{t('form.fields.mobileMoneyPhone')}</label>
                <input className={inputCls} value={form.mobileMoneyPhone} onChange={set('mobileMoneyPhone')}
                  placeholder={t('form.placeholders.mobileMoneyPhone')} maxLength={30} /></div>
              <div className="sm:col-span-2"><label className={labelCls}>{t('form.fields.iban')}</label>
                <input className={inputCls} value={form.iban} onChange={set('iban')}
                  placeholder={t('form.placeholders.iban')} maxLength={50} /></div>
              <div><label className={labelCls}>{t('form.fields.bankName')}</label>
                <input className={inputCls} value={form.bankName} onChange={set('bankName')} maxLength={100} /></div>
            </div>
          </fieldset>

          {/* Situation familiale (crédit d'impôt ITS) */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold mb-1">{t('form.sections.familySituation')} <span className="font-normal text-xs text-muted-foreground">{t('form.sections.familySituationHint')}</span></legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div><label className={labelCls}>{t('form.fields.maritalStatus')}</label>
                <select className={inputCls} value={form.maritalStatus} onChange={set('maritalStatus')}>
                  <option value="">—</option><option value="single">{t('form.maritalOptions.single')}</option>
                  <option value="married">{t('form.maritalOptions.married')}</option><option value="divorced">{t('form.maritalOptions.divorced')}</option>
                  <option value="widowed">{t('form.maritalOptions.widowed')}</option><option value="cohabiting">{t('form.maritalOptions.cohabiting')}</option>
                </select></div>
              <div><label className={labelCls}>{t('form.fields.childrenCount')}</label>
                <input type="number" min={0} max={30} className={inputCls}
                  value={form.childrenCount} onChange={set('childrenCount')} /></div>
            </div>
          </fieldset>

          <div className="flex items-start gap-2 rounded-lg bg-indigo-50 border border-indigo-100 p-3">
            <Rocket className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
            <p className="text-xs text-indigo-800">
              <Trans t={t} i18nKey="form.onboardingHint" components={{ strong: <strong /> }} />
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted">
            {tCommon('actions.cancel')}
          </button>
          <button type="submit" disabled={saving || !form.firstName.trim() || !form.lastName.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {saving ? t('form.submitting') : t('form.submit')}
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
  const { t } = useTranslation('employees')
  const { t: tCommon } = useTranslation('common')
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
      setError(t('delete.error'))
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
            <span className="font-semibold text-sm">{t('delete.title')}</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <p className="text-sm">
            <Trans t={t} i18nKey="delete.intro"
              values={{ name: `${employee.first_name} ${employee.last_name}` }}
              components={{ strong: <strong /> }} />
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              {t('delete.checkingPending')}
            </div>
          )}

          {!loading && check && !check.canDelete && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
              <p className="font-medium text-amber-800 text-sm flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                {t('delete.pendingTitle')}
              </p>
              <ul className="space-y-2">
                {check.pendingActions.map(a => (
                  <li key={a.type} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-amber-700">{a.label}</span>
                    <button
                      onClick={() => { onClose(); navigate(a.path) }}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:underline shrink-0"
                    >
                      {tCommon('actions.view')} <ExternalLink className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-amber-600 border-t border-amber-200 pt-2">
                {t('delete.pendingHint')}
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
            {tCommon('actions.cancel')}
          </button>
          {!loading && check && !check.canDelete && (
            <button
              onClick={doDelete}
              disabled={deleting}
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
            >
              {deleting ? t('delete.forcing') : t('delete.forceArchive')}
            </button>
          )}
          {!loading && check?.canDelete && (
            <button
              onClick={doDelete}
              disabled={deleting}
              className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? t('delete.archiving') : t('delete.confirmArchive')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Modal d'édition d'un employé (rôles RH) ────────────────────────────────────
// Comble le manque historique : la page ne permettait QUE créer/archiver, jamais
// de modifier un dossier existant (d'où « on n'arrive pas à modifier un employé »).
// Permet notamment d'AJOUTER un numéro CNPS a posteriori (cas du salarié à son
// premier emploi, embauché sans numéro).
interface EmployeeDetail {
  id: string; first_name: string; last_name: string; email: string | null
  phone: string | null; gender: string | null; nni: string | null; cnps_number: string | null
  city: string | null; department_id: string | null; job_title: string | null
  job_level: string | null; professional_category: string | null
  contract_type: string | null; hire_date: string | null; weekly_hours: string | null
  base_salary: string | null; mobile_money_provider: string | null; mobile_money_phone: string | null
  iban: string | null; bank_name: string | null
  marital_status: string | null; children_count: number | null
}

function EditEmployeeModal({ employeeId, onClose, onSaved }: {
  employeeId: string; onClose: () => void; onSaved: () => void
}) {
  const { t } = useTranslation('employees')
  const { t: tContracts } = useTranslation('contracts')
  const { t: tCommon } = useTranslation('common')
  const [form, setForm] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const { data: detail, isLoading } = useQuery<{ data: EmployeeDetail }>({
    queryKey: ['employee-detail', employeeId],
    queryFn: () => api.get(`/employees/${employeeId}`).then(r => r.data),
  })
  const { data: deptData } = useQuery<{ data: Department[] }>({
    queryKey: ['departments'],
    queryFn: () => api.get('/employees/departments').then(r => r.data).catch(() => ({ data: [] })),
  })
  const departments = deptData?.data ?? []
  const emp = detail?.data

  // Valeur effective d'un champ : saisie en cours sinon valeur d'origine.
  const val = (k: string, orig: string | number | null | undefined) =>
    form[k] ?? (orig == null ? '' : String(orig))
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }))

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'
  const labelCls = 'block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!emp) return
    setError(null)
    // On n'envoie QUE les champs réellement modifiés (PATCH partiel).
    const orig: Record<string, string> = {
      firstName: emp.first_name ?? '', lastName: emp.last_name ?? '', email: emp.email ?? '',
      phone: emp.phone ?? '', gender: emp.gender ?? '', nni: emp.nni ?? '', cnpsNumber: emp.cnps_number ?? '',
      city: emp.city ?? '', departmentId: emp.department_id ?? '', jobTitle: emp.job_title ?? '',
      jobLevel: emp.job_level ?? '', professionalCategory: emp.professional_category ?? '',
      contractType: emp.contract_type ?? '', hireDate: (emp.hire_date ?? '').slice(0, 10),
      weeklyHours: emp.weekly_hours ?? '', baseSalary: emp.base_salary ?? '',
      mobileMoneyProvider: emp.mobile_money_provider ?? '', mobileMoneyPhone: emp.mobile_money_phone ?? '',
      iban: emp.iban ?? '', bankName: emp.bank_name ?? '',
      maritalStatus: emp.marital_status ?? '', childrenCount: String(emp.children_count ?? 0),
    }
    const numericKeys = new Set(['baseSalary', 'weeklyHours', 'childrenCount'])
    const payload: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(form)) {
      const trimmed = typeof v === 'string' ? v.trim() : v
      if (trimmed === orig[k]) continue
      if (trimmed === '') continue // champ vidé : on ne pousse pas (évite d'écraser involontairement)
      payload[k] = numericKeys.has(k) ? Number(trimmed) : trimmed
    }
    if (Object.keys(payload).length === 0) { onClose(); return }
    if (payload.baseSalary != null && Number(payload.baseSalary) < 75000) {
      setError(t('form.errors.salaryBelowSmig')); return
    }
    setSaving(true)
    try {
      await api.patch(`/employees/${employeeId}`, payload)
      onSaved()
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; details?: Array<{ path: string; message: string }> } } }
      const details = ax.response?.data?.details?.map(d => `${d.path}: ${d.message}`).join(' · ')
      setError(details || ax.response?.data?.error || t('form.errors.createGeneric'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <form onSubmit={submit} className="w-full max-w-3xl my-8 rounded-xl bg-background border border-border shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="font-semibold text-sm flex items-center gap-2">
            <Pencil className="h-4 w-4 text-primary" /> {t('edit.title')}
          </span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading || !emp ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
            {/* Identité */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold mb-1">{t('form.sections.identity')}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className={labelCls}>{t('form.fields.firstName')}</label>
                  <input className={inputCls} value={val('firstName', emp.first_name)} onChange={set('firstName')} maxLength={100} /></div>
                <div><label className={labelCls}>{t('form.fields.lastName')}</label>
                  <input className={inputCls} value={val('lastName', emp.last_name)} onChange={set('lastName')} maxLength={100} /></div>
                <div><label className={labelCls}>{t('form.fields.email')}</label>
                  <input type="email" className={inputCls} value={val('email', emp.email)} onChange={set('email')} maxLength={255} /></div>
                <div><label className={labelCls}>{t('form.fields.phone')}</label>
                  <input className={inputCls} value={val('phone', emp.phone)} onChange={set('phone')} maxLength={30} /></div>
                <div><label className={labelCls}>{t('form.fields.nni')}</label>
                  <input className={inputCls} value={val('nni', emp.nni)} onChange={set('nni')} maxLength={50} /></div>
                <div><label className={labelCls}>{t('form.fields.cnpsNumber')}</label>
                  <input className={inputCls} value={val('cnpsNumber', emp.cnps_number)} onChange={set('cnpsNumber')} maxLength={30}
                    placeholder={t('edit.cnpsPlaceholder')} /></div>
                <div><label className={labelCls}>{t('form.fields.city')}</label>
                  <input className={inputCls} value={val('city', emp.city)} onChange={set('city')} maxLength={100} /></div>
              </div>
            </fieldset>

            {/* Poste & contrat */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold mb-1">{t('form.sections.jobAndContract')}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className={labelCls}>{t('form.fields.jobTitle')}</label>
                  <input className={inputCls} value={val('jobTitle', emp.job_title)} onChange={set('jobTitle')} maxLength={200} /></div>
                <div><label className={labelCls}>{t('form.fields.department')}</label>
                  <select className={inputCls} value={val('departmentId', emp.department_id)} onChange={set('departmentId')}>
                    <option value="">—</option>
                    {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select></div>
                <div><label className={labelCls}>{t('form.fields.seniority')}</label>
                  <select className={inputCls} value={val('jobLevel', emp.job_level)} onChange={set('jobLevel')}>
                    <option value="">—</option><option value="junior">{t('form.seniorityOptions.junior')}</option>
                    <option value="confirme">{t('form.seniorityOptions.confirme')}</option><option value="senior">{t('form.seniorityOptions.senior')}</option>
                    <option value="cadre">{t('form.seniorityOptions.cadre')}</option><option value="direction">{t('form.seniorityOptions.direction')}</option>
                  </select></div>
                <div><label className={labelCls}>{t('form.fields.professionalCategory')}</label>
                  <input className={inputCls} list="categories-ci-edit" value={val('professionalCategory', emp.professional_category)}
                    onChange={set('professionalCategory')} maxLength={50} />
                  <datalist id="categories-ci-edit">{CATEGORIES_CI.map(c => <option key={c} value={c} />)}</datalist></div>
                <div><label className={labelCls}>{t('form.fields.contractType')}</label>
                  <select className={inputCls} value={val('contractType', emp.contract_type)} onChange={set('contractType')}>
                    <option value="cdi">CDI</option><option value="cdd">CDD</option>
                    <option value="saisonnier">{tContracts('types.saisonnier')}</option><option value="apprentissage">{tContracts('types.apprentissage')}</option>
                    <option value="stage">{tContracts('types.stage')}</option><option value="mise_a_disposition">{tContracts('types.mise_a_disposition')}</option>
                  </select></div>
                <div><label className={labelCls}>{t('form.fields.hireDate')}</label>
                  <input type="date" className={inputCls} value={val('hireDate', (emp.hire_date ?? '').slice(0, 10))} onChange={set('hireDate')} /></div>
                <div><label className={labelCls}>{t('form.fields.weeklyHours')}</label>
                  <input type="number" min={1} max={60} step={0.5} className={inputCls} value={val('weeklyHours', emp.weekly_hours)} onChange={set('weeklyHours')} /></div>
              </div>
            </fieldset>

            {/* Rémunération & paiement */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold mb-1">{t('form.sections.compensationAndPayment')}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className={labelCls}>{t('form.fields.baseSalary')}</label>
                  <input type="number" min={75000} step={1} className={inputCls} value={val('baseSalary', emp.base_salary)} onChange={set('baseSalary')} /></div>
                <div><label className={labelCls}>{t('form.fields.mobileMoneyProvider')}</label>
                  <select className={inputCls} value={val('mobileMoneyProvider', emp.mobile_money_provider)} onChange={set('mobileMoneyProvider')}>
                    <option value="">—</option><option value="wave">{t('form.providers.wave')}</option>
                    <option value="mtn">{t('form.providers.mtn')}</option><option value="orange">{t('form.providers.orange')}</option>
                    <option value="cofina">{t('form.providers.cofina')}</option>
                  </select></div>
                <div><label className={labelCls}>{t('form.fields.mobileMoneyPhone')}</label>
                  <input className={inputCls} value={val('mobileMoneyPhone', emp.mobile_money_phone)} onChange={set('mobileMoneyPhone')} maxLength={30} /></div>
                <div className="sm:col-span-2"><label className={labelCls}>{t('form.fields.iban')}</label>
                  <input className={inputCls} value={val('iban', emp.iban)} onChange={set('iban')} maxLength={50} /></div>
                <div><label className={labelCls}>{t('form.fields.bankName')}</label>
                  <input className={inputCls} value={val('bankName', emp.bank_name)} onChange={set('bankName')} maxLength={100} /></div>
              </div>
            </fieldset>

            {/* Situation familiale */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold mb-1">{t('form.sections.familySituation')}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className={labelCls}>{t('form.fields.maritalStatus')}</label>
                  <select className={inputCls} value={val('maritalStatus', emp.marital_status)} onChange={set('maritalStatus')}>
                    <option value="">—</option><option value="single">{t('form.maritalOptions.single')}</option>
                    <option value="married">{t('form.maritalOptions.married')}</option><option value="divorced">{t('form.maritalOptions.divorced')}</option>
                    <option value="widowed">{t('form.maritalOptions.widowed')}</option><option value="cohabiting">{t('form.maritalOptions.cohabiting')}</option>
                  </select></div>
                <div><label className={labelCls}>{t('form.fields.childrenCount')}</label>
                  <input type="number" min={0} max={30} className={inputCls} value={val('childrenCount', emp.children_count)} onChange={set('childrenCount')} /></div>
              </div>
            </fieldset>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted">
            {tCommon('actions.cancel')}
          </button>
          <button type="submit" disabled={saving || isLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {saving ? t('form.submitting') : tCommon('actions.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

const PAGE_SIZE = 20

export default function EmployeesPage() {
  const [search, setSearch] = useState('')
  // EMP-006 — pagination ; EMP-008 — filtre par département.
  const [page, setPage] = useState(1)
  const [departmentId, setDepartmentId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null)
  const [editTarget, setEditTarget] = useState<Employee | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createdMsg, setCreatedMsg] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { t } = useTranslation('employees')
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canCreate = ['admin', 'hr_manager', 'hr_officer'].includes(role)

  const { data, isLoading } = useQuery<{ data: Employee[]; total: number; page?: number; limit?: number }>({
    queryKey: ['employees', search, departmentId, page],
    queryFn: () => api.get(
      `/employees?search=${encodeURIComponent(search)}${departmentId ? `&departmentId=${departmentId}` : ''}&page=${page}&limit=${PAGE_SIZE}`,
    ).then(r => r.data),
  })

  // Départements pour le filtre (EMP-008).
  const { data: deptData } = useQuery<{ data: Department[] }>({
    queryKey: ['departments'],
    queryFn: () => api.get('/employees/departments').then(r => r.data).catch(() => ({ data: [] })),
  })
  const departments = deptData?.data ?? []

  const employees = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const navigate = useNavigate()

  // EMP-014 — export CSV de la liste (téléchargement blob authentifié).
  async function handleExport() {
    const res = await api.get('/employees/export.csv', { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'employes.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('subtitle', { count: data?.total ?? 0 })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreate && (
            <>
              {/* EMP-014 — Export CSV */}
              <button onClick={() => void handleExport()}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-medium hover:bg-accent">
                <Download className="h-4 w-4" /> {t('export', 'Exporter')}
              </button>
              {/* EMP-013 — Import CSV (formulaire de reprise de données dans Paramètres) */}
              <button onClick={() => navigate('/settings?tab=data-import')}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-medium hover:bg-accent">
                <Upload className="h-4 w-4" /> {t('import', 'Importer')}
              </button>
            </>
          )}
          {canCreate && (
            <button onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
              <Plus className="h-4 w-4" /> {t('newEmployee')}
            </button>
          )}
        </div>
      </div>

      {createdMsg && (
        <div className="flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
          <Rocket className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
          <p className="text-sm text-emerald-800">
            <Trans t={t} i18nKey="created.message"
              values={{ name: createdMsg }}
              components={{ strong: <strong /> }} />
          </p>
          <button onClick={() => setCreatedMsg(null)} className="ml-auto text-emerald-700 hover:text-emerald-900">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Recherche + filtre département (EMP-007 / EMP-008) */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder={t('searchPlaceholder')}
            className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
          />
        </div>
        <select
          value={departmentId}
          onChange={e => { setDepartmentId(e.target.value); setPage(1) }}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
          <option value="">{t('filters.allDepartments', 'Tous les départements')}</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
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
                  <th className="p-4">{t('table.employee')}</th>
                  <th className="p-4">{t('table.jobAndDepartment')}</th>
                  <th className="p-4 text-right">{t('table.grossSalary')}</th>
                  <th className="p-4">{t('table.mobileMoney')}</th>
                  <th className="p-4">{t('table.contract')}</th>
                  <th className="p-4">{t('table.hireDate')}</th>
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
                      <div className="flex items-center justify-end gap-1">
                        {canCreate && (
                          <button
                            onClick={() => setEditTarget(emp)}
                            title={t('edit.title')}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          onClick={() => setDeleteTarget(emp)}
                          title={t('delete.title')}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {employees.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-muted-foreground">
                      <Users className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      <p>{t('noEmployeesFound')}</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* EMP-006 — pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40 hover:bg-muted">
              {t('pagination.prev', 'Précédent')}
            </button>
            <span className="px-1 text-muted-foreground">{page} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40 hover:bg-muted">
              {t('pagination.next', 'Suivant')}
            </button>
          </div>
        </div>
      )}

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

      {/* Édition */}
      {editTarget && (
        <EditEmployeeModal
          employeeId={editTarget.id}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null)
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
