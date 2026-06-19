import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Users, Calendar, Receipt, CalendarX, ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { KpiCard } from './DashboardPage'

// ── Types ──────────────────────────────────────────────────────────────────

// L'API /employees filtre déjà sur l'équipe directe du manager (RBAC serveur).
interface TeamMember {
  id: string
  first_name: string
  last_name: string
  job_title?: string
  department_name?: string
  is_active: boolean
}

interface PendingAbsence {
  id: string
  first_name?: string
  last_name?: string
  type_label?: string
  start_date?: string
  end_date?: string
}

interface PendingExpense {
  id: string
  first_name?: string
  last_name?: string
  title?: string
  total_amount?: string
}

interface AbsenceToday {
  id: string
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ManagerDashboard() {
  const { t } = useTranslation('dashboard')
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)

  // Équipe directe (l'API restreint déjà au périmètre du manager).
  const { data: teamData } = useQuery<{ data: TeamMember[] }>({
    queryKey: ['manager-team'],
    queryFn: () =>
      api.get('/employees?isActive=true&limit=500').then(r => r.data).catch(() => ({ data: [] })),
  })

  // Demandes d'absence en attente de validation.
  const { data: absToValidateData } = useQuery<{ data: PendingAbsence[] }>({
    queryKey: ['manager-absences-submitted'],
    queryFn: () =>
      api.get('/absences?status=submitted').then(r => r.data).catch(() => ({ data: [] })),
  })

  // Notes de frais en attente de validation.
  const { data: expToValidateData } = useQuery<{ data: PendingExpense[] }>({
    queryKey: ['manager-expenses-submitted'],
    queryFn: () =>
      api.get('/expenses?status=submitted').then(r => r.data).catch(() => ({ data: [] })),
  })

  // Absences approuvées du jour (informatif).
  const { data: absTodayData } = useQuery<{ data: AbsenceToday[] }>({
    queryKey: ['manager-absences-today'],
    queryFn: () =>
      api.get('/absences?status=approved&today=true').then(r => r.data).catch(() => ({ data: [] })),
  })

  const team = teamData?.data ?? []
  const absToValidate = absToValidateData?.data ?? []
  const expToValidate = expToValidateData?.data ?? []
  const absToday = absTodayData?.data ?? []

  const fullName = (first?: string, last?: string) =>
    [first, last].filter(Boolean).join(' ').trim() || '—'

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5 lg:p-8 space-y-5 bg-background min-h-full">

      {/* ── En-tête ─────────────────────────────────────────── */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
          {tenantConfig?.name ?? t('defaultTenant')} · {t('roles.manager')}
          · {t('manager.subtitle')}
        </p>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t('manager.kpi.team')}
          value={String(team.length)}
          icon={Users} color="blue"
          sub={t('manager.kpi.teamSub', { count: team.length })}
        />
        <KpiCard
          label={t('manager.kpi.absencesToValidate')}
          value={String(absToValidate.length)}
          icon={Calendar} color="orange"
          sub={absToValidate.length > 0
            ? t('manager.kpi.absencesToValidateSub')
            : t('manager.kpi.absencesToValidateNone')}
        />
        <KpiCard
          label={t('manager.kpi.expensesToValidate')}
          value={String(expToValidate.length)}
          icon={Receipt} color="violet"
          sub={expToValidate.length > 0
            ? t('manager.kpi.expensesToValidateSub')
            : t('manager.kpi.expensesToValidateNone')}
        />
        <KpiCard
          label={t('manager.kpi.absencesToday')}
          value={String(absToday.length)}
          icon={CalendarX} color="red"
          sub={absToday.length > 0
            ? t('manager.kpi.absencesTodaySub', { count: absToday.length })
            : t('manager.kpi.absencesTodayNone')}
        />
      </div>

      {/* ── Demandes à valider ──────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">

        {/* Absences à valider */}
        <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div>
              <h2 className="font-semibold flex items-center gap-2">
                <Calendar className="h-4 w-4 text-orange-500" />
                {t('manager.kpi.absencesToValidate')}
                {absToValidate.length > 0 && (
                  <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-700">
                    {absToValidate.length}
                  </span>
                )}
              </h2>
            </div>
            <Link to="/absences"
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              {t('manager.pending.openAbsences')} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {absToValidate.length > 0 ? (
            <ul className="divide-y">
              {absToValidate.slice(0, 5).map(a => (
                <li key={a.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <p className="font-medium">{fullName(a.first_name, a.last_name)}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.type_label ?? t('manager.pending.absence')}
                      {a.start_date && ` · ${a.start_date}`}
                      {a.end_date && ` → ${a.end_date}`}
                    </p>
                  </div>
                  <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                    {t('manager.pending.absence')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {t('manager.pending.empty')}
            </div>
          )}
        </div>

        {/* Notes de frais à valider */}
        <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div>
              <h2 className="font-semibold flex items-center gap-2">
                <Receipt className="h-4 w-4 text-violet-500" />
                {t('manager.kpi.expensesToValidate')}
                {expToValidate.length > 0 && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-700">
                    {expToValidate.length}
                  </span>
                )}
              </h2>
            </div>
            <Link to="/expenses"
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              {t('manager.pending.openExpenses')} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {expToValidate.length > 0 ? (
            <ul className="divide-y">
              {expToValidate.slice(0, 5).map(e => (
                <li key={e.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <p className="font-medium">{fullName(e.first_name, e.last_name)}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.title ?? t('manager.pending.expense')}
                    </p>
                  </div>
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                    {t('manager.pending.expense')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {t('manager.pending.empty')}
            </div>
          )}
        </div>
      </div>

      {/* ── Mon équipe ──────────────────────────────────────── */}
      <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-500" /> {t('manager.team.title')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t('manager.team.subtitle', { count: team.length })}
            </p>
          </div>
          <Link to="/employees"
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            {t('manager.team.viewAll')} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {team.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="px-5 py-3">{t('manager.team.role')}</th>
                  <th className="px-5 py-3">{t('manager.team.department')}</th>
                  <th className="px-5 py-3 text-right">{t('manager.team.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {team.slice(0, 12).map((m, i) => (
                  <tr key={m.id} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                    <td className="px-5 py-3">
                      <p className="font-medium">{fullName(m.first_name, m.last_name)}</p>
                      <p className="text-xs text-muted-foreground">{m.job_title ?? '—'}</p>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{m.department_name ?? '—'}</td>
                    <td className="px-5 py-3 text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        m.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {m.is_active ? t('manager.team.active') : t('manager.team.inactive')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            {t('manager.team.empty')}
          </div>
        )}
      </div>

      {/* Marqueur de rôle (utilisé indirectement par les guards de navigation) */}
      {user?.role === 'manager' && <span className="sr-only">manager-dashboard</span>}
    </div>
  )
}
