import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, formatFCFA, formatDate, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Users, CreditCard, Calendar, ClipboardCheck, Briefcase,
  BookOpen, Receipt, ArrowUpRight, ArrowDownRight, Eye,
  CheckCircle2, Clock, AlertTriangle,
} from 'lucide-react'
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, BarChart,
} from 'recharts'

// ── Types (contrat GET /dg/overview) ─────────────────────────────────────────

interface DgKpis {
  activeEmployees: number
  payrollMassFcfa: number
  payrollNetFcfa: number
  payrollEvolutionPct: number | null
  absentToday: number
  absenteeismRatePct: number
  pendingApprovals: number
  pendingAbsences: number
  pendingExpenses: number
  openJobs: number
  totalApplications: number
  upcomingTrainingSessions: number
  activeEnrollments: number
  expensesApprovedThisMonthFcfa: number
}

interface DgRecentPeriod {
  month: string
  status: string
  validated: boolean
  closedAt: string | null
  closedBy: string | null
  totalGross: number
  totalNet: number
}

interface DgPayrollPoint { month: string; gross: number; net: number; cnps: number; its: number }
interface DgHeadcountPoint { month: string; count: number }
interface DgDepartmentCount { department: string; count: number }
interface DgAbsenceByType { type: string; count: number; days: number }
interface DgApplicationsByStage { stage: string; count: number }

interface DgEmployeeAtRisk {
  employee: string
  jobTitle: string
  retentionRiskScore: number | null
  burnoutRisk: 'low' | 'medium' | 'high' | null
}

interface DgOverview {
  kpis: DgKpis
  payroll: { recentPeriods: DgRecentPeriod[]; series: DgPayrollPoint[] }
  headcount: { byDepartment: DgDepartmentCount[]; series: DgHeadcountPoint[] }
  absences: { byType: DgAbsenceByType[] }
  recruitment: { applicationsByStage: DgApplicationsByStage[] }
  employeesAtRisk: DgEmployeeAtRisk[]
}

// ── Couleurs ──────────────────────────────────────────────────────────────────

const PALETTE = ['#4F46E5', '#F97316', '#10B981', '#8B5CF6', '#EF4444', '#0EA5E9', '#F59E0B', '#EC4899']

const BURNOUT_BADGE: Record<'low' | 'medium' | 'high', string> = {
  low:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  high:   'bg-red-50 text-red-700 border-red-200',
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DgDashboardPage() {
  const { t } = useTranslation('dg')
  const tenantConfig = useAuthStore(s => s.tenantConfig)

  const { data, isLoading, isError } = useQuery<{ data: DgOverview }>({
    queryKey: ['dg-overview'],
    queryFn: () => api.get('/dg/overview').then(r => r.data),
  })

  const overview = data?.data
  const kpis = overview?.kpis

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm">{t('overview.loading')}</p>
      </div>
    )
  }

  if (isError || !overview || !kpis) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
        <AlertTriangle className="h-10 w-10 opacity-30" />
        <p className="text-sm font-medium">{t('overview.loadError')}</p>
      </div>
    )
  }

  const evolution = kpis.payrollEvolutionPct

  const headcountChart = overview.headcount.series.map(p => ({
    mois: formatMonth(p.month).slice(0, 3),
    effectifs: p.count,
  }))

  const payrollChart = overview.payroll.series.map(p => ({
    mois: formatMonth(p.month).slice(0, 3),
    brut: Math.round(p.gross / 1_000),
    net:  Math.round(p.net  / 1_000),
    cnps: Math.round(p.cnps / 1_000),
    its:  Math.round(p.its  / 1_000),
  }))

  const absencesPie = overview.absences.byType
    .filter(a => a.count > 0)
    .map((a, i) => ({ name: a.type, value: a.count, days: a.days, fill: PALETTE[i % PALETTE.length] ?? '#4F46E5' }))

  const deptChart = overview.headcount.byDepartment.map((d, i) => ({
    name: d.department.length > 14 ? `${d.department.slice(0, 14)}…` : d.department,
    effectifs: d.count,
    fill: PALETTE[i % PALETTE.length] ?? '#4F46E5',
  }))

  const pipelineChart = overview.recruitment.applicationsByStage.map((s, i) => ({
    name: s.stage,
    candidatures: s.count,
    fill: PALETTE[i % PALETTE.length] ?? '#4F46E5',
  }))

  const recentPeriods = overview.payroll.recentPeriods.slice(0, 3)
  const atRisk = overview.employeesAtRisk

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5 lg:p-8 space-y-5 bg-background min-h-full">

      {/* ── En-tête ──────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2.5 mt-0.5">
          <Eye className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{t('overview.title')}</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            {tenantConfig?.name ?? ''} · {t('overview.subtitle')}
            {' · '}{new Date().toLocaleDateString('fr-CI', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      </div>

      {/* ── KPI Cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t('overview.kpi.activeEmployees')}
          value={String(kpis.activeEmployees)}
          icon={Users} color="blue"
          sub={t('overview.kpi.activeEmployeesSub', { count: overview.headcount.byDepartment.length })}
        />
        <KpiCard
          label={t('overview.kpi.payrollMass')}
          value={formatFCFA(kpis.payrollMassFcfa)}
          icon={CreditCard} color="orange"
          sub={t('overview.kpi.payrollMassSub', { net: formatFCFA(kpis.payrollNetFcfa) })}
          badge={evolution !== null ? (
            <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
              evolution >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
            }`}>
              {evolution >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {evolution > 0 ? '+' : ''}{evolution.toFixed(1)} %
            </span>
          ) : undefined}
        />
        <KpiCard
          label={t('overview.kpi.absentToday')}
          value={String(kpis.absentToday)}
          icon={Calendar} color="red"
          sub={t('overview.kpi.absenteeismRate', { rate: kpis.absenteeismRatePct.toFixed(1) })}
        />
        <KpiCard
          label={t('overview.kpi.pendingApprovals')}
          value={String(kpis.pendingApprovals)}
          icon={ClipboardCheck} color="amber"
          sub={t('overview.kpi.pendingDetail', { absences: kpis.pendingAbsences, expenses: kpis.pendingExpenses })}
        />
        <KpiCard
          label={t('overview.kpi.openJobs')}
          value={String(kpis.openJobs)}
          icon={Briefcase} color="violet"
          sub={t('overview.kpi.applications', { count: kpis.totalApplications })}
        />
        <KpiCard
          label={t('overview.kpi.trainings')}
          value={String(kpis.upcomingTrainingSessions)}
          icon={BookOpen} color="teal"
          sub={t('overview.kpi.enrollments', { count: kpis.activeEnrollments })}
        />
        <KpiCard
          label={t('overview.kpi.expensesApproved')}
          value={formatFCFA(kpis.expensesApprovedThisMonthFcfa)}
          icon={Receipt} color="emerald"
          sub={t('overview.kpi.expensesApprovedSub')}
        />
        <KpiCard
          label={t('overview.series.net')}
          value={formatFCFA(kpis.payrollNetFcfa)}
          icon={CreditCard} color="green"
          sub={t('overview.kpi.evolutionSub')}
        />
      </div>

      {/* ── Graphiques ligne 1 : effectifs + paie ────────────── */}
      <div className="grid gap-6 lg:grid-cols-3">

        {/* LineChart effectifs 12 mois */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold mb-1">{t('overview.charts.headcount')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('overview.charts.headcountSub')}</p>
          {headcountChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={headcountChart} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="mois" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="effectifs" name={t('overview.series.employees')}
                  stroke="#4F46E5" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-52 items-center justify-center text-muted-foreground text-sm">{t('overview.charts.noData')}</div>
          )}
        </div>

        {/* ComposedChart paie 12 mois */}
        <div className="lg:col-span-2 rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold mb-1">{t('overview.charts.payroll')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('overview.charts.payrollSub')}</p>
          {payrollChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={payrollChart} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="mois" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }}
                  tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}M` : `${v}k`} />
                <Tooltip
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number, n: string) => [t('overview.charts.tooltipThousandsFcfa', { value: v.toLocaleString('fr-CI') }), n]}
                />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="brut" name={t('overview.series.gross')} fill="#4F46E5" radius={[3, 3, 0, 0]} />
                <Bar dataKey="net"  name={t('overview.series.net')}  fill="#10B981" radius={[3, 3, 0, 0]} />
                <Line dataKey="cnps" name={t('overview.series.cnps')} stroke="#F97316" strokeWidth={2} dot={{ r: 3 }} type="monotone" />
                <Line dataKey="its"  name={t('overview.series.its')}  stroke="#8B5CF6" strokeWidth={2} dot={{ r: 3 }} strokeDasharray="4 2" type="monotone" />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-52 items-center justify-center text-muted-foreground text-sm">{t('overview.charts.noData')}</div>
          )}
        </div>
      </div>

      {/* ── Graphiques ligne 2 : absences + départements + pipeline ── */}
      <div className="grid gap-6 lg:grid-cols-3">

        {/* PieChart absences par type */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold mb-1">{t('overview.charts.absencesByType')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('overview.charts.absencesByTypeSub')}</p>
          {absencesPie.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={absencesPie} cx="50%" cy="50%" innerRadius={45} outerRadius={70}
                    dataKey="value" paddingAngle={3}>
                    {absencesPie.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2 mt-2">
                {absencesPie.map(d => (
                  <div key={d.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.fill }} />
                      <span className="truncate text-muted-foreground">{d.name}</span>
                    </div>
                    <span className="font-medium shrink-0 ml-2">
                      {d.value} · {t('overview.charts.daysCount', { count: d.days })}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">{t('overview.charts.noData')}</div>
          )}
        </div>

        {/* BarChart effectifs par département */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold mb-1">{t('overview.charts.byDepartment')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('overview.charts.byDepartmentSub')}</p>
          {deptChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={deptChart} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={96} />
                <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="effectifs" name={t('overview.series.employees')} radius={[0, 3, 3, 0]}>
                  {deptChart.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-52 items-center justify-center text-muted-foreground text-sm">{t('overview.charts.noData')}</div>
          )}
        </div>

        {/* BarChart pipeline candidatures par étape */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold mb-1">{t('overview.charts.pipeline')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('overview.charts.pipelineSub')}</p>
          {pipelineChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={pipelineChart} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={48} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="candidatures" name={t('overview.series.applications')} radius={[3, 3, 0, 0]}>
                  {pipelineChart.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-52 items-center justify-center text-muted-foreground text-sm">{t('overview.charts.noData')}</div>
          )}
        </div>
      </div>

      {/* ── Panneaux : statut paie + employés à surveiller ───── */}
      <div className="grid gap-6 lg:grid-cols-3">

        {/* Statut de la paie */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="font-semibold mb-1">{t('overview.payrollStatus.title')}</h2>
          <p className="text-xs text-muted-foreground mb-4">{t('overview.payrollStatus.subtitle')}</p>
          {recentPeriods.length > 0 ? (
            <div className="space-y-3">
              {recentPeriods.map(p => (
                <div key={p.month} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium capitalize">{formatMonth(p.month)}</span>
                    {p.validated ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" /> {t('overview.payrollStatus.validated')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                        <Clock className="h-3 w-3" /> {t('overview.payrollStatus.inProgress')}
                      </span>
                    )}
                  </div>
                  {p.validated && p.closedBy && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('overview.payrollStatus.validatedBy', {
                        name: p.closedBy,
                        date: p.closedAt ? formatDate(p.closedAt) : '—',
                      })}
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {t('overview.payrollStatus.gross')} : <span className="font-mono font-medium text-foreground">{formatFCFA(p.totalGross)}</span>
                    </span>
                    <span className="text-muted-foreground">
                      {t('overview.payrollStatus.net')} : <span className="font-mono font-medium text-emerald-700">{formatFCFA(p.totalNet)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">{t('overview.payrollStatus.empty')}</div>
          )}
        </div>

        {/* Employés à surveiller */}
        <div className="lg:col-span-2 rounded-2xl border bg-card shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b">
            <h2 className="font-semibold">{t('overview.atRisk.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('overview.atRisk.subtitle')}</p>
          </div>
          {atRisk.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 text-left text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="px-5 py-3">{t('overview.atRisk.employee')}</th>
                    <th className="px-5 py-3">{t('overview.atRisk.jobTitle')}</th>
                    <th className="px-5 py-3">{t('overview.atRisk.burnout')}</th>
                    <th className="px-5 py-3 text-right">{t('overview.atRisk.retention')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {atRisk.map((e, i) => (
                    <tr key={`${e.employee}-${i}`} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                      <td className="px-5 py-3 font-medium">{e.employee}</td>
                      <td className="px-5 py-3 text-muted-foreground">{e.jobTitle}</td>
                      <td className="px-5 py-3">
                        {e.burnoutRisk ? (
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BURNOUT_BADGE[e.burnoutRisk]}`}>
                            {t(`overview.atRisk.${e.burnoutRisk}`)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('overview.atRisk.na')}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right font-mono">
                        {e.retentionRiskScore !== null
                          ? `${Math.round(e.retentionRiskScore * 100)} %`
                          : t('overview.atRisk.na')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">{t('overview.atRisk.empty')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Composants ───────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, { bg: string; text: string; icon: string }> = {
  blue:    { bg: 'bg-blue-50',    text: 'text-blue-700',    icon: 'text-blue-500' },
  orange:  { bg: 'bg-orange-50',  text: 'text-orange-700',  icon: 'text-orange-500' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', icon: 'text-emerald-500' },
  red:     { bg: 'bg-red-50',     text: 'text-red-700',     icon: 'text-red-500' },
  violet:  { bg: 'bg-violet-50',  text: 'text-violet-700',  icon: 'text-violet-500' },
  teal:    { bg: 'bg-teal-50',    text: 'text-teal-700',    icon: 'text-teal-500' },
  amber:   { bg: 'bg-amber-50',   text: 'text-amber-700',   icon: 'text-amber-500' },
  green:   { bg: 'bg-green-50',   text: 'text-green-700',   icon: 'text-green-500' },
}

function KpiCard({ label, value, icon: Icon, color, sub, badge }: {
  label: string; value: string; icon: React.ElementType
  color: string; sub?: string; badge?: React.ReactNode
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP['blue']!
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-medium text-muted-foreground leading-tight">{label}</p>
        <div className={`rounded-xl p-2 ${c.bg}`}>
          <Icon className={`h-4 w-4 ${c.icon}`} />
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <p className={`text-xl font-bold ${c.text} leading-none`}>{value}</p>
        {badge}
      </div>
      {sub && <p className="mt-2 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}
