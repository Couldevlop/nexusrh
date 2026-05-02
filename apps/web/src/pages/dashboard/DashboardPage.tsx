import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Navigate } from 'react-router-dom'
import {
  Users, CreditCard, CalendarOff, Briefcase,
  TrendingUp, TrendingDown, AlertTriangle, Info, CheckCircle2,
  Clock, FileCheck,
} from 'lucide-react'
import { HeadcountChart } from '@/components/charts/HeadcountChart'
import { SalaryMassChart } from '@/components/charts/SalaryMassChart'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { formatCurrency, formatPercent, cn } from '@/lib/utils'
import type { DashboardData } from '@nexusrh/shared'

// ─── Shared KPI card ────────────────────────────────────────────────────────

function KPICard({
  title,
  value,
  delta,
  deltaLabel,
  icon: Icon,
  color,
  format: fmt,
}: {
  title: string
  value: number
  delta: number
  deltaLabel?: string
  icon: React.ElementType
  color: string
  format?: 'number' | 'currency' | 'percent'
}) {
  const formattedValue =
    fmt === 'currency'
      ? formatCurrency(value)
      : fmt === 'percent'
      ? formatPercent(value)
      : value.toLocaleString('fr-FR')

  const isPositive = delta >= 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm hover:shadow-md transition-shadow"
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center', color)}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <motion.span
          className="text-2xl font-bold text-gray-900"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          {formattedValue}
        </motion.span>
        <span
          className={cn(
            'flex items-center gap-0.5 text-sm font-medium',
            isPositive ? 'text-green-600' : 'text-red-600'
          )}
        >
          {isPositive ? (
            <TrendingUp className="w-3.5 h-3.5" />
          ) : (
            <TrendingDown className="w-3.5 h-3.5" />
          )}
          {isPositive ? '+' : ''}
          {deltaLabel ?? `${delta}%`}
        </span>
      </div>
    </motion.div>
  )
}

// ─── Manager dashboard ──────────────────────────────────────────────────────

interface ManagerDashboardData {
  teamSize: number
  absentToday: number
  pendingApprovals: number
  ongoingTrainings: number
  teamMembers: Array<{
    id: string
    firstName: string
    lastName: string
    jobTitle: string
    isAbsentToday: boolean
  }>
  pendingAbsences: Array<{
    id: string
    firstName: string
    lastName: string
    startDate: string
    endDate: string
    absenceType: string
  }>
  pendingExpenses: Array<{
    id: string
    firstName: string
    lastName: string
    title: string
    totalAmount: number
  }>
}

function ManagerDashboard() {
  const { data, isLoading } = useQuery<ManagerDashboardData>({
    queryKey: ['manager-dashboard'],
    queryFn: async () => {
      const res = await api.get<{ data: ManagerDashboardData }>('/reporting/manager-dashboard')
      return res.data.data
    },
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  })

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Mon équipe</h1>
        <p className="text-sm text-gray-500 mt-1">Tableau de bord manager</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-gray-500">Mon équipe</p>
            <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Users className="w-5 h-5 text-white" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {isLoading ? '—' : (data?.teamSize ?? 0).toLocaleString('fr-FR')}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-gray-500">Absences aujourd'hui</p>
            <div className="w-9 h-9 rounded-lg bg-amber-500 flex items-center justify-center">
              <CalendarOff className="w-5 h-5 text-white" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {isLoading ? '—' : (data?.absentToday ?? 0).toLocaleString('fr-FR')}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-gray-500">Demandes à valider</p>
            <div className="w-9 h-9 rounded-lg bg-red-500 flex items-center justify-center">
              <Clock className="w-5 h-5 text-white" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold text-gray-900">
              {isLoading ? '—' : (data?.pendingApprovals ?? 0).toLocaleString('fr-FR')}
            </p>
            {(data?.pendingApprovals ?? 0) > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                En attente
              </span>
            )}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-gray-500">Formations en cours</p>
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center">
              <FileCheck className="w-5 h-5 text-white" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {isLoading ? '—' : (data?.ongoingTrainings ?? 0).toLocaleString('fr-FR')}
          </p>
        </motion.div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Team members */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Mon équipe directe</h2>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (data?.teamMembers ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">Aucun membre dans l'équipe</p>
          ) : (
            <div className="space-y-2">
              {(data?.teamMembers ?? []).map((m) => (
                <div key={m.id} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-700">
                    {m.firstName.charAt(0)}
                    {m.lastName.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-700 truncate">
                      {m.firstName} {m.lastName}
                    </p>
                    <p className="text-xs text-gray-400 truncate">{m.jobTitle}</p>
                  </div>
                  {m.isAbsentToday && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">
                      Absent
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Pending absences */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Absences à approuver</h2>
            {(data?.pendingAbsences ?? []).length > 0 && (
              <span className="w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-bold">
                {data?.pendingAbsences.length}
              </span>
            )}
          </div>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (data?.pendingAbsences ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">Aucune demande en attente</p>
          ) : (
            <div className="space-y-2">
              {(data?.pendingAbsences ?? []).map((a) => (
                <div key={a.id} className="p-2 bg-orange-50 rounded-lg">
                  <p className="text-sm font-medium text-gray-700">
                    {a.firstName} {a.lastName}
                  </p>
                  <p className="text-xs text-gray-500">
                    {a.absenceType} · du{' '}
                    {new Date(a.startDate).toLocaleDateString('fr-FR')} au{' '}
                    {new Date(a.endDate).toLocaleDateString('fr-FR')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Pending expenses */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Notes de frais à valider</h2>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (data?.pendingExpenses ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">Aucune note à valider</p>
          ) : (
            <div className="space-y-2">
              {(data?.pendingExpenses ?? []).map((e) => (
                <div key={e.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700 truncate">{e.title}</p>
                    <p className="text-xs text-gray-500">
                      {e.firstName} {e.lastName}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-gray-900 flex-shrink-0">
                    {formatCurrency(e.totalAmount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

// ─── Main dashboard (admin / hr_manager / hr_officer) ───────────────────────

function HRDashboard({ entityId }: { entityId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const response = await api.get<{ data: DashboardData }>('/reporting/dashboard')
      return response.data.data
    },
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  })

  const insightIcons = {
    warning: AlertTriangle,
    info: Info,
    success: CheckCircle2,
  }

  const insightColors = {
    warning: 'text-amber-600 bg-amber-50 border-amber-200',
    info: 'text-blue-600 bg-blue-50 border-blue-200',
    success: 'text-green-600 bg-green-50 border-green-200',
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Tableau de bord</h1>
        <p className="text-sm text-gray-500 mt-1">
          Vue d'ensemble de vos indicateurs RH en temps réel
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Effectifs actifs"
          value={data?.kpis.activeEmployees ?? 0}
          delta={data?.kpis.activeEmployeesDelta ?? 0}
          deltaLabel={`${data?.kpis.activeEmployeesDelta ?? 0} ce mois`}
          icon={Users}
          color="bg-indigo-600"
          format="number"
        />
        <KPICard
          title="Masse salariale (mois)"
          value={data?.kpis.monthlySalaryMass ?? 0}
          delta={data?.kpis.monthlySalaryMassDelta ?? 0}
          deltaLabel={`${data?.kpis.monthlySalaryMassDelta ?? 0}% vs M-1`}
          icon={CreditCard}
          color="bg-emerald-600"
          format="currency"
        />
        <KPICard
          title="Taux d'absentéisme"
          value={data?.kpis.absenteeismRate ?? 0}
          delta={data?.kpis.absenteeismRateDelta ?? 0}
          deltaLabel={`${data?.kpis.absenteeismRateDelta ?? 0}% vs M-1`}
          icon={CalendarOff}
          color="bg-amber-600"
          format="percent"
        />
        <KPICard
          title="Postes ouverts"
          value={data?.kpis.openPositions ?? 0}
          delta={data?.kpis.openPositionsDelta ?? 0}
          deltaLabel={`${data?.kpis.openPositionsDelta ?? 0} nouveaux`}
          icon={Briefcase}
          color="bg-purple-600"
          format="number"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="lg:col-span-3 bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Évolution des effectifs (12 mois)
          </h2>
          {isLoading ? (
            <div className="h-48 bg-gray-100 rounded-lg animate-pulse" />
          ) : (
            <HeadcountChart data={data?.headcountTrend ?? []} />
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="lg:col-span-2 bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Masse salariale par département
          </h2>
          {isLoading ? (
            <div className="h-48 bg-gray-100 rounded-lg animate-pulse" />
          ) : (
            <SalaryMassChart data={data?.salaryByDepartment ?? []} />
          )}
        </motion.div>
      </div>

      {/* AI Insights */}
      {(data?.aiInsights?.length ?? 0) > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 bg-indigo-100 rounded-full flex items-center justify-center">
              <span className="text-xs">🤖</span>
            </div>
            <h2 className="text-sm font-semibold text-gray-700">Insights NexusRH AI</h2>
            <span className="text-xs text-gray-400">Propulsé par Claude</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {data?.aiInsights.map((insight, i) => {
              const Icon = insightIcons[insight.type]
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-lg border text-sm',
                    insightColors[insight.type]
                  )}
                >
                  <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <p>{insight.message}</p>
                    {insight.action && (
                      <a
                        href={insight.actionUrl ?? '#'}
                        className="text-xs font-medium underline mt-1 block"
                      >
                        {insight.action}
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </motion.div>
      )}

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Absences du jour */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Absences aujourd'hui</h2>
          {data?.todayAbsences?.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">
              Aucune absence aujourd'hui 🎉
            </p>
          ) : (
            <div className="space-y-2">
              {(data?.todayAbsences ?? []).slice(0, 5).map((absence, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-600">
                    {absence.firstName.charAt(0)}
                    {absence.lastName.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      {absence.firstName} {absence.lastName}
                    </p>
                    <p className="text-xs text-gray-400">{absence.absenceType}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Anniversaires */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-3">🎂 Anniversaires du mois</h2>
          {(data?.upcomingBirthdays ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">Aucun anniversaire ce mois</p>
          ) : (
            <div className="space-y-2">
              {(data?.upcomingBirthdays ?? []).slice(0, 5).map((b, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🎂</span>
                    <span className="text-sm text-gray-700">
                      {b.firstName} {b.lastName}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {new Date(b.birthDate).toLocaleDateString('fr-FR', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Entrées/Sorties */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Mouvements du mois</h2>
          {(data?.monthlyEvents ?? []).length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">Aucun mouvement ce mois</p>
          ) : (
            <div className="space-y-2">
              {(data?.monthlyEvents ?? []).slice(0, 5).map((event, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      event.type === 'hire' ? 'bg-green-500' : 'bg-red-500'
                    )}
                  />
                  <span className="text-sm text-gray-700">
                    {event.firstName} {event.lastName}
                  </span>
                  <span className="text-xs text-gray-400 ml-auto">
                    {event.type === 'hire' ? 'Entrée' : 'Sortie'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

// ─── Root DashboardPage ──────────────────────────────────────────────────────

export function DashboardPage() {
  const { user, entityId } = useAuthStore()

  // Redirections par rôle
  if (user?.role === 'super_admin') {
    return <Navigate to="/platform/dashboard" replace />
  }
  if (user?.role === 'employee') {
    return <Navigate to="/mon-espace" replace />
  }

  if (user?.role === 'manager') {
    return <ManagerDashboard />
  }

  return <HRDashboard entityId={entityId} />
}
