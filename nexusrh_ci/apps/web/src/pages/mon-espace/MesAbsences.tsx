import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api, formatDate } from '@/lib/api'
import { Plus, Calendar, Loader2 } from 'lucide-react'

const schema = z.object({
  absenceTypeId: z.string().min(1, 'absences.validation.typeRequired'),
  startDate:     z.string().min(1, 'absences.validation.startRequired'),
  endDate:       z.string().min(1, 'absences.validation.endRequired'),
  halfDay:       z.boolean().default(false),
  reason:        z.string().optional(),
})
type FormData = z.infer<typeof schema>

interface AbsenceType { id: string; label: string; code: string; color: string }
interface Absence {
  id: string; type_label: string; type_color: string
  start_date: string; end_date: string; days: number
  half_day: boolean; status: string; reason: string | null
}

interface Balance {
  absence_type_id: string; label: string; code: string; color: string
  acquired: number; taken: number; pending: number; remaining: number
}

const STATUS_COLOR: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-700',
  approved:  'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
}
const STATUS_KEY: Record<string, string> = {
  submitted: 'common.status.pending',
  approved:  'common.status.approved',
  rejected:  'common.status.rejected',
}

export default function MesAbsences() {
  const { t } = useTranslation('monEspace')
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)

  const { data: typesData } = useQuery<{ data: AbsenceType[] }>({
    queryKey: ['absence-types'],
    queryFn: () => api.get('/absences/types').then(r => r.data),
  })

  const { data: absencesData, isLoading } = useQuery<{ data: Absence[] }>({
    queryKey: ['my-absences'],
    queryFn: () => api.get('/absences/my-absences').then(r => r.data),
  })

  const { data: balancesData } = useQuery<{ data: Balance[] }>({
    queryKey: ['my-balances'],
    queryFn: () => api.get('/absences/balances').then(r => r.data),
  })

  const createMut = useMutation({
    mutationFn: (data: FormData) => api.post('/absences', data),
    onSuccess: () => {
      setShowForm(false)
      queryClient.invalidateQueries({ queryKey: ['my-absences'] })
      queryClient.invalidateQueries({ queryKey: ['my-balances'] })
    },
  })

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { halfDay: false },
  })

  const absences = absencesData?.data ?? []
  const balances = balancesData?.data ?? []
  const absenceTypes = typesData?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('absences.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('absences.subtitle')}</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" />
          {t('absences.newRequest')}
        </button>
      </div>

      {/* Soldes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {balances.map(b => (
          <div key={b.absence_type_id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-3 w-3 rounded-full" style={{ backgroundColor: b.color }} />
              <p className="text-xs font-medium">{b.label}</p>
            </div>
            <p className="text-xl font-bold">{t('absences.balanceRemaining', { count: b.remaining })}</p>
            <p className="text-xs text-muted-foreground">{t('absences.balanceDetail', { acquired: b.acquired })}</p>
          </div>
        ))}
      </div>

      {/* Formulaire */}
      {showForm && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">{t('absences.formTitle')}</h2>
          <form onSubmit={handleSubmit(data => createMut.mutate(data))} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="text-sm font-medium">{t('absences.absenceType')}</label>
                <select {...register('absenceTypeId')}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
                  <option value="">{t('absences.selectPlaceholder')}</option>
                  {absenceTypes.map(at => (
                    <option key={at.id} value={at.id}>{at.label}</option>
                  ))}
                </select>
                {errors.absenceTypeId && <p className="text-xs text-destructive mt-1">{t(errors.absenceTypeId.message ?? '')}</p>}
              </div>
              <div>
                <label className="text-sm font-medium">{t('absences.startDate')}</label>
                <input {...register('startDate')} type="date"
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
                {errors.startDate && <p className="text-xs text-destructive mt-1">{t(errors.startDate.message ?? '')}</p>}
              </div>
              <div>
                <label className="text-sm font-medium">{t('absences.endDate')}</label>
                <input {...register('endDate')} type="date"
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
                {errors.endDate && <p className="text-xs text-destructive mt-1">{t(errors.endDate.message ?? '')}</p>}
              </div>
              <div className="flex items-center gap-2">
                <input {...register('halfDay')} type="checkbox" id="halfDay" className="rounded" />
                <label htmlFor="halfDay" className="text-sm">{t('absences.halfDay')}</label>
              </div>
              <div className="col-span-2">
                <label className="text-sm font-medium">{t('absences.reason')}</label>
                <textarea {...register('reason')} rows={2} placeholder={t('absences.reasonPlaceholder')}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none resize-none" />
              </div>
            </div>

            {createMut.isError && (
              <p className="text-sm text-destructive">
                {(createMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('common.error')}
              </p>
            )}

            <div className="flex gap-2">
              <button type="submit" disabled={isSubmitting || createMut.isPending}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {(isSubmitting || createMut.isPending) && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('absences.submitRequest')}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Historique */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-semibold">{t('absences.history')}</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {absences.map(abs => (
              <div key={abs.id} className="flex items-center justify-between px-6 py-4 hover:bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="h-2 w-2 rounded-full" style={{ backgroundColor: abs.type_color ?? '#888' }} />
                  <div>
                    <p className="text-sm font-medium">{abs.type_label}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(abs.start_date)} → {formatDate(abs.end_date)}
                      {' · '}{abs.half_day ? t('absences.halfDayShort') : t('absences.daysCount', { count: abs.days })}
                    </p>
                    {abs.reason && <p className="text-xs text-muted-foreground italic">{abs.reason}</p>}
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[abs.status] ?? 'bg-muted'}`}>
                  {STATUS_KEY[abs.status] ? t(STATUS_KEY[abs.status] as string) : abs.status}
                </span>
              </div>
            ))}
            {absences.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                <Calendar className="mx-auto mb-2 h-8 w-8 opacity-30" />
                {t('absences.empty')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
