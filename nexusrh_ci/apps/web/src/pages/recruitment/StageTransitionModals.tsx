/**
 * Modales de transition du pipeline de recrutement (marque employeur, lot 2).
 *
 *  - RejectReasonModal : tout passage en « Rejeté » depuis l'UI (glisser-
 *    déposer ou bouton) exige un motif de la liste fermée, plus une note
 *    facultative (500 caractères max).
 *  - HireEmployeeModal : « Recruter » / dépôt sur « Recruté » ouvre la fiche
 *    employé pré-remplie (candidature, offre, dernier contrat généré). La
 *    confirmation passe la candidature en « Recruté » ET crée la fiche ;
 *    l'annulation laisse l'étape inchangée.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Loader2, UserPlus, XCircle } from 'lucide-react'
import { api } from '@/lib/api'

export const REJECTION_REASONS = [
  'declined_by_candidate_salary',
  'declined_by_candidate_other_offer',
  'declined_by_candidate_delay',
  'declined_by_candidate_other',
  'rejected_profile',
  'rejected_after_interview',
  'rejected_auto_screening',
  'position_closed',
  'other',
] as const
export type RejectionReason = typeof REJECTION_REASONS[number]

export const REJECTION_NOTE_MAX = 500

const CONTRACT_TYPES = ['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition'] as const
type ContractType = typeof CONTRACT_TYPES[number]

export interface CandidateRef {
  id: string
  first_name: string
  last_name: string
  job_title?: string | null
}

/** Valeurs envoyées dans `employee` de PATCH /recruitment/applications/:id/stage. */
export interface HireEmployeeValues {
  hireDate?: string
  departmentId?: string | null
  legalEntityId?: string | null
  baseSalary?: number
  contractType?: ContractType
  jobTitle?: string
  professionalCategory?: string
  /** Mode de paiement (facultatif) — mêmes champs/validation que la fiche employé. */
  paymentMethod?: PaymentMethod
  mobileMoneyProvider?: MmProvider
  mobileMoneyPhone?: string
  iban?: string
  bankName?: string
}

type PaymentMethod = 'mobile_money' | 'bank_transfer'
const MM_PROVIDERS = ['wave', 'mtn', 'orange'] as const
type MmProvider = typeof MM_PROVIDERS[number]
/** Format Mobile Money CI (identique à l'API) : +225 + 07/05 + 8 chiffres. */
export const CI_MM_PHONE = /^\+2250[57]\d{8}$/

const errorOf = (err: unknown): string | null =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? null

// ── Motif de rejet ────────────────────────────────────────────────────────────

export function RejectReasonModal({ candidate, busy, error, onCancel, onConfirm }: {
  candidate: CandidateRef
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (reason: RejectionReason, note: string) => void
}) {
  const { t } = useTranslation('recruitment')
  const [reason, setReason] = useState<RejectionReason | ''>('')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)

  const submit = () => {
    setTouched(true)
    if (!reason) return
    onConfirm(reason, note.trim())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto"
         onClick={() => !busy && onCancel()}>
      <div role="dialog" aria-modal="true" aria-labelledby="reject-reason-title"
           className="w-full max-w-md rounded-xl bg-card p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <XCircle className="h-5 w-5 text-red-500" />
          <h3 id="reject-reason-title" className="text-lg font-semibold">{t('transition.rejectTitle')}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {candidate.first_name} {candidate.last_name}{candidate.job_title ? ` · ${candidate.job_title}` : ''}
        </p>

        <label className="block text-sm">
          <span className="text-muted-foreground">{t('transition.reasonLabel')} *</span>
          <select value={reason} autoFocus
            onChange={e => setReason(e.target.value as RejectionReason | '')}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2">
            <option value="">{t('transition.reasonPlaceholder')}</option>
            <optgroup label={t('transition.groupCandidate')}>
              {REJECTION_REASONS.filter(r => r.startsWith('declined_by_candidate_')).map(r => (
                <option key={r} value={r}>{t(`rejectionReason.${r}`)}</option>
              ))}
            </optgroup>
            <optgroup label={t('transition.groupCompany')}>
              {/* rejected_auto_screening : posé par le pré-tri uniquement (refusé par l'API ici). */}
              {REJECTION_REASONS.filter(r => !r.startsWith('declined_by_candidate_') && r !== 'rejected_auto_screening').map(r => (
                <option key={r} value={r}>{t(`rejectionReason.${r}`)}</option>
              ))}
            </optgroup>
          </select>
        </label>
        {touched && !reason && <p className="mt-1 text-xs text-red-600">{t('transition.reasonRequired')}</p>}

        <label className="mt-3 block text-sm">
          <span className="text-muted-foreground">{t('transition.noteLabel')}</span>
          <textarea value={note} maxLength={REJECTION_NOTE_MAX} rows={3}
            onChange={e => setNote(e.target.value)}
            placeholder={t('transition.notePlaceholder')}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <span className="block text-right text-[11px] text-muted-foreground">{note.length}/{REJECTION_NOTE_MAX}</span>
        </label>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
            {t('transition.cancel')}
          </button>
          <button onClick={submit} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            {t('transition.confirmReject')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Fiche employé à l'embauche ────────────────────────────────────────────────

interface HirePrefill {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  hireDate: string
  departmentId: string | null
  legalEntityId: string | null
  baseSalary: number | null
  contractType: ContractType
  jobTitle: string | null
  professionalCategory: string | null
  employeeId: string | null
  existingEmployeeId: string | null
}

interface Option { id: string; name: string }

export function HireEmployeeModal({ candidate, busy, error, onCancel, onConfirm }: {
  candidate: CandidateRef
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (values: HireEmployeeValues) => void
}) {
  const { t } = useTranslation('recruitment')
  const prefill = useQuery<{ data: HirePrefill }>({
    queryKey: ['recruitment-hire-prefill', candidate.id],
    queryFn: () => api.get(`/recruitment/applications/${candidate.id}/hire-prefill`).then(r => r.data),
    staleTime: 0,
  })
  const { data: deptData } = useQuery<{ data: Option[] }>({
    queryKey: ['recruitment-departments'],
    queryFn: () => api.get('/employees/departments').then(r => r.data).catch(() => ({ data: [] })),
  })
  const { data: entityData } = useQuery<{ data: Option[] }>({
    queryKey: ['recruitment-legal-entities'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data).catch(() => ({ data: [] })),
  })

  const [form, setForm] = useState({
    hireDate: '', departmentId: '', legalEntityId: '', baseSalary: '',
    contractType: 'cdi' as ContractType, jobTitle: '', professionalCategory: '',
  })
  // Mode de paiement facultatif : '' = non renseigné (comportement historique).
  const [pay, setPay] = useState({
    method: '' as PaymentMethod | '', provider: '' as MmProvider | '', phone: '', bankName: '', iban: '',
  })
  const [payTouched, setPayTouched] = useState(false)
  const p = prefill.data?.data
  useEffect(() => {
    if (!p) return
    setForm({
      hireDate: p.hireDate,
      departmentId: p.departmentId ?? '',
      legalEntityId: p.legalEntityId ?? '',
      baseSalary: p.baseSalary !== null ? String(p.baseSalary) : '',
      contractType: p.contractType,
      jobTitle: p.jobTitle ?? '',
      professionalCategory: p.professionalCategory ?? '',
    })
  }, [p])

  const linked = !!(p?.employeeId || p?.existingEmployeeId)
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }))

  // Erreur de cohérence du mode de paiement (clé i18n) ou null.
  const payError = pay.method === 'mobile_money'
    ? (!pay.provider ? 'paymentProviderRequired' : !CI_MM_PHONE.test(pay.phone.replace(/\s/g, '')) ? 'paymentPhoneInvalid' : null)
    : pay.method === 'bank_transfer' ? (!pay.bankName.trim() ? 'paymentBankRequired' : null) : null

  const submit = () => {
    if (payError) { setPayTouched(true); return }
    const values: HireEmployeeValues = {
      ...(form.hireDate ? { hireDate: form.hireDate } : {}),
      departmentId: form.departmentId || null,
      legalEntityId: form.legalEntityId || null,
      ...(form.baseSalary !== '' ? { baseSalary: Math.max(0, Math.round(Number(form.baseSalary))) } : {}),
      contractType: form.contractType,
      ...(form.jobTitle.trim() ? { jobTitle: form.jobTitle.trim() } : {}),
      ...(form.professionalCategory.trim() ? { professionalCategory: form.professionalCategory.trim() } : {}),
      ...(pay.method === 'mobile_money' && pay.provider
        ? { paymentMethod: 'mobile_money' as const, mobileMoneyProvider: pay.provider, mobileMoneyPhone: pay.phone.replace(/\s/g, '') } : {}),
      ...(pay.method === 'bank_transfer'
        ? { paymentMethod: 'bank_transfer' as const, bankName: pay.bankName.trim(), ...(pay.iban.trim() ? { iban: pay.iban.replace(/\s+/g, '') } : {}) } : {}),
    }
    onConfirm(values)
  }

  const departments = deptData?.data ?? []
  const entities = entityData?.data ?? []
  const prefillError = prefill.isError ? (errorOf(prefill.error) ?? t('transition.prefillError')) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto"
         onClick={() => !busy && onCancel()}>
      <div role="dialog" aria-modal="true" aria-labelledby="hire-employee-title"
           className="w-full max-w-lg rounded-xl bg-card p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="h-5 w-5 text-green-600" />
          <h3 id="hire-employee-title" className="text-lg font-semibold">{t('transition.hireTitle')}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          {candidate.first_name} {candidate.last_name}{candidate.job_title ? ` · ${candidate.job_title}` : ''}
        </p>

        {prefill.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('transition.loading')}
          </div>
        ) : prefillError ? (
          <p className="text-sm text-red-600">{prefillError}</p>
        ) : linked ? (
          <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            {t('transition.existingEmployee')}
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted-foreground">{t('transition.hireIntro')}</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="text-muted-foreground">{t('transition.hireDate')}</span>
                <input type="date" value={form.hireDate} onChange={e => set({ hireDate: e.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
              </label>
              <label className="text-sm">
                <span className="text-muted-foreground">{t('transition.contractType')}</span>
                <select value={form.contractType} onChange={e => set({ contractType: e.target.value as ContractType })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2">
                  {CONTRACT_TYPES.map(c => <option key={c} value={c}>{t(`transition.contractTypes.${c}`)}</option>)}
                </select>
              </label>
              <label className="text-sm col-span-2">
                <span className="text-muted-foreground">{t('transition.jobTitle')}</span>
                <input value={form.jobTitle} maxLength={100} onChange={e => set({ jobTitle: e.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
              </label>
              <label className="text-sm">
                <span className="text-muted-foreground">{t('transition.department')}</span>
                <select value={form.departmentId} onChange={e => set({ departmentId: e.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2">
                  <option value="">{t('transition.none')}</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="text-muted-foreground">{t('transition.legalEntity')}</span>
                <select value={form.legalEntityId} onChange={e => set({ legalEntityId: e.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2">
                  <option value="">{t('transition.none')}</option>
                  {entities.map(le => <option key={le.id} value={le.id}>{le.name}</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="text-muted-foreground">{t('transition.salary')}</span>
                <input type="number" min={0} step={1} value={form.baseSalary} placeholder="FCFA"
                  onChange={e => set({ baseSalary: e.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
              </label>
              <label className="text-sm">
                <span className="text-muted-foreground">{t('transition.category')}</span>
                <input value={form.professionalCategory} maxLength={50}
                  onChange={e => set({ professionalCategory: e.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
              </label>
            </div>
            {form.baseSalary === '' && (
              <p className="mt-2 text-xs text-amber-700">{t('transition.salaryMissing')}</p>
            )}

            {/* Mode de paiement du salaire — facultatif, mêmes règles que la fiche employé */}
            <fieldset className="mt-3 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium text-muted-foreground">{t('transition.paymentTitle')}</legend>
              <div className="flex gap-2">
                {([['', 'paymentNone'], ['mobile_money', 'paymentMobileMoney'], ['bank_transfer', 'paymentBankTransfer']] as const).map(([m, label]) => (
                  <button key={m} type="button" onClick={() => { setPay(x => ({ ...x, method: m })); setPayTouched(false) }}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium ${pay.method === m ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground'}`}>
                    {t(`transition.${label}`)}
                  </button>
                ))}
              </div>
              {pay.method === '' && <p className="mt-2 text-xs text-amber-700">{t('transition.paymentHint')}</p>}
              {pay.method === 'mobile_money' && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="text-muted-foreground">{t('transition.paymentProvider')}</span>
                    <select value={pay.provider} onChange={e => setPay(x => ({ ...x, provider: e.target.value as MmProvider | '' }))}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2">
                      <option value="">—</option>
                      {MM_PROVIDERS.map(p => <option key={p} value={p}>{p === 'mtn' ? 'MTN MoMo' : p === 'orange' ? 'Orange Money' : 'Wave'}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="text-muted-foreground">{t('transition.paymentPhone')}</span>
                    <input value={pay.phone} maxLength={30} placeholder={t('transition.paymentPhonePlaceholder')}
                      onChange={e => setPay(x => ({ ...x, phone: e.target.value }))}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
                  </label>
                </div>
              )}
              {pay.method === 'bank_transfer' && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="text-muted-foreground">{t('transition.paymentBankName')}</span>
                    <input value={pay.bankName} maxLength={100} onChange={e => setPay(x => ({ ...x, bankName: e.target.value }))}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
                  </label>
                  <label className="text-sm">
                    <span className="text-muted-foreground">{t('transition.paymentIban')}</span>
                    <input value={pay.iban} maxLength={50} onChange={e => setPay(x => ({ ...x, iban: e.target.value }))}
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
                  </label>
                </div>
              )}
              {payTouched && payError && <p className="mt-2 text-xs text-red-600">{t(`transition.${payError}`)}</p>}
            </fieldset>
          </>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
            {t('transition.cancel')}
          </button>
          <button onClick={submit} disabled={busy || prefill.isLoading || !!prefillError}
            className="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            {linked ? t('transition.confirmHireLink') : t('transition.confirmHire')}
          </button>
        </div>
      </div>
    </div>
  )
}

export { errorOf as transitionErrorOf }
