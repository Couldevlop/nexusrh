import { useEffect, useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { api } from '@/lib/api'

// Congés payés : règles du pays (pack) + surcharge du tenant (convention ou
// usage plus favorable). L'API refuse une acquisition sous le minimum légal.
type Method = 'most_favourable' | 'average_calendar' | 'one_twelfth'
interface EffectivePolicy {
  accrualMode: 'monthly' | 'manual'
  daysPerMonth: number
  seniorityDays: Array<{ minYears: number; days: number }>
  calendarDaysPerWorkingDay: number
  allowanceMethod: Method
  carryOver: boolean
  balanceCheck: 'block' | 'warn' | 'off'
  maxAdvanceDays: number
  leaveTypeCode: string
  legalDaysPerMonth: number | null
}
interface LeavePolicyView {
  legislationPackCode: string
  tenantPolicy: Record<string, unknown> | null
  effective: EffectivePolicy
}

const num = (v: string) => Number(v.replace(',', '.'))

export default function LeavePolicyCard({ qc }: { qc: QueryClient }) {
  const { t } = useTranslation('settings')
  const { data } = useQuery<{ data: LeavePolicyView }>({
    queryKey: ['settings-leave-policy'],
    queryFn: () => api.get('/settings/leave-policy').then(r => r.data),
  })
  const [form, setForm] = useState<EffectivePolicy | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (data?.data) setForm(data.data.effective) }, [data])

  const save = useMutation({
    mutationFn: (policy: Record<string, unknown> | null) => api.put('/settings/leave-policy', { policy }),
    onSuccess: () => {
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['settings-leave-policy'] })
    },
  })

  const view = data?.data
  if (!view || !form) return null

  const set = <K extends keyof EffectivePolicy>(k: K, v: EffectivePolicy[K]) => { setSaved(false); setForm({ ...form, [k]: v }) }
  const submit = () => save.mutate({
    accrualMode: form.accrualMode,
    daysPerMonth: form.daysPerMonth,
    calendarDaysPerWorkingDay: form.calendarDaysPerWorkingDay,
    allowanceMethod: form.allowanceMethod,
    carryOver: form.carryOver,
    balanceCheck: form.balanceCheck,
    maxAdvanceDays: form.maxAdvanceDays,
    leaveTypeCode: form.leaveTypeCode,
  })

  const card = 'rounded-xl border border-border bg-card p-4 space-y-3'
  const inputCls = 'w-full min-w-0 rounded-lg border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring'
  const apiError = (save.error as { response?: { data?: { error?: string; details?: Array<{ message: string }> } } } | null)
    ?.response?.data
  const field = (label: string, input: React.ReactNode, hint?: string) => (
    <label className="text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      {input}
      {hint && <span className="mt-0.5 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">{t('leavePolicy.title')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(view.tenantPolicy ? 'leavePolicy.sourceTenant' : 'leavePolicy.sourcePack', { pack: view.legislationPackCode })}
          </p>
        </div>
        {view.tenantPolicy && (
          <button onClick={() => save.mutate(null)} disabled={save.isPending}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">
            <RotateCcw className="h-3.5 w-3.5" />{t('leavePolicy.reset')}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field(t('leavePolicy.accrualMode'), (
          <select value={form.accrualMode} className={inputCls}
            onChange={e => set('accrualMode', e.target.value as EffectivePolicy['accrualMode'])}>
            <option value="monthly">{t('leavePolicy.accrual.monthly')}</option>
            <option value="manual">{t('leavePolicy.accrual.manual')}</option>
          </select>
        ))}
        {field(t('leavePolicy.daysPerMonth'), (
          <input type="number" min={form.legalDaysPerMonth ?? 0} step="0.1" value={form.daysPerMonth} className={inputCls}
            onChange={e => set('daysPerMonth', num(e.target.value))} />
        ), form.legalDaysPerMonth != null ? t('leavePolicy.legalMin', { n: form.legalDaysPerMonth }) : undefined)}
        {field(t('leavePolicy.balanceCheck'), (
          <select value={form.balanceCheck} className={inputCls}
            onChange={e => set('balanceCheck', e.target.value as EffectivePolicy['balanceCheck'])}>
            <option value="block">{t('leavePolicy.check.block')}</option>
            <option value="warn">{t('leavePolicy.check.warn')}</option>
            <option value="off">{t('leavePolicy.check.off')}</option>
          </select>
        ))}
        {field(t('leavePolicy.maxAdvanceDays'), (
          <input type="number" min={0} max={60} step="0.5" value={form.maxAdvanceDays} className={inputCls}
            onChange={e => set('maxAdvanceDays', num(e.target.value))} />
        ))}
        {field(t('leavePolicy.allowanceMethod'), (
          <select value={form.allowanceMethod} className={inputCls}
            onChange={e => set('allowanceMethod', e.target.value as Method)}>
            <option value="most_favourable">{t('leavePolicy.method.most_favourable')}</option>
            <option value="average_calendar">{t('leavePolicy.method.average_calendar')}</option>
            <option value="one_twelfth">{t('leavePolicy.method.one_twelfth')}</option>
          </select>
        ), t('leavePolicy.allowanceHint'))}
        {field(t('leavePolicy.calendarFactor'), (
          <input type="number" min={1} max={2} step="0.01" value={form.calendarDaysPerWorkingDay} className={inputCls}
            onChange={e => set('calendarDaysPerWorkingDay', num(e.target.value))} />
        ))}
        {field(t('leavePolicy.leaveTypeCode'), (
          <input type="text" maxLength={20} value={form.leaveTypeCode} className={inputCls}
            onChange={e => set('leaveTypeCode', e.target.value.trim())} />
        ))}
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={form.carryOver} onChange={e => set('carryOver', e.target.checked)} />
          {t('leavePolicy.carryOver')}
        </label>
      </div>

      {form.seniorityDays.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('leavePolicy.seniority')}{' '}
          {form.seniorityDays.map(s => t('leavePolicy.seniorityTier', { years: s.minYears, days: s.days })).join(' · ')}
        </p>
      )}

      {apiError && <p className="text-xs text-red-600">{apiError.details?.map(d => d.message).join(' · ') || apiError.error}</p>}
      {saved && !save.isPending && <p className="text-xs text-emerald-600">{t('leavePolicy.saved')}</p>}
      <div className="flex justify-end">
        <button onClick={submit} disabled={save.isPending}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
          {t('leavePolicy.save')}
        </button>
      </div>
    </div>
  )
}