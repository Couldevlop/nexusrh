/**
 * Saisie d'une absence POUR un collaborateur (RH ou manager de sa chaîne).
 * Saisie par un N+1/N+2 : compte comme son visa ; saisie RH : pour tout salarié.
 * Les contrôles métier (prévenance, solde, durée de maternité, périmètre du
 * manager) restent côté API — leurs erreurs (422/403) sont affichées telles quelles.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { addDays, maternityTotalDays, type AbsenceType } from '@/lib/absence-maternity'
import { apiErrorMessage } from '@/components/approvals/workflow'

const schema = z.object({
  employeeId:    z.string().min(1, 'entry.validation.employeeRequired'),
  absenceTypeId: z.string().min(1, 'entry.validation.typeRequired'),
  startDate:     z.string().min(1, 'entry.validation.startRequired'),
  endDate:       z.string().min(1, 'entry.validation.endRequired'),
  halfDay:       z.boolean().default(false),
  reason:        z.string().optional(),
  multipleBirth:    z.boolean().default(false),
  illnessExtension: z.boolean().default(false),
  childHospitalizedDays: z.coerce.number().int().min(0).max(366).optional(),
}).refine((d) => !d.startDate || !d.endDate || d.startDate <= d.endDate, {
  message: 'entry.validation.endBeforeStart',
  path: ['endDate'],
})
type FormData = z.infer<typeof schema>

interface EmployeeOption { id: string; first_name: string; last_name: string; job_title?: string | null }

// L'API plafonne la page à 200 ; pour un manager elle restreint déjà à son périmètre.
const EMPLOYEES_URL = '/employees?isActive=true&limit=200'

const inputCls = 'mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'

export default function AbsenceEntryModal({ onClose, onCreated }: {
  onClose: () => void
  /** Absence créée — `warning` : signalement non bloquant de l'API (ex. solde dépassé). */
  onCreated: (warning?: string) => void
}) {
  const { t } = useTranslation('absences')
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')

  const { data: employeesData } = useQuery<{ data: EmployeeOption[] }>({
    queryKey: ['absence-entry-employees'],
    queryFn: () => api.get(EMPLOYEES_URL).then(r => r.data),
  })
  const { data: typesData } = useQuery<{ data: AbsenceType[] }>({
    queryKey: ['absence-types'],
    queryFn: () => api.get('/absences/types').then(r => r.data),
  })

  const employees = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return [...(employeesData?.data ?? [])]
      .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'fr'))
      .filter(e => !q || `${e.first_name} ${e.last_name}`.toLowerCase().includes(q))
  }, [employeesData, filter])
  const absenceTypes = typesData?.data ?? []

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { halfDay: false, multipleBirth: false, illnessExtension: false },
  })

  // Maternité : date de fin = début + durée légale du pays (+ prolongations), comme en self-service.
  const maternity = absenceTypes.find(at => at.id === watch('absenceTypeId'))?.maternity_rule
  const startDate = watch('startDate')
  const multipleBirth = watch('multipleBirth')
  const illnessExtension = watch('illnessExtension')
  const hospitalized = Number(watch('childHospitalizedDays') || 0)
  const maternityDays = maternity
    ? maternityTotalDays(maternity, { multipleBirth, illnessExtension, hospitalizedDays: hospitalized })
    : 0
  useEffect(() => {
    if (maternity && startDate) setValue('endDate', addDays(startDate, maternityDays - 1), { shouldValidate: true })
  }, [maternity, startDate, maternityDays, setValue])

  const createMut = useMutation({
    mutationFn: ({ multipleBirth: mb, illnessExtension: ill, childHospitalizedDays, reason, ...data }: FormData) =>
      api.post('/absences', {
        ...data,
        ...(reason ? { reason } : {}),
        ...(maternity
          ? { halfDay: false, maternity: { multipleBirth: mb, illnessExtension: ill, childHospitalizedDays: childHospitalizedDays || 0 } }
          : {}),
      }).then(r => r.data as { warning?: string }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['absences'] })
      void queryClient.invalidateQueries({ queryKey: ['approvals-pending'] })
      onCreated(res?.warning)
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="absence-entry-title"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 id="absence-entry-title" className="font-semibold">{t('entry.title')}</h3>
            <p className="text-xs text-muted-foreground mt-1">{t('entry.subtitle')}</p>
          </div>
          <button onClick={onClose} aria-label={t('entry.cancel')} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit(data => createMut.mutate(data))} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label htmlFor="entry-employee" className="text-sm font-medium">{t('entry.employee')}</label>
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder={t('entry.employeeFilter')}
                className={inputCls} />
              <select id="entry-employee" {...register('employeeId')} className={inputCls}>
                <option value="">{t('entry.selectEmployee')}</option>
                {employees.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.last_name} {e.first_name}{e.job_title ? ` — ${e.job_title}` : ''}
                  </option>
                ))}
              </select>
              {errors.employeeId && <p className="text-xs text-destructive mt-1">{t(errors.employeeId.message ?? '')}</p>}
            </div>
            <div className="col-span-2">
              <label htmlFor="entry-type" className="text-sm font-medium">{t('entry.type')}</label>
              <select id="entry-type" {...register('absenceTypeId')} className={inputCls}>
                <option value="">{t('entry.selectType')}</option>
                {absenceTypes.map(at => <option key={at.id} value={at.id}>{at.label}</option>)}
              </select>
              {errors.absenceTypeId && <p className="text-xs text-destructive mt-1">{t(errors.absenceTypeId.message ?? '')}</p>}
            </div>
            <div>
              <label htmlFor="entry-start" className="text-sm font-medium">{t('entry.startDate')}</label>
              <input id="entry-start" {...register('startDate')} type="date" className={inputCls} />
              {errors.startDate && <p className="text-xs text-destructive mt-1">{t(errors.startDate.message ?? '')}</p>}
            </div>
            <div>
              <label htmlFor="entry-end" className="text-sm font-medium">{t('entry.endDate')}</label>
              <input id="entry-end" {...register('endDate')} type="date" className={inputCls} />
              {errors.endDate && <p className="text-xs text-destructive mt-1">{t(errors.endDate.message ?? '')}</p>}
            </div>
            {maternity ? (
              <div className="col-span-2 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  {t('entry.maternity.legal', { days: maternity.legalDays, weeks: maternity.legalDays / 7 })}
                </p>
                {maternity.multipleBirthDays > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <input {...register('multipleBirth')} type="checkbox" className="rounded" />
                    {t('entry.maternity.multipleBirth', { weeks: maternity.multipleBirthDays / 7 })}
                  </label>
                )}
                {maternity.illnessDays > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <input {...register('illnessExtension')} type="checkbox" className="rounded" />
                    {t('entry.maternity.illness', { weeks: maternity.illnessDays / 7 })}
                  </label>
                )}
                {maternity.maxHospitalizationDays > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    {t('entry.maternity.hospitalized')}
                    <input {...register('childHospitalizedDays')} type="number" min={0} max={maternity.maxHospitalizationDays}
                      className="w-20 rounded-lg border border-input bg-background px-2 py-1 text-sm" />
                  </label>
                )}
                <p className="text-xs font-medium">{t('entry.maternity.total', { days: maternityDays })}</p>
              </div>
            ) : (
              <div className="col-span-2 flex items-center gap-2">
                <input {...register('halfDay')} type="checkbox" id="entry-halfDay" className="rounded" />
                <label htmlFor="entry-halfDay" className="text-sm">{t('entry.halfDay')}</label>
              </div>
            )}
            <div className="col-span-2">
              <label htmlFor="entry-reason" className="text-sm font-medium">{t('entry.reason')}</label>
              <textarea id="entry-reason" {...register('reason')} rows={2} placeholder={t('entry.reasonPlaceholder')}
                className={`${inputCls} resize-none`} />
            </div>
          </div>

          {createMut.isError && (
            <p role="alert" className="text-sm text-destructive">{apiErrorMessage(createMut.error, t('entry.error'))}</p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
              {t('entry.cancel')}
            </button>
            <button type="submit" disabled={createMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {createMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('entry.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
