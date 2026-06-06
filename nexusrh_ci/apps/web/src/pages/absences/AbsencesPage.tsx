import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatDate } from '@/lib/api'
import { Calendar, CheckCircle, XCircle } from 'lucide-react'

interface Absence {
  id: string; employee_id: string; first_name: string; last_name: string
  type_label: string; type_color: string
  start_date: string; end_date: string; days: number
  half_day: boolean; reason: string | null
  status: string; validation_level: number
  created_at: string
}

const STATUS_COLOR: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-700',
  approved:  'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
}

export default function AbsencesPage() {
  const { t } = useTranslation('absences')
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<string>('submitted')
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const { data, isLoading } = useQuery<{ data: Absence[] }>({
    queryKey: ['absences', statusFilter],
    queryFn: () => api.get(`/absences?status=${statusFilter}`).then(r => r.data),
  })

  const approveMut = useMutation({
    mutationFn: (id: string) => api.patch(`/absences/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['absences'] }),
  })

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.patch(`/absences/${id}/reject`, { reason }),
    onSuccess: () => {
      setRejectId(null)
      setRejectReason('')
      queryClient.invalidateQueries({ queryKey: ['absences'] })
    },
  })

  const absences = data?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('requestsCount', { count: absences.length })}</p>
        </div>

        <div className="flex gap-2">
          {['submitted', 'approved', 'rejected'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent'
              }`}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">{t('table.employee')}</th>
                <th className="p-4">{t('table.type')}</th>
                <th className="p-4">{t('table.period')}</th>
                <th className="p-4 text-center">{t('table.days')}</th>
                <th className="p-4">{t('table.reason')}</th>
                <th className="p-4">{t('table.status')}</th>
                {statusFilter === 'submitted' && <th className="p-4">{t('table.actions')}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {absences.map(abs => (
                <tr key={abs.id} className="hover:bg-muted/30">
                  <td className="p-4">
                    <p className="font-medium">{abs.first_name} {abs.last_name}</p>
                  </td>
                  <td className="p-4">
                    <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                      style={{ backgroundColor: abs.type_color ?? '#888' }}>
                      {abs.type_label}
                    </span>
                  </td>
                  <td className="p-4">
                    <p className="text-xs">{formatDate(abs.start_date)} → {formatDate(abs.end_date)}</p>
                  </td>
                  <td className="p-4 text-center">{abs.half_day ? t('halfDay') : t('fullDays', { count: abs.days })}</td>
                  <td className="p-4 max-w-[200px] truncate text-muted-foreground">
                    {abs.reason ?? t('noReason')}
                  </td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[abs.status] ?? 'bg-muted'}`}>
                      {STATUS_COLOR[abs.status] ? t(`status.${abs.status}`) : abs.status}
                    </span>
                  </td>
                  {statusFilter === 'submitted' && (
                    <td className="p-4">
                      <div className="flex gap-2">
                        <button
                          onClick={() => approveMut.mutate(abs.id)}
                          disabled={approveMut.isPending}
                          className="flex items-center gap-1 rounded-lg bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200 disabled:opacity-50"
                        >
                          <CheckCircle className="h-3 w-3" /> {t('actions.approve')}
                        </button>
                        <button
                          onClick={() => setRejectId(abs.id)}
                          className="flex items-center gap-1 rounded-lg bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                        >
                          <XCircle className="h-3 w-3" /> {t('actions.reject')}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {absences.length === 0 && (
                <tr>
                  <td colSpan={statusFilter === 'submitted' ? 7 : 6} className="p-8 text-center text-muted-foreground">
                    <Calendar className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    {t('empty', { status: t(`status.${statusFilter}`).toLowerCase() })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal refus */}
      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRejectId(null)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-3">{t('rejectModal.title')}</h3>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder={t('rejectModal.placeholder')}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none resize-none"
              rows={3}
            />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setRejectId(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                {t('rejectModal.cancel')}
              </button>
              <button
                onClick={() => rejectMut.mutate({ id: rejectId, reason: rejectReason })}
                disabled={rejectMut.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
                {t('rejectModal.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
