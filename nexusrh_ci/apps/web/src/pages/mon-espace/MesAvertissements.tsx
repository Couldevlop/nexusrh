import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } } | undefined)?.response?.data
  if (data?.error) return data.error
  if (err instanceof Error && err.message) return err.message
  return fallback
}

interface WarningRow {
  id: string; employee_id: string; tier: string; trigger_reason: string; occurrence_dates: string[]
  status: string; employee_response: string | null; responded_at: string | null
  disciplinary_action_id: string | null; created_at: string
}

const WARNING_STATUS_STYLE: Record<string, string> = {
  active: 'bg-amber-100 text-amber-800',
  explained: 'bg-emerald-100 text-emerald-800',
  contested: 'bg-orange-100 text-orange-800',
  closed: 'bg-slate-200 text-slate-700',
}

export default function MesAvertissements() {
  const { t } = useTranslation('attendance')
  const qc = useQueryClient()
  const [respondingId, setRespondingId] = useState<string | null>(null)
  const [responseText, setResponseText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const listQ = useQuery({
    queryKey: ['attendance', 'me', 'warnings'],
    queryFn: async () => (await api.get('/attendance/me/warnings')).data.data as WarningRow[],
  })

  const respondMut = useMutation({
    mutationFn: async ({ id, response }: { id: string; response: string }) => {
      await api.post(`/attendance/me/warnings/${id}/respond`, { response })
    },
    onSuccess: () => {
      setRespondingId(null)
      setResponseText('')
      setError(null)
      setSuccess(t('me.warnings.respondSuccess'))
      void qc.invalidateQueries({ queryKey: ['attendance', 'me', 'warnings'] })
    },
    onError: (err) => setError(apiErrorMessage(err, t('me.warnings.respondError'))),
  })

  const startRespond = (id: string) => {
    setRespondingId(id)
    setResponseText('')
    setError(null)
    setSuccess(null)
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><AlertTriangle className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('me.warnings.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('me.warnings.subtitle')}</p>
        </div>
      </div>

      {success && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4" /> {success}
        </div>
      )}

      {listQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('me.warnings.loading')}</p>}
      {listQ.isError && (
        <p className="py-10 text-center text-sm text-destructive">{apiErrorMessage(listQ.error, t('me.warnings.loadError'))}</p>
      )}
      {!listQ.isLoading && (listQ.data?.length ?? 0) === 0 && (
        <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('me.warnings.empty')}</p>
      )}

      {(listQ.data?.length ?? 0) > 0 && (
        <div className="space-y-3">
          {(listQ.data ?? []).map((w) => (
            <div key={w.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{t(`me.warnings.columns.tier`, { defaultValue: 'Type' })} : {t(`warnings.tiers.${w.tier}`, { defaultValue: w.tier })}</p>
                  <p className="text-sm text-muted-foreground">{w.trigger_reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{w.occurrence_dates.join(', ')}</p>
                </div>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', WARNING_STATUS_STYLE[w.status] ?? 'bg-muted')}>
                  {t(`warnings.statuses.${w.status}`, { defaultValue: w.status })}
                </span>
              </div>

              {w.employee_response ? (
                <p className="mt-3 rounded-lg bg-muted/30 p-2 text-sm">
                  <span className="font-medium">{t('me.warnings.columns.response')}</span> : {w.employee_response}
                </p>
              ) : w.tier === 'demande_explication' && w.status === 'active' ? (
                <div className="mt-3">
                  {respondingId === w.id ? (
                    <div className="space-y-2 max-w-2xl">
                      {error && <p className="text-sm text-destructive">{error}</p>}
                      <textarea
                        value={responseText}
                        onChange={(e) => setResponseText(e.target.value)}
                        placeholder={t('me.warnings.responsePlaceholder')}
                        rows={4}
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => { setRespondingId(null); setError(null) }}
                          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">
                          {t('me.warnings.respondCancel')}
                        </button>
                        <button type="button"
                          disabled={!responseText.trim() || respondMut.isPending}
                          onClick={() => respondMut.mutate({ id: w.id, response: responseText.trim() })}
                          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                          {respondMut.isPending ? t('me.warnings.respondSubmitting') : t('me.warnings.respondSubmit')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => startRespond(w.id)}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">
                      {t('me.warnings.respond')}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
