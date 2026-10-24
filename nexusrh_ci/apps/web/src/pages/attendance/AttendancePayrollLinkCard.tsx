import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'

/** Paramétrage du lien badgeuse → paie (miroir de attendance-payroll.service). */
export interface PayrollLinkSettings {
  enabled: boolean
  deductUnjustifiedAbsences: boolean
  absenceDivisor: 'working_days' | 'calendar_30'
  deductLateness: boolean
  latenessMinPerOccurrenceMin: number
  latenessMonthlyAllowanceMin: number
  latenessRounding: 'exact' | 'quarter_hour_down'
  monthlyHours: number
  suspendAttendanceBonusOnUnjustified: boolean
  maxPercentOfBase: number
}

const FIELD = 'w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm disabled:opacity-50'

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string; issues?: { message: string }[] } } }
  return e.response?.data?.issues?.[0]?.message ?? e.response?.data?.error ?? fallback
}

export default function AttendancePayrollLinkCard() {
  const { t } = useTranslation('attendance')
  const qc = useQueryClient()
  const [form, setForm] = useState<PayrollLinkSettings | null>(null)
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)

  const q = useQuery({
    queryKey: ['attendance', 'payroll-link'],
    queryFn: async () => (await api.get('/attendance/payroll-link')).data.data as PayrollLinkSettings,
  })
  useEffect(() => { if (q.data) setForm(q.data) }, [q.data])

  const save = useMutation({
    mutationFn: async () => { await api.put('/attendance/payroll-link', form) },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['attendance', 'payroll-link'] })
      setFlash({ ok: true, msg: t('payrollLink.saved') })
    },
    onError: (err) => setFlash({ ok: false, msg: errorMessage(err, t('payrollLink.saveError')) }),
  })

  const set = <K extends keyof PayrollLinkSettings>(k: K, v: PayrollLinkSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f))

  const off = !form?.enabled

  return (
    <section className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">{t('payrollLink.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('payrollLink.intro')}</p>
      </div>
      {q.isLoading && <p className="text-sm text-muted-foreground">{t('config.loading')}</p>}
      {q.isError && <p className="text-sm text-destructive">{t('config.loadError')}</p>}
      {form && (
        <>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            {t('payrollLink.enabled')}
          </label>
          {off && <p className="text-xs text-muted-foreground">{t('payrollLink.disabledHint')}</p>}

          <fieldset disabled={off} className="space-y-3">
            <div className="space-y-2 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.deductUnjustifiedAbsences}
                  onChange={(e) => set('deductUnjustifiedAbsences', e.target.checked)} />
                {t('payrollLink.deductUnjustifiedAbsences')}
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('payrollLink.absenceDivisor')}</span>
                  <select value={form.absenceDivisor} className={FIELD} disabled={off || !form.deductUnjustifiedAbsences}
                    onChange={(e) => set('absenceDivisor', e.target.value as PayrollLinkSettings['absenceDivisor'])}>
                    <option value="working_days">{t('payrollLink.divisor.working_days')}</option>
                    <option value="calendar_30">{t('payrollLink.divisor.calendar_30')}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 self-end text-sm">
                  <input type="checkbox" checked={form.suspendAttendanceBonusOnUnjustified}
                    onChange={(e) => set('suspendAttendanceBonusOnUnjustified', e.target.checked)} />
                  {t('payrollLink.suspendAttendanceBonus')}
                </label>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.deductLateness} onChange={(e) => set('deductLateness', e.target.checked)} />
                {t('payrollLink.deductLateness')}
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('payrollLink.latenessMinPerOccurrenceMin')}</span>
                  <input type="number" min={0} max={240} value={form.latenessMinPerOccurrenceMin} className={FIELD}
                    disabled={off || !form.deductLateness}
                    onChange={(e) => set('latenessMinPerOccurrenceMin', Number(e.target.value))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('payrollLink.latenessMonthlyAllowanceMin')}</span>
                  <input type="number" min={0} max={6000} value={form.latenessMonthlyAllowanceMin} className={FIELD}
                    disabled={off || !form.deductLateness}
                    onChange={(e) => set('latenessMonthlyAllowanceMin', Number(e.target.value))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('payrollLink.latenessRounding')}</span>
                  <select value={form.latenessRounding} className={FIELD} disabled={off || !form.deductLateness}
                    onChange={(e) => set('latenessRounding', e.target.value as PayrollLinkSettings['latenessRounding'])}>
                    <option value="exact">{t('payrollLink.rounding.exact')}</option>
                    <option value="quarter_hour_down">{t('payrollLink.rounding.quarter_hour_down')}</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">{t('payrollLink.monthlyHours')}</span>
                  <input type="number" min={1} max={300} step="0.01" value={form.monthlyHours} className={FIELD}
                    disabled={off || !form.deductLateness}
                    onChange={(e) => set('monthlyHours', Number(e.target.value))} />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t('payrollLink.latenessLegalNote')}</p>
            </div>

            <label className="block max-w-xs text-sm">
              <span className="mb-1 block text-muted-foreground">{t('payrollLink.maxPercentOfBase')}</span>
              <input type="number" min={0} max={100} value={form.maxPercentOfBase} className={FIELD}
                onChange={(e) => set('maxPercentOfBase', Number(e.target.value))} />
            </label>
          </fieldset>

          {flash && <p className={flash.ok ? 'text-sm text-emerald-600' : 'text-sm text-destructive'}>{flash.msg}</p>}
          <div className="flex justify-end">
            <button type="button" disabled={save.isPending} onClick={() => { setFlash(null); save.mutate() }}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {save.isPending ? t('config.saving') : t('config.save')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}