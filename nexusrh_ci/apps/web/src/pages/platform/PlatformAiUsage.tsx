import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Sparkles, ArrowDownToLine, ArrowUpFromLine, MessageSquare, Coins } from 'lucide-react'

interface AiUsageRow {
  schemaName: string
  tenantId: string
  tenantName: string
  tenantSlug: string
  provider: string
  model: string
  period: string
  inputTokens: number
  outputTokens: number
  calls: number
  estCostEur: number
}

interface AiUsageTotals {
  inputTokens: number
  outputTokens: number
  calls: number
  estCostEur: number
}

interface AiUsageResponse {
  data: AiUsageRow[]
  totals: AiUsageTotals
  month: string | null
}

const nf = new Intl.NumberFormat('fr-FR')

function formatTokens(n: number): string {
  return nf.format(n)
}

function formatEur(n: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

export default function PlatformAiUsage() {
  const { t } = useTranslation('platform')
  const [month, setMonth] = useState('')

  const { data, isLoading } = useQuery<AiUsageResponse>({
    queryKey: ['platform-ai-usage', month],
    queryFn: () =>
      api.get('/platform/ai-usage', { params: month ? { month } : {} }).then(r => r.data),
  })

  const rows = data?.data ?? []
  const totals = data?.totals

  const kpis = [
    { label: t('aiUsage.kpi.inputTokens'),  value: totals ? formatTokens(totals.inputTokens) : '—',  icon: ArrowDownToLine },
    { label: t('aiUsage.kpi.outputTokens'), value: totals ? formatTokens(totals.outputTokens) : '—', icon: ArrowUpFromLine },
    { label: t('aiUsage.kpi.calls'),        value: totals ? formatTokens(totals.calls) : '—',        icon: MessageSquare },
    { label: t('aiUsage.kpi.estCost'),      value: totals ? formatEur(totals.estCostEur) : '—',      icon: Coins },
  ]

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            {t('aiUsage.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('aiUsage.subtitle')}</p>
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">{t('aiUsage.monthFilter')}</label>
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* KPI totals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Icon className="h-4 w-4" />
              <span className="text-xs font-medium">{label}</span>
            </div>
            <p className="mt-2 text-xl font-bold font-mono">{value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="p-4">{t('aiUsage.table.tenant')}</th>
                <th className="p-4">{t('aiUsage.table.provider')}</th>
                <th className="p-4">{t('aiUsage.table.model')}</th>
                <th className="p-4">{t('aiUsage.table.period')}</th>
                <th className="p-4 text-right">{t('aiUsage.table.inputTokens')}</th>
                <th className="p-4 text-right">{t('aiUsage.table.outputTokens')}</th>
                <th className="p-4 text-right">{t('aiUsage.table.calls')}</th>
                <th className="p-4 text-right">{t('aiUsage.table.estCost')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr key={`${r.tenantId}-${r.provider}-${r.model}-${r.period}-${i}`} className="hover:bg-muted/40">
                  <td className="p-4">
                    <p className="font-medium">{r.tenantName}</p>
                    <p className="text-xs text-muted-foreground">{r.tenantSlug}</p>
                  </td>
                  <td className="p-4 uppercase text-xs font-medium">{r.provider}</td>
                  <td className="p-4">
                    <code className="text-xs text-muted-foreground">{r.model}</code>
                  </td>
                  <td className="p-4 text-muted-foreground">{r.period}</td>
                  <td className="p-4 text-right font-mono">{formatTokens(r.inputTokens)}</td>
                  <td className="p-4 text-right font-mono">{formatTokens(r.outputTokens)}</td>
                  <td className="p-4 text-right font-mono">{formatTokens(r.calls)}</td>
                  <td className="p-4 text-right font-mono">{formatEur(r.estCostEur)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-12 text-center text-muted-foreground">
                    <Sparkles className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p>{t('aiUsage.empty')}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
