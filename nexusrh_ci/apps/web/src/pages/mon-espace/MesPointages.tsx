import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Clock, LogIn } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } } | undefined)?.response?.data
  if (data?.error) return data.error
  if (err instanceof Error && err.message) return err.message
  return fallback
}

interface PunchRow {
  id: string; employee_id: string; raw_employee_ref: string | null; device_id: string | null
  punched_at: string; direction: string; source: string; created_at: string
}
interface DayRow {
  id: string; employee_id: string; work_date: string; first_in: string | null; last_out: string | null
  expected_start: string | null; late_minutes: number; status: string; justified_by: string | null; computed_at: string
}
interface MeData { punches: PunchRow[]; days: DayRow[]; from: string; to: string }

const DAY_STATUS_STYLE: Record<string, string> = {
  present: 'bg-emerald-100 text-emerald-800',
  late: 'bg-amber-100 text-amber-800',
  absent_unjustified: 'bg-rose-100 text-rose-800',
  absent_justified: 'bg-sky-100 text-sky-800',
  off: 'bg-muted text-muted-foreground',
}

export default function MesPointages() {
  const { t } = useTranslation('attendance')

  const meQ = useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: async () => (await api.get('/attendance/me')).data.data as MeData,
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Clock className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('me.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('me.subtitle')}</p>
        </div>
      </div>

      {meQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('me.loading')}</p>}
      {meQ.isError && (
        <p className="py-10 text-center text-sm text-destructive">{apiErrorMessage(meQ.error, t('me.loadError'))}</p>
      )}

      {meQ.data && (
        <>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">{t('me.days.title')}</h2>
            {meQ.data.days.length === 0 ? (
              <p className="rounded-xl border border-border bg-card py-8 text-center text-sm text-muted-foreground">{t('me.days.empty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">{t('me.columns.date')}</th>
                    <th className="px-3 py-2">{t('me.columns.status')}</th>
                    <th className="px-3 py-2">{t('me.columns.lateMinutes')}</th>
                    <th className="px-3 py-2">{t('me.columns.firstIn')}</th>
                    <th className="px-3 py-2">{t('me.columns.lastOut')}</th>
                  </tr></thead>
                  <tbody>
                    {meQ.data.days.map((d) => (
                      <tr key={d.id} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 font-medium">{d.work_date}</td>
                        <td className="px-3 py-2">
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', DAY_STATUS_STYLE[d.status] ?? 'bg-muted')}>
                            {t(`statuses.${d.status}`, { defaultValue: d.status })}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{d.late_minutes}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{d.first_in ? new Date(d.first_in).toLocaleTimeString() : '—'}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{d.last_out ? new Date(d.last_out).toLocaleTimeString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold"><LogIn className="h-4 w-4" /> {t('me.punches.title')}</h2>
            {meQ.data.punches.length === 0 ? (
              <p className="rounded-xl border border-border bg-card py-8 text-center text-sm text-muted-foreground">{t('me.punches.empty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">{t('me.columns.punchedAt')}</th>
                    <th className="px-3 py-2">{t('me.columns.direction')}</th>
                  </tr></thead>
                  <tbody>
                    {meQ.data.punches.map((p) => (
                      <tr key={p.id} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 text-muted-foreground">{new Date(p.punched_at).toLocaleString()}</td>
                        <td className="px-3 py-2">{t(`directions.${p.direction}`, { defaultValue: p.direction })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
