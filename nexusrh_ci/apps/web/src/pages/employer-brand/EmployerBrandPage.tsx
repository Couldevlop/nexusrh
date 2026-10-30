/**
 * Marque employeur — Lot 1 : tableau de bord AGRÉGÉ (GET /employer-brand/overview).
 *
 * Valorise les données déjà présentes dans NexusRH : attractivité (candidatures
 * par source / par offre, part interne), efficacité du recrutement (délai de
 * pourvoi, pipeline) et fidélisation des recrues (rétention 3/12 mois, départs
 * précoces, types de départ). Aucune donnée nominative n'est affichée.
 *
 * Accès : admin, hr_manager, dg, readonly (RoleGuard + ModuleGuard employer_brand).
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Megaphone, Users, Percent, Timer, UserPlus, ShieldCheck, LogOut, Info } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts'
import { api } from '@/lib/api'

// ── Contrat GET /employer-brand/overview ─────────────────────────────────────

interface RateBlock { eligible: number; retained: number; rate: number | null }
export interface EmployerBrandOverview {
  period: { from: string; to: string }
  legalEntityId: string | null
  legalEntities: Array<{ id: string; name: string }>
  attractiveness: {
    totalApplications: number
    internalApplications: number
    internalRate: number | null
    bySource: Array<{ source: string; count: number }>
    byJob: Array<{ jobId: string; title: string; applications: number; internal: number }>
  }
  timeToFill: { filledJobs: number; medianDays: number | null; averageDays: number | null }
  pipeline: { total: number; byStage: Array<{ stage: string; count: number }> }
  retention: {
    hires: number
    retention3m: RateBlock
    retention12m: RateBlock
    departures: number
    earlyDepartures: number
    earlyDepartureRate: number | null
  }
  departureTypes: Array<{ type: string; count: number }>
}

const SOURCE_COLORS = ['#4F46E5', '#10B981', '#F59E0B', '#0EA5E9', '#94A3B8']
const STAGE_COLORS: Record<string, string> = {
  new: '#94A3B8', screening: '#0EA5E9', interview: '#6366F1', test: '#8B5CF6',
  offer: '#F59E0B', hired: '#10B981', rejected: '#EF4444',
}
const RETENTION_COLORS = ['#10B981', '#0EA5E9']
const DEPARTURE_COLOR = '#F97316'

function iso(d: Date): string { return d.toISOString().slice(0, 10) }
/** Période par défaut (identique à l'API) : 12 derniers mois jusqu'à aujourd'hui. */
export function defaultPeriod(today: Date = new Date()): { from: string; to: string } {
  const start = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate() + 1))
  return { from: iso(start), to: iso(today) }
}

export default function EmployerBrandPage() {
  const { t, i18n } = useTranslation('employerBrand')
  const initial = useMemo(() => defaultPeriod(), [])
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [legalEntityId, setLegalEntityId] = useState('')

  const q = useQuery({
    queryKey: ['employer-brand', 'overview', from, to, legalEntityId],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (legalEntityId) params.set('legalEntityId', legalEntityId)
      const res = await api.get(`/employer-brand/overview?${params.toString()}`)
      return (res.data as { data: EmployerBrandOverview }).data
    },
  })

  const d = q.data
  const nf = (n: number | null | undefined, suffix = '') =>
    n === null || n === undefined ? '—' : `${n.toLocaleString(i18n.language === 'en' ? 'en-US' : 'fr-FR')}${suffix}`

  const sourceChart = (d?.attractiveness.bySource ?? [])
    .map((s, i) => ({ name: t(`sources.${s.source}`), value: s.count, fill: SOURCE_COLORS[i % SOURCE_COLORS.length] ?? '#94A3B8' }))
  const stageChart = (d?.pipeline.byStage ?? [])
    .map((s) => ({ name: t(`stages.${s.stage}`), value: s.count, fill: STAGE_COLORS[s.stage] ?? '#94A3B8' }))
  const retentionChart = d ? [
    { name: t('retention.threeMonths'), value: d.retention.retention3m.rate ?? 0, eligible: d.retention.retention3m.eligible },
    { name: t('retention.twelveMonths'), value: d.retention.retention12m.rate ?? 0, eligible: d.retention.retention12m.eligible },
  ] : []
  const departureChart = (d?.departureTypes ?? []).filter((x) => x.count > 0)
    .map((x) => ({ name: t(`departureTypes.${x.type}`), value: x.count }))

  const hasApplications = (d?.attractiveness.totalApplications ?? 0) > 0
  const hasPipeline = (d?.pipeline.total ?? 0) > 0
  const hasRetention = (d?.retention.retention3m.eligible ?? 0) + (d?.retention.retention12m.eligible ?? 0) > 0
  const isEmpty = !!d && !hasApplications && !hasPipeline && (d.retention.hires === 0) && (d.retention.departures === 0)

  const kpis = d ? [
    { key: 'applications', icon: Users, value: nf(d.attractiveness.totalApplications), sub: t('kpis.applicationsSub') },
    { key: 'internalRate', icon: Percent, value: nf(d.attractiveness.internalRate, ' %'), sub: t('kpis.internalRateSub', { count: d.attractiveness.internalApplications }) },
    { key: 'timeToFill', icon: Timer, value: d.timeToFill.medianDays === null ? '—' : t('kpis.days', { count: d.timeToFill.medianDays }), sub: d.timeToFill.averageDays === null ? t('kpis.timeToFillNone') : t('kpis.timeToFillSub', { avg: d.timeToFill.averageDays, count: d.timeToFill.filledJobs }) },
    { key: 'hires', icon: UserPlus, value: nf(d.retention.hires), sub: t('kpis.hiresSub') },
    { key: 'retention12m', icon: ShieldCheck, value: nf(d.retention.retention12m.rate, ' %'), sub: t('kpis.retentionSub', { retained: d.retention.retention12m.retained, eligible: d.retention.retention12m.eligible }) },
    { key: 'earlyDepartures', icon: LogOut, value: nf(d.retention.earlyDepartures), sub: d.retention.earlyDepartureRate === null ? t('kpis.earlyNone') : t('kpis.earlySub', { rate: d.retention.earlyDepartureRate, count: d.retention.departures }) },
  ] : []

  const emptyBox = (msg: string) => (
    <div className="flex h-52 items-center justify-center px-4 text-center text-sm text-muted-foreground">{msg}</div>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Megaphone className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div>
            <label htmlFor="eb-from" className="block text-xs font-medium text-muted-foreground">{t('filters.from')}</label>
            <input id="eb-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
              className="mt-1 rounded-lg border border-input bg-background px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="eb-to" className="block text-xs font-medium text-muted-foreground">{t('filters.to')}</label>
            <input id="eb-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              className="mt-1 rounded-lg border border-input bg-background px-2 py-1.5 text-sm" />
          </div>
          {(d?.legalEntities.length ?? 0) > 0 && (
            <div>
              <label htmlFor="eb-entity" className="block text-xs font-medium text-muted-foreground">{t('filters.legalEntity')}</label>
              <select id="eb-entity" value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}
                className="mt-1 rounded-lg border border-input bg-background px-2 py-1.5 text-sm">
                <option value="">{t('filters.allEntities')}</option>
                {d?.legalEntities.map((le) => <option key={le.id} value={le.id}>{le.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        <Info className="h-4 w-4 shrink-0" /> {t('privacyNote')}
      </div>

      {q.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
      {q.isError && <p role="alert" className="py-10 text-center text-sm text-destructive">{t('loadError')}</p>}

      {d && (
        <>
          {isEmpty && (
            <div className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              {t('emptyPeriod')}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {kpis.map((k) => (
              <div key={k.key} className="rounded-2xl border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <k.icon className="h-4 w-4" /> {t(`kpis.${k.key}`)}
                </div>
                <p className="mt-2 text-2xl font-bold" data-testid={`kpi-${k.key}`}>{k.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{k.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold mb-1">{t('charts.bySource')}</h2>
              <p className="text-xs text-muted-foreground mb-4">{t('charts.bySourceSub')}</p>
              {hasApplications ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={sourceChart} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={130} />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" name={t('charts.applications')} radius={[0, 3, 3, 0]}>
                      {sourceChart.map((e, i) => <Cell key={i} fill={e.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : emptyBox(t('charts.noApplications'))}
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold mb-1">{t('charts.pipeline')}</h2>
              <p className="text-xs text-muted-foreground mb-4">{t('charts.pipelineSub')}</p>
              {hasPipeline ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={stageChart} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" name={t('charts.applications')} radius={[3, 3, 0, 0]}>
                      {stageChart.map((e, i) => <Cell key={i} fill={e.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : emptyBox(t('charts.noPipeline'))}
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold mb-1">{t('charts.retention')}</h2>
              <p className="text-xs text-muted-foreground mb-4">{t('charts.retentionSub')}</p>
              {hasRetention ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={retentionChart} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} unit=" %" />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} formatter={(v: number) => `${v} %`} />
                    <Bar dataKey="value" name={t('charts.retentionRate')} radius={[3, 3, 0, 0]}>
                      {retentionChart.map((_, i) => <Cell key={i} fill={RETENTION_COLORS[i % RETENTION_COLORS.length] ?? '#10B981'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : emptyBox(t('charts.noRetention'))}
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold mb-1">{t('charts.departureTypes')}</h2>
              <p className="text-xs text-muted-foreground mb-4">{t('charts.departureTypesSub')}</p>
              {departureChart.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={departureChart} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={150} />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" name={t('charts.departures')} fill={DEPARTURE_COLOR} radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : emptyBox(t('charts.noDepartures'))}
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="font-semibold mb-1">{t('jobs.title')}</h2>
            <p className="text-xs text-muted-foreground mb-4">{t('jobs.subtitle')}</p>
            {d.attractiveness.byJob.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('charts.noApplications')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 font-medium">{t('jobs.job')}</th>
                    <th className="py-2 text-right font-medium">{t('jobs.applications')}</th>
                    <th className="py-2 text-right font-medium">{t('jobs.internal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attractiveness.byJob.map((j) => (
                    <tr key={j.jobId} className="border-b border-border/50 last:border-0">
                      <td className="py-2">{j.title}</td>
                      <td className="py-2 text-right font-semibold">{j.applications}</td>
                      <td className="py-2 text-right text-muted-foreground">{j.internal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
