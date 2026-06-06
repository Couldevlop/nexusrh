import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  FileText, Plus, Eye, CheckCircle, XCircle,
  RefreshCw, AlertTriangle, Building2, User,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Contract {
  id: string
  employee_id: string
  first_name: string
  last_name: string
  registration_number: string
  department_name: string | null
  type: 'cdi' | 'cdd' | 'saisonnier' | 'apprentissage' | 'stage' | 'mise_a_disposition'
  status: 'active' | 'terminated' | 'suspended' | 'expired'
  start_date: string
  end_date: string | null
  trial_end_date: string | null
  base_salary: number
  working_hours: number
  job_title: string | null
  job_level: string | null
  convention: string | null
  cnps_affiliation: boolean
  ohada_clause: boolean
  non_competition_clause: boolean
  telecommuting_days: number
  signature_status: string | null
  created_at: string
}

// ── Config ────────────────────────────────────────────────────────────────────
// Couleurs uniquement : les libellés sont résolus via i18n (types.<value> /
// statuses.<value> / typesLong.<value> / terminationReasons.<value>).
const TYPE_COLOR: Record<string, string> = {
  cdi:              'bg-green-100 text-green-700',
  cdd:              'bg-blue-100 text-blue-700',
  saisonnier:       'bg-yellow-100 text-yellow-700',
  apprentissage:    'bg-purple-100 text-purple-700',
  stage:            'bg-orange-100 text-orange-700',
  mise_a_disposition: 'bg-gray-100 text-gray-600',
}

const STATUS_COLOR: Record<string, string> = {
  active:     'bg-green-100 text-green-700',
  terminated: 'bg-red-100 text-red-700',
  suspended:  'bg-yellow-100 text-yellow-700',
  expired:    'bg-gray-100 text-gray-600',
}

const CONTRACT_TYPE_VALUES = ['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition'] as const
const TERMINATION_REASON_VALUES = ['resignation', 'dismissal', 'conventional', 'end_of_cdd', 'retirement', 'other'] as const

// ── Employee selector helper ──────────────────────────────────────────────────
interface EmployeeOption { id: string; first_name: string; last_name: string; registration_number: string }

// ── Detail modal ──────────────────────────────────────────────────────────────
function ContractDetailModal({ contract, onClose, canManage }: {
  contract: Contract
  onClose: () => void
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const { t } = useTranslation('contracts')
  const { t: tCommon } = useTranslation('common')
  const [showTerminate, setShowTerminate] = useState(false)
  const [showRenew, setShowRenew] = useState(false)
  const [terminationDate, setTerminationDate] = useState(new Date().toISOString().split('T')[0]!)
  const [terminationReason, setTerminationReason] = useState('resignation')
  const [terminationComment, setTerminationComment] = useState('')
  const [newEndDate, setNewEndDate] = useState('')

  const terminateMut = useMutation({
    mutationFn: () => api.post(`/contracts/${contract.id}/terminate`, {
      termination_date: terminationDate,
      termination_reason: terminationReason,
      comment: terminationComment || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] })
      onClose()
    },
  })

  const renewMut = useMutation({
    mutationFn: () => api.post(`/contracts/${contract.id}/renew`, { new_end_date: newEndDate }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] })
      setShowRenew(false)
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-card border border-border shadow-xl overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">{t('detail.title', { name: `${contract.first_name} ${contract.last_name}` })}</h2>
            <p className="text-sm text-muted-foreground">{contract.registration_number}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Badges type + statut */}
          <div className="flex gap-2 flex-wrap">
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${TYPE_COLOR[contract.type]}`}>
              {t(`types.${contract.type}`)}
            </span>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLOR[contract.status]}`}>
              {t(`statuses.${contract.status}`)}
            </span>
            {contract.ohada_clause && (
              <span className="rounded-full bg-indigo-100 text-indigo-700 px-3 py-1 text-xs font-semibold">
                {t('badges.ohadaClause')}
              </span>
            )}
            {contract.non_competition_clause && (
              <span className="rounded-full bg-pink-100 text-pink-700 px-3 py-1 text-xs font-semibold">
                {t('badges.nonCompetition')}
              </span>
            )}
          </div>

          {/* Grille infos */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.jobTitle')}</p>
              <p className="font-medium">{contract.job_title ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.level')}</p>
              <p className="font-medium">{contract.job_level ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.baseSalary')}</p>
              <p className="font-bold text-primary">{formatFCFA(Number(contract.base_salary))}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.weeklyHours')}</p>
              <p className="font-medium">{contract.working_hours}h</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.startDate')}</p>
              <p className="font-medium">{formatDate(contract.start_date)}</p>
            </div>
            {contract.end_date && (
              <div>
                <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.endDate')}</p>
                <p className="font-medium">{formatDate(contract.end_date)}</p>
              </div>
            )}
            {contract.trial_end_date && (
              <div>
                <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.trialEndDate')}</p>
                <p className="font-medium">{formatDate(contract.trial_end_date)}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.convention')}</p>
              <p className="font-medium">{contract.convention ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.telecommuting')}</p>
              <p className="font-medium">{t('detail.telecommutingValue', { count: contract.telecommuting_days })}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">{t('detail.fields.cnpsAffiliation')}</p>
              <p className={`font-medium ${contract.cnps_affiliation ? 'text-green-600' : 'text-red-600'}`}>
                {contract.cnps_affiliation ? tCommon('labels.yes') : tCommon('labels.no')}
              </p>
            </div>
          </div>

          {/* Actions */}
          {canManage && contract.status === 'active' && (
            <div className="border-t border-border pt-4 space-y-3">
              {contract.type === 'cdd' && !showRenew && (
                <button onClick={() => setShowRenew(true)}
                  className="flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors">
                  <RefreshCw className="h-4 w-4" />
                  {t('detail.renewCdd')}
                </button>
              )}

              {showRenew && (
                <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 space-y-3">
                  <p className="text-sm font-medium text-blue-800">{t('detail.newEndDate')}</p>
                  <input type="date" value={newEndDate} onChange={e => setNewEndDate(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => renewMut.mutate()}
                      disabled={!newEndDate || renewMut.isPending}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                      {renewMut.isPending ? t('detail.inProgress') : t('detail.confirmRenewal')}
                    </button>
                    <button onClick={() => setShowRenew(false)}
                      className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent">
                      {tCommon('actions.cancel')}
                    </button>
                  </div>
                </div>
              )}

              {!showTerminate && (
                <button onClick={() => setShowTerminate(true)}
                  className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors">
                  <AlertTriangle className="h-4 w-4" />
                  {t('detail.terminate')}
                </button>
              )}

              {showTerminate && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-4 space-y-3">
                  <p className="text-sm font-semibold text-red-800">{t('detail.terminationTitle')}</p>
                  <div>
                    <label className="block text-xs font-medium text-red-700 mb-1">{t('detail.reason')}</label>
                    <select value={terminationReason} onChange={e => setTerminationReason(e.target.value)}
                      className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm">
                      {TERMINATION_REASON_VALUES.map(r => (
                        <option key={r} value={r}>{t(`terminationReasons.${r}`)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-red-700 mb-1">{t('detail.effectiveDate')}</label>
                    <input type="date" value={terminationDate} onChange={e => setTerminationDate(e.target.value)}
                      className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-red-700 mb-1">{t('detail.commentOptional')}</label>
                    <textarea value={terminationComment} onChange={e => setTerminationComment(e.target.value)}
                      rows={2} className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm resize-none" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => terminateMut.mutate()}
                      disabled={terminateMut.isPending}
                      className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                      {terminateMut.isPending ? t('detail.inProgress') : t('detail.confirmTermination')}
                    </button>
                    <button onClick={() => setShowTerminate(false)}
                      className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent">
                      {tCommon('actions.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── New contract form ─────────────────────────────────────────────────────────
function NewContractModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const { t } = useTranslation('contracts')
  const { t: tCommon } = useTranslation('common')

  const { data: empData } = useQuery<{ data: EmployeeOption[] }>({
    queryKey: ['employees-list'],
    queryFn: () => api.get('/employees?limit=500').then(r => r.data),
  })
  const employees = empData?.data ?? []

  const [form, setForm] = useState({
    employee_id: '',
    type: 'cdi' as Contract['type'],
    start_date: new Date().toISOString().split('T')[0]!,
    end_date: '',
    base_salary: '',
    working_hours: '40',
    job_title: '',
    job_level: '',
    convention: '',
    cnps_affiliation: true,
    ohada_clause: true,
    non_competition_clause: false,
    telecommuting_days: '0',
  })

  const createMut = useMutation({
    mutationFn: () => api.post('/contracts', {
      ...form,
      base_salary: parseInt(form.base_salary),
      working_hours: parseInt(form.working_hours),
      telecommuting_days: parseInt(form.telecommuting_days),
      end_date: form.end_date || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] })
      onClose()
    },
  })

  const update = (field: string, value: unknown) => setForm(f => ({ ...f, [field]: value }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-card border border-border shadow-xl overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-lg font-semibold">{t('new.title')}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Employé */}
          <div>
            <label className="block text-sm font-medium mb-1">{t('new.employee')}</label>
            <select value={form.employee_id} onChange={e => update('employee_id', e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="">{t('new.selectEmployee')}</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>
                  {emp.first_name} {emp.last_name} ({emp.registration_number})
                </option>
              ))}
            </select>
          </div>

          {/* Type + dates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.contractType')}</label>
              <select value={form.type} onChange={e => update('type', e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                {CONTRACT_TYPE_VALUES.map(v => (
                  <option key={v} value={v}>{t(`typesLong.${v}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.startDate')}</label>
              <input type="date" value={form.start_date} onChange={e => update('start_date', e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
          </div>

          {/* Fin de contrat (CDD) */}
          {form.type !== 'cdi' && (
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.endDate')}</label>
              <input type="date" value={form.end_date} onChange={e => update('end_date', e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
          )}

          {/* Poste + niveau */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.jobTitle')}</label>
              <input type="text" value={form.job_title} onChange={e => update('job_title', e.target.value)}
                placeholder={t('new.jobTitlePlaceholder')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.level')}</label>
              <input type="text" value={form.job_level} onChange={e => update('job_level', e.target.value)}
                placeholder={t('new.levelPlaceholder')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
          </div>

          {/* Salaire + heures */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.baseSalary')}</label>
              <input type="number" value={form.base_salary} onChange={e => update('base_salary', e.target.value)}
                placeholder={t('new.baseSalaryPlaceholder')}
                min="60000"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t('new.weeklyHours')}</label>
              <input type="number" value={form.working_hours} onChange={e => update('working_hours', e.target.value)}
                min="1" max="48"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </div>
          </div>

          {/* Convention */}
          <div>
            <label className="block text-sm font-medium mb-1">{t('new.convention')}</label>
            <input type="text" value={form.convention} onChange={e => update('convention', e.target.value)}
              placeholder={t('new.conventionPlaceholder')}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </div>

          {/* Télétravail */}
          <div>
            <label className="block text-sm font-medium mb-1">{t('new.telecommutingDays')}</label>
            <input type="number" value={form.telecommuting_days} onChange={e => update('telecommuting_days', e.target.value)}
              min="0" max="5"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </div>

          {/* Clauses */}
          <div className="rounded-lg border border-border p-4 space-y-3 bg-muted/30">
            <p className="text-sm font-medium text-muted-foreground">{t('new.clausesTitle')}</p>
            {[
              { field: 'cnps_affiliation', label: t('new.clauses.cnpsAffiliation') },
              { field: 'ohada_clause', label: t('new.clauses.ohadaClause') },
              { field: 'non_competition_clause', label: t('new.clauses.nonCompetition') },
            ].map(({ field, label }) => (
              <label key={field} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form[field as keyof typeof form] as boolean}
                  onChange={e => update(field, e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>

          {form.base_salary && parseInt(form.base_salary) < 75000 && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('new.smigWarning')}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => createMut.mutate()}
              disabled={!form.employee_id || !form.start_date || !form.base_salary || createMut.isPending}
              className="flex-1 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity">
              {createMut.isPending ? t('new.submitting') : t('new.submit')}
            </button>
            <button onClick={onClose}
              className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent">
              {tCommon('actions.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ContractsPage() {
  const { t } = useTranslation('contracts')
  const { t: tCommon } = useTranslation('common')
  const user = useAuthStore(s => s.user)
  const canManage = ['admin', 'hr_manager'].includes(user?.role ?? '')
  const canCreate = canManage

  const [statusFilter, setStatusFilter] = useState('active')
  const [typeFilter, setTypeFilter] = useState('all')
  const [selectedContract, setSelectedContract] = useState<Contract | null>(null)
  const [showNew, setShowNew] = useState(false)

  const { data, isLoading, isFetching } = useQuery<{ data: Contract[] }>({
    queryKey: ['contracts', statusFilter, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (typeFilter !== 'all') params.set('type', typeFilter)
      return api.get(`/contracts?${params}`).then(r => r.data)
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

  const contracts = data?.data ?? []

  // Stats — Number() requis : PG retourne numeric comme string
  const stats = {
    total: contracts.length,
    cdi: contracts.filter(c => c.type === 'cdi').length,
    cdd: contracts.filter(c => c.type === 'cdd').length,
    masseSalariale: contracts.reduce((sum, c) => sum + (Number(c.base_salary) || 0), 0),
    trialExpiringSoon: contracts.filter(c => {
      if (!c.trial_end_date) return false
      const diff = new Date(c.trial_end_date).getTime() - Date.now()
      return diff > 0 && diff < 15 * 24 * 60 * 60 * 1000
    }).length,
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('subtitle')}
          </p>
        </div>
        {canCreate && (
          <button onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity">
            <Plus className="h-4 w-4" />
            {t('newContract')}
          </button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: t('kpis.activeContracts'), value: stats.total, icon: FileText, color: 'text-primary' },
          { label: t('kpis.cdi'), value: stats.cdi, icon: CheckCircle, color: 'text-green-600' },
          { label: t('kpis.cdd'), value: stats.cdd, icon: RefreshCw, color: 'text-blue-600' },
          { label: t('kpis.payroll'), value: formatFCFA(stats.masseSalariale), icon: Building2, color: 'text-purple-600' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <Icon className={`h-5 w-5 ${color}`} />
              <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-bold">{value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Alerte essais qui expirent */}
      {stats.trialExpiringSoon > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <Trans t={t} i18nKey="trialAlert"
              values={{ count: stats.trialExpiringSoon }}
              components={{ strong: <strong /> }} />
          </span>
        </div>
      )}

      {/* Filtres */}
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-1.5">
          {[
            { value: 'active', label: t('filters.active') },
            { value: 'terminated', label: t('filters.terminated') },
            { value: 'all', label: t('filters.all') },
          ].map(f => (
            <button key={f.value} onClick={() => setStatusFilter(f.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => setTypeFilter('all')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              typeFilter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground hover:bg-accent'
            }`}>
            {t('filters.allTypes')}
          </button>
          {CONTRACT_TYPE_VALUES.map(v => (
            <button key={v} onClick={() => setTypeFilter(v)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                typeFilter === v
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent'
              }`}>
              {t(`types.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Tableau */}
      <div className={`rounded-xl border border-border bg-card overflow-hidden transition-opacity ${isFetching && !isLoading ? 'opacity-60' : 'opacity-100'}`}>
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mr-2" />
            {tCommon('messages.loading')}
          </div>
        ) : contracts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <FileText className="h-10 w-10 mb-3 opacity-30" />
            <p className="font-medium">{t('empty.title')}</p>
            <p className="text-sm mt-1">{t('empty.hint')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.employee')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.department')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.type')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.status')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.grossSalary')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.start')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('table.endOrTrial')}</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contracts.map(contract => {
                const trialAlert = contract.trial_end_date && (() => {
                  const diff = new Date(contract.trial_end_date!).getTime() - Date.now()
                  return diff > 0 && diff < 15 * 24 * 60 * 60 * 1000
                })()
                return (
                  <tr key={contract.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary shrink-0">
                          {contract.first_name[0]}{contract.last_name[0]}
                        </div>
                        <div>
                          <p className="font-medium">{contract.first_name} {contract.last_name}</p>
                          <p className="text-xs text-muted-foreground">{contract.registration_number}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {contract.department_name ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TYPE_COLOR[contract.type] ?? ''}`}>
                        {t(`types.${contract.type}`, { defaultValue: contract.type })}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[contract.status] ?? ''}`}>
                        {t(`statuses.${contract.status}`, { defaultValue: contract.status })}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-primary">
                      {formatFCFA(Number(contract.base_salary))}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(contract.start_date)}
                    </td>
                    <td className="px-4 py-3">
                      {contract.trial_end_date && contract.status === 'active' ? (
                        <span className={`text-xs ${trialAlert ? 'text-amber-600 font-semibold' : 'text-muted-foreground'}`}>
                          {trialAlert && '⚠ '}{t('table.trialPrefix')} {formatDate(contract.trial_end_date)}
                        </span>
                      ) : contract.end_date ? (
                        <span className="text-xs text-muted-foreground">
                          {formatDate(contract.end_date)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        <button onClick={() => setSelectedContract(contract)}
                          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                          <Eye className="h-3.5 w-3.5" />
                          {t('table.view')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Info légale CI */}
      <div className="rounded-lg bg-muted/30 border border-border p-4 text-xs text-muted-foreground space-y-1">
        <p className="font-semibold text-foreground text-sm">{t('legal.title')}</p>
        <p>{t('legal.line1')}</p>
        <p>{t('legal.line2')}</p>
        <p>{t('legal.line3')}</p>
        <p>{t('legal.line4')}</p>
        <p><Trans t={t} i18nKey="legal.line5" components={{ strong: <strong /> }} /></p>
      </div>

      {/* Modales */}
      {selectedContract && (
        <ContractDetailModal
          contract={selectedContract}
          onClose={() => setSelectedContract(null)}
          canManage={canManage}
        />
      )}
      {showNew && <NewContractModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
