import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import {
  X, Loader2, Calculator, TrendingUp, History, Eye, ChevronDown, ChevronRight,
  BookOpen, AlertCircle, CheckCircle2, ArrowUp, ArrowDown, Minus
} from 'lucide-react'

interface ExplainedLine {
  code: string; label: string
  type: 'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution'
  base: number; amount: number
  formulaHuman: string
  rate?: number
  baseLabel?: string
  legalReference?: string
  category: string
}

interface TransparencyData {
  slip: {
    id: string; month: string
    baseSalary: number; grossSalary: number; netPayable: number
    totalCnpsSal: number; totalCnpsPat: number; its: number
    employerCost: number; totalDeductions: number
    generatedAt: string | null; viewedAt: string | null
    paymentStatus: string; paymentMethod: string
    paymentReference: string | null; paidAt: string | null
  }
  employee: {
    id: string; firstName: string; lastName: string
    cnpsNumber: string | null; nni: string | null; jobTitle: string | null
  }
  period: {
    id: string; status: string
    initiatedAt: string | null; closedAt: string | null
  }
  lines: ExplainedLine[]
  totals: { earnings: number; employeeContributions: number; employerContributions: number }
  comparison: Array<{ month: string; grossSalary: number; netPayable: number; totalCnpsSal: number; its: number }>
  audit: Array<{ action: string; entity: string; createdAt: string; actorName: string | null; changes: unknown }>
}

const CATEGORY_COLOR: Record<string, string> = {
  salary:   'border-blue-200 bg-blue-50 text-blue-900',
  premium:  'border-violet-200 bg-violet-50 text-violet-900',
  overtime: 'border-amber-200 bg-amber-50 text-amber-900',
  leave:    'border-teal-200 bg-teal-50 text-teal-900',
  cnps:     'border-orange-200 bg-orange-50 text-orange-900',
  tax:      'border-rose-200 bg-rose-50 text-rose-900',
  health:   'border-emerald-200 bg-emerald-50 text-emerald-900',
  advance:  'border-gray-200 bg-gray-50 text-gray-900',
  other:    'border-gray-200 bg-gray-50 text-gray-900',
}

function ExpandableLine({ line }: { line: ExplainedLine }) {
  const { t } = useTranslation('payroll')
  const [open, setOpen] = useState(false)
  const isNegative = line.type !== 'earning'
  const colorCls = CATEGORY_COLOR[line.category] ?? CATEGORY_COLOR.other

  return (
    <div className={`rounded-lg border ${colorCls} overflow-hidden`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-black/5 transition"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-white/60">{line.code}</span>
            <span className="font-medium text-sm truncate">{line.label}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className={`font-mono font-semibold text-sm ${isNegative ? 'text-rose-700' : 'text-green-700'}`}>
            {isNegative ? '−' : ''}{formatFCFA(Math.abs(line.amount))}
          </p>
          {line.type === 'employer_contribution' && (
            <p className="text-[10px] text-muted-foreground">{t('transparency.employerPart')}</p>
          )}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-current/10 space-y-3 bg-white/40">
          <div>
            <p className="text-[11px] uppercase tracking-wider font-semibold opacity-70">{t('transparency.line.formula')}</p>
            <p className="text-sm mt-1">{line.formulaHuman}</p>
          </div>
          {line.baseLabel && (
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold opacity-70">{t('transparency.line.calcBase')}</p>
              <p className="text-sm mt-1">{line.baseLabel}</p>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="rounded bg-white/60 p-2">
              <p className="opacity-60">{t('transparency.line.appliedBase')}</p>
              <p className="font-mono font-semibold mt-0.5">{formatFCFA(line.base)}</p>
            </div>
            {line.rate !== undefined && (
              <div className="rounded bg-white/60 p-2">
                <p className="opacity-60">{t('transparency.line.rate')}</p>
                <p className="font-mono font-semibold mt-0.5">{(line.rate * 100).toFixed(2)} %</p>
              </div>
            )}
            <div className="rounded bg-white/60 p-2">
              <p className="opacity-60">{t('transparency.line.result')}</p>
              <p className="font-mono font-semibold mt-0.5">{formatFCFA(Math.abs(line.amount))}</p>
            </div>
          </div>
          {line.legalReference && (
            <div className="flex items-start gap-2 rounded bg-white/60 p-2 text-xs">
              <BookOpen className="h-3.5 w-3.5 mt-0.5 shrink-0 opacity-70" />
              <p className="italic opacity-90">{line.legalReference}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DeltaIndicator({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return <Minus className="inline h-3 w-3 text-muted-foreground" />
  const delta = ((current - previous) / previous) * 100
  if (Math.abs(delta) < 0.5) return <Minus className="inline h-3 w-3 text-muted-foreground" />
  const up = delta > 0
  const Icon = up ? ArrowUp : ArrowDown
  const color = up ? 'text-amber-600' : 'text-blue-600'
  return (
    <span className={`inline-flex items-center text-[11px] ${color}`}>
      <Icon className="h-3 w-3" /> {Math.abs(delta).toFixed(1)} %
    </span>
  )
}

export default function PaySlipTransparentModal({
  slipId, onClose,
}: { slipId: string; onClose: () => void }) {
  const { t } = useTranslation('payroll')
  const [tab, setTab] = useState<'detail' | 'comparison' | 'audit'>('detail')

  const { data, isLoading, error } = useQuery<TransparencyData>({
    queryKey: ['payslip-transparency', slipId],
    queryFn: () => api.get(`/payroll/payslips/${slipId}/transparency`).then(r => r.data as TransparencyData),
  })

  const errorMsg = (error as { response?: { data?: { error?: string } } })?.response?.data?.error

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[92vh] overflow-hidden rounded-xl border border-border bg-card shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-gradient-to-r from-primary/5 to-secondary/5">
          <div>
            <div className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-semibold">{t('transparency.title')}</h3>
            </div>
            {data && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {data.employee.firstName} {data.employee.lastName}
                {data.employee.jobTitle && ` · ${data.employee.jobTitle}`}
                {' · '}
                <span className="capitalize">{formatMonth(data.slip.month)}</span>
                {data.employee.cnpsNumber && ` · ${t('transparency.headerSuffixCnps', { number: data.employee.cnpsNumber })}`}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : errorMsg ? (
          <div className="flex items-start gap-2 m-6 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {errorMsg}
          </div>
        ) : data ? (
          <>
            {/* KPI bandeau */}
            <div className="grid grid-cols-4 gap-3 px-6 py-4 border-b border-border bg-muted/20">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('transparency.kpiGross')}</p>
                <p className="text-lg font-bold font-mono mt-0.5">{formatFCFA(data.slip.grossSalary)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('transparency.kpiCnpsSal')}</p>
                <p className="text-lg font-bold font-mono mt-0.5 text-orange-600">−{formatFCFA(data.slip.totalCnpsSal)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('transparency.kpiIts')}</p>
                <p className="text-lg font-bold font-mono mt-0.5 text-rose-600">−{formatFCFA(data.slip.its)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('transparency.kpiNet')}</p>
                <p className="text-lg font-bold font-mono mt-0.5 text-green-700">{formatFCFA(data.slip.netPayable)}</p>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border px-6 bg-card">
              {([
                { id: 'detail',     label: t('transparency.tabs.detail'),     Icon: Calculator },
                { id: 'comparison', label: t('transparency.tabs.comparison'), Icon: TrendingUp },
                { id: 'audit',      label: t('transparency.tabs.audit'),      Icon: History },
              ] as const).map(tabItem => (
                <button
                  key={tabItem.id}
                  onClick={() => setTab(tabItem.id)}
                  className={`px-4 py-3 text-sm font-medium flex items-center gap-2 border-b-2 -mb-px transition ${
                    tab === tabItem.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <tabItem.Icon className="h-4 w-4" /> {tabItem.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {tab === 'detail' && (
                <div className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    {t('transparency.detail.intro')}
                  </p>

                  {/* Gains */}
                  <section>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      {t('transparency.detail.earnings', { amount: formatFCFA(data.totals.earnings) })}
                    </h4>
                    <div className="space-y-2">
                      {data.lines.filter(l => l.type === 'earning').map(l => (
                        <ExpandableLine key={l.code} line={l} />
                      ))}
                    </div>
                  </section>

                  {/* Retenues salarié */}
                  <section>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      {t('transparency.detail.employeeDeductions', { amount: formatFCFA(data.totals.employeeContributions) })}
                    </h4>
                    <div className="space-y-2">
                      {data.lines.filter(l => l.type === 'employee_contribution' || l.type === 'deduction').map(l => (
                        <ExpandableLine key={l.code} line={l} />
                      ))}
                    </div>
                  </section>

                  {/* Cotisations employeur (informatif) */}
                  {data.lines.some(l => l.type === 'employer_contribution') && (
                    <section>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        {t('transparency.detail.employerContributions', { amount: formatFCFA(data.totals.employerContributions) })}
                      </h4>
                      <div className="space-y-2">
                        {data.lines.filter(l => l.type === 'employer_contribution').map(l => (
                          <ExpandableLine key={l.code} line={l} />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Récap final */}
                  <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
                    <div className="flex justify-between items-center mb-2 text-sm">
                      <span>{t('transparency.detail.grossSalary')}</span>
                      <span className="font-mono">{formatFCFA(data.slip.grossSalary)}</span>
                    </div>
                    <div className="flex justify-between items-center mb-2 text-sm text-rose-700">
                      <span>{t('transparency.detail.totalDeductions')}</span>
                      <span className="font-mono">−{formatFCFA(data.slip.totalDeductions)}</span>
                    </div>
                    <div className="flex justify-between items-center pt-2 border-t border-primary/20 text-base font-bold">
                      <span className="text-primary">{t('transparency.detail.netPayable')}</span>
                      <span className="font-mono text-primary">{formatFCFA(data.slip.netPayable)}</span>
                    </div>
                    <div className="mt-3 pt-3 border-t border-primary/10 text-xs text-muted-foreground flex justify-between">
                      <span>{t('transparency.detail.employerCost')}</span>
                      <span className="font-mono">{formatFCFA(data.slip.employerCost)}</span>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'comparison' && (
                <div className="space-y-4">
                  <p className="text-xs text-muted-foreground">
                    {t('transparency.comparison.intro')}
                  </p>
                  {data.comparison.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8">
                      <TrendingUp className="mx-auto h-8 w-8 opacity-30 mb-2" />
                      {t('transparency.comparison.empty')}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground text-xs uppercase tracking-wider">
                          <th className="py-2">{t('transparency.comparison.colMonth')}</th>
                          <th className="py-2 text-right">{t('transparency.comparison.colGross')}</th>
                          <th className="py-2 text-right">{t('transparency.comparison.colCnps')}</th>
                          <th className="py-2 text-right">{t('transparency.comparison.colIts')}</th>
                          <th className="py-2 text-right">{t('transparency.comparison.colNet')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-border bg-primary/5">
                          <td className="py-2 font-semibold capitalize">{t('transparency.comparison.current', { month: formatMonth(data.slip.month) })}</td>
                          <td className="py-2 text-right font-mono">{formatFCFA(data.slip.grossSalary)}</td>
                          <td className="py-2 text-right font-mono text-orange-600">{formatFCFA(data.slip.totalCnpsSal)}</td>
                          <td className="py-2 text-right font-mono text-rose-600">{formatFCFA(data.slip.its)}</td>
                          <td className="py-2 text-right font-mono font-bold text-green-700">{formatFCFA(data.slip.netPayable)}</td>
                        </tr>
                        {data.comparison.map((row, i) => {
                          const prev = i === 0 ? data.slip : data.comparison[i - 1]!
                          return (
                            <tr key={row.month} className="border-b border-border">
                              <td className="py-2 capitalize">{formatMonth(row.month)}</td>
                              <td className="py-2 text-right font-mono">
                                {formatFCFA(row.grossSalary)}
                                {' '}
                                <DeltaIndicator current={prev.grossSalary} previous={row.grossSalary} />
                              </td>
                              <td className="py-2 text-right font-mono text-orange-600">{formatFCFA(row.totalCnpsSal)}</td>
                              <td className="py-2 text-right font-mono text-rose-600">{formatFCFA(row.its)}</td>
                              <td className="py-2 text-right font-mono">
                                {formatFCFA(row.netPayable)}
                                {' '}
                                <DeltaIndicator current={prev.netPayable} previous={row.netPayable} />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {tab === 'audit' && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {t('transparency.audit.intro')}
                  </p>

                  <div className="rounded-lg border border-border p-3 space-y-2 text-sm bg-muted/20">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('transparency.audit.period')}</span>
                      <span className="capitalize">{formatMonth(data.slip.month)} · {data.period.status}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('transparency.audit.generatedAt')}</span>
                      <span>{data.slip.generatedAt ? new Date(data.slip.generatedAt).toLocaleString('fr-FR') : '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('transparency.audit.viewedByEmployee')}</span>
                      <span>{data.slip.viewedAt ? new Date(data.slip.viewedAt).toLocaleString('fr-FR') : t('transparency.audit.notYet')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('transparency.audit.payment')}</span>
                      <span className="flex items-center gap-1">
                        {data.slip.paymentStatus === 'paid' ? (
                          <><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> {t('transparency.audit.paid')}</>
                        ) : (
                          t('transparency.audit.pending')
                        )}
                        {data.slip.paymentMethod && ` · ${data.slip.paymentMethod.replace('_', ' ')}`}
                      </span>
                    </div>
                    {data.slip.paymentReference && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('transparency.audit.reference')}</span>
                        <span className="font-mono text-xs">{data.slip.paymentReference}</span>
                      </div>
                    )}
                  </div>

                  {data.audit.length === 0 ? (
                    <div className="text-center text-muted-foreground py-6 text-sm">
                      {t('transparency.audit.noEvents')}
                    </div>
                  ) : (
                    <ol className="space-y-2">
                      {data.audit.map((a, i) => (
                        <li key={i} className="flex gap-3 rounded-lg border border-border p-3 text-sm">
                          <div className="h-2 w-2 mt-1.5 shrink-0 rounded-full bg-primary" />
                          <div className="flex-1">
                            <p className="font-medium">{a.action} <span className="text-muted-foreground">· {a.entity}</span></p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {a.actorName ?? t('transparency.audit.system')} · {new Date(a.createdAt).toLocaleString('fr-FR')}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
