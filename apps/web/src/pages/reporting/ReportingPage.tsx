import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Download, TrendingUp, TrendingDown, Minus, Users, Banknote,
  AlertTriangle, Briefcase, CalendarX, Clock, FileSpreadsheet, FileText,
  ChevronDown,
} from 'lucide-react'
import api from '@/lib/api'
import { formatCurrency, formatPercent } from '@/lib/utils'
import { HeadcountChart } from '@/components/charts/HeadcountChart'
import { SalaryMassChart } from '@/components/charts/SalaryMassChart'
import { AbsenteeismChart } from '@/components/charts/AbsenteeismChart'
import { TurnoverChart } from '@/components/charts/TurnoverChart'

interface ReportingData {
  kpis: {
    totalEmployees: number
    newHiresThisMonth: number
    salaryMassThisMonth: number
    avgGrossSalary: number
    absenteeismRate: number
    turnoverRate: number
    openPositions: number
    contractsExpiringIn30Days: number
    pendingAbsences: number
    departures12Months: number
  }
  headcountTrend: Array<{ month: string; count: number }>
  salaryByDepartment: Array<{ department: string; amount: number; employeeCount: number }>
  absenceByMonth: Array<{ month: string; sick: number; vacation: number; other: number }>
  absenceByType: Array<{ type: string; category: string; count: number; days: number }>
  turnoverByMonth: Array<{ month: string; rate: number; departures: number; hires: number }>
  contractsExpiring: Array<{
    id: string
    firstName: string
    lastName: string
    jobTitle: string
    department: string
    type: string
    endDate: string
  }>
  departmentStats: Array<{ department: string; employeeCount: number; avgSalary: number }>
  aiInsights: Array<{ type: string; message: string; action?: string }>
}

function KpiCard({
  label, value, delta, trend, icon: Icon, color,
}: {
  label: string
  value: string
  delta?: string | null
  trend?: 'up' | 'down' | 'neutral'
  icon: React.ElementType
  color: string
}) {
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus
  const trendColor = trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-600' : 'text-gray-400'

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {delta && (
        <div className={`flex items-center gap-1 text-xs ${trendColor}`}>
          <TrendIcon className="w-3 h-3" />
          {delta}
        </div>
      )}
    </div>
  )
}

export function ReportingPage() {
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null)

  const { data, isLoading } = useQuery<ReportingData>({
    queryKey: ['reporting-dashboard'],
    queryFn: async () => {
      const res = await api.get('/reporting/dashboard')
      return res.data.data
    },
  })

  const handleExport = async (type: 'xlsx' | 'pdf') => {
    setExporting(type)
    setExportOpen(false)
    try {
      const res = await api.get(`/reporting/export/${type}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      const date = new Date().toISOString().split('T')[0]
      a.download = `rapport-rh-${date}.${type === 'xlsx' ? 'xlsx' : 'pdf'}`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(null)
    }
  }

  const k = data?.kpis

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reporting & Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">Vision 360° des ressources humaines — données temps réel</p>
        </div>
        <div className="relative">
          <button
            onClick={() => setExportOpen(!exportOpen)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Download className="w-4 h-4" />
            {exporting ? 'Export en cours…' : 'Exporter'}
            <ChevronDown className="w-3 h-3" />
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg z-10">
              <button
                onClick={() => handleExport('xlsx')}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-t-lg"
              >
                <FileSpreadsheet className="w-4 h-4 text-green-600" />
                Excel (.xlsx)
              </button>
              <button
                onClick={() => handleExport('pdf')}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-b-lg border-t border-gray-100"
              >
                <FileText className="w-4 h-4 text-red-500" />
                PDF
              </button>
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards — 4 colonnes × 2 lignes */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Effectifs actifs"
          value={isLoading ? '—' : String(k?.totalEmployees ?? 0)}
          delta={k?.newHiresThisMonth ? `+${k.newHiresThisMonth} ce mois` : null}
          trend="up"
          icon={Users}
          color="bg-indigo-500"
        />
        <KpiCard
          label="Masse salariale"
          value={isLoading ? '—' : formatCurrency(k?.salaryMassThisMonth ?? 0)}
          trend="neutral"
          icon={Banknote}
          color="bg-emerald-500"
        />
        <KpiCard
          label="Taux absentéisme"
          value={isLoading ? '—' : formatPercent(k?.absenteeismRate ?? 0)}
          trend={(k?.absenteeismRate ?? 0) > 5 ? 'down' : 'up'}
          icon={CalendarX}
          color={(k?.absenteeismRate ?? 0) > 5 ? 'bg-red-500' : 'bg-teal-500'}
        />
        <KpiCard
          label="Taux de turnover (12m)"
          value={isLoading ? '—' : formatPercent(k?.turnoverRate ?? 0)}
          delta={k?.departures12Months ? `${k.departures12Months} départ(s)` : null}
          trend={(k?.turnoverRate ?? 0) > 15 ? 'down' : 'neutral'}
          icon={TrendingDown}
          color={(k?.turnoverRate ?? 0) > 15 ? 'bg-red-500' : 'bg-orange-500'}
        />
        <KpiCard
          label="Postes ouverts"
          value={isLoading ? '—' : String(k?.openPositions ?? 0)}
          trend="neutral"
          icon={Briefcase}
          color="bg-blue-500"
        />
        <KpiCard
          label="Salaire brut moyen"
          value={isLoading ? '—' : formatCurrency(k?.avgGrossSalary ?? 0)}
          trend="neutral"
          icon={Banknote}
          color="bg-violet-500"
        />
        <KpiCard
          label="Contrats expirant (30j)"
          value={isLoading ? '—' : String(k?.contractsExpiringIn30Days ?? 0)}
          trend={(k?.contractsExpiringIn30Days ?? 0) > 0 ? 'down' : 'neutral'}
          icon={AlertTriangle}
          color={(k?.contractsExpiringIn30Days ?? 0) > 0 ? 'bg-amber-500' : 'bg-gray-400'}
        />
        <KpiCard
          label="Absences en attente"
          value={isLoading ? '—' : String(k?.pendingAbsences ?? 0)}
          trend={(k?.pendingAbsences ?? 0) > 5 ? 'down' : 'neutral'}
          icon={Clock}
          color="bg-pink-500"
        />
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Évolution des effectifs (12 mois)</h3>
          {data?.headcountTrend && data.headcountTrend.length > 0 ? (
            <HeadcountChart data={data.headcountTrend} />
          ) : (
            <div className="h-56 bg-gray-50 rounded-lg animate-pulse" />
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Masse salariale par département</h3>
          {data?.salaryByDepartment && data.salaryByDepartment.length > 0 ? (
            <SalaryMassChart data={data.salaryByDepartment} />
          ) : (
            <div className="h-56 bg-gray-50 rounded-lg flex items-center justify-center text-gray-400 text-sm">
              Aucun bulletin généré
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Absentéisme par mois</h3>
          {data?.absenceByMonth && data.absenceByMonth.length > 0 ? (
            <AbsenteeismChart data={data.absenceByMonth} />
          ) : (
            <div className="h-56 bg-gray-50 rounded-lg flex items-center justify-center text-gray-400 text-sm">
              Aucune donnée d'absence
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Turnover mensuel</h3>
          {data?.turnoverByMonth && data.turnoverByMonth.length > 0 ? (
            <TurnoverChart data={data.turnoverByMonth.map((t) => ({ ...t, benchmark: 8 }))} />
          ) : (
            <div className="h-56 bg-gray-50 rounded-lg flex items-center justify-center text-gray-400 text-sm">
              Aucune donnée de turnover
            </div>
          )}
        </div>
      </div>

      {/* Absences par type + Département stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Absences par type */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Répartition absences par type (12 mois)</h3>
          {data?.absenceByType && data.absenceByType.length > 0 ? (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-indigo-50">
                    <th className="text-left py-2 px-3 text-xs font-semibold text-indigo-700 rounded-l">Type</th>
                    <th className="text-right py-2 px-3 text-xs font-semibold text-indigo-700">Demandes</th>
                    <th className="text-right py-2 px-3 text-xs font-semibold text-indigo-700 rounded-r">Jours</th>
                  </tr>
                </thead>
                <tbody>
                  {data.absenceByType.map((row, i) => (
                    <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="py-2 px-3 text-gray-700 font-medium">{row.type}</td>
                      <td className="py-2 px-3 text-gray-600 text-right">{row.count}</td>
                      <td className="py-2 px-3 text-gray-600 text-right font-medium">{row.days}j</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-gray-400 text-sm text-center py-8">Aucune absence approuvée sur 12 mois</p>
          )}
        </div>

        {/* Stats par département */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Effectifs & salaires par département</h3>
          {data?.departmentStats && data.departmentStats.length > 0 ? (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-indigo-50">
                    <th className="text-left py-2 px-3 text-xs font-semibold text-indigo-700 rounded-l">Département</th>
                    <th className="text-right py-2 px-3 text-xs font-semibold text-indigo-700">Effectifs</th>
                    <th className="text-right py-2 px-3 text-xs font-semibold text-indigo-700 rounded-r">Salaire moy.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.departmentStats.map((row, i) => (
                    <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="py-2 px-3 text-gray-700 font-medium">{row.department}</td>
                      <td className="py-2 px-3 text-gray-600 text-right">{row.employeeCount}</td>
                      <td className="py-2 px-3 text-gray-600 text-right">{formatCurrency(row.avgSalary)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-gray-400 text-sm text-center py-8">Aucun département configuré</p>
          )}
        </div>
      </div>

      {/* Contrats expirant */}
      {data?.contractsExpiring && data.contractsExpiring.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 shadow-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Contrats expirant dans 30 jours ({data.contractsExpiring.length})
          </h3>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-amber-50">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-amber-700 rounded-l">Collaborateur</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-amber-700">Poste</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-amber-700">Département</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-amber-700">Type</th>
                  <th className="text-right py-2 px-3 text-xs font-semibold text-amber-700 rounded-r">Fin de contrat</th>
                </tr>
              </thead>
              <tbody>
                {data.contractsExpiring.map((c, i) => {
                  const daysLeft = Math.ceil(
                    (new Date(c.endDate).getTime() - Date.now()) / (1000 * 3600 * 24),
                  )
                  return (
                    <tr key={c.id} className={i % 2 === 0 ? 'bg-white' : 'bg-amber-50/30'}>
                      <td className="py-2 px-3 font-medium text-gray-900">
                        {c.firstName} {c.lastName}
                      </td>
                      <td className="py-2 px-3 text-gray-600">{c.jobTitle}</td>
                      <td className="py-2 px-3 text-gray-600">{c.department}</td>
                      <td className="py-2 px-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                          {c.type.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <span className={`font-medium ${daysLeft <= 7 ? 'text-red-600' : 'text-amber-600'}`}>
                          {new Date(c.endDate).toLocaleDateString('fr-FR')}
                          <span className="text-xs ml-1">({daysLeft}j)</span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AI insights */}
      {data?.aiInsights && data.aiInsights.length > 0 && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-100 p-5">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="text-lg">🤖</span>
            Insights NexusRH AI
          </h3>
          <div className="space-y-3">
            {data.aiInsights.map((insight, idx) => (
              <div key={idx} className="flex items-start gap-3 bg-white rounded-lg p-3 border border-indigo-100">
                <span className="text-lg">
                  {insight.type === 'alert' ? '⚠️' : insight.type === 'positive' ? '✅' : 'ℹ️'}
                </span>
                <div className="flex-1">
                  <p className="text-sm text-gray-700">{insight.message}</p>
                  {insight.action && (
                    <button className="text-xs text-indigo-600 hover:underline mt-1">
                      {insight.action}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
