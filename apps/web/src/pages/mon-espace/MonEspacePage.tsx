import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { FileText, Calendar, Receipt, BookOpen, ExternalLink } from 'lucide-react'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { formatCurrency, cn } from '@/lib/utils'

interface AbsenceBalance {
  id: string
  absenceTypeName: string
  acquired: number
  taken: number
  pending: number
}

interface PaySlipSummary {
  id: string
  month: number
  year: number
  netPayable: number
  viewedByEmployeeAt: string | null
}

interface AbsenceSummary {
  id: string
  absenceType: string
  startDate: string
  endDate: string
  status: 'pending' | 'approved' | 'rejected'
}

interface ExpenseSummary {
  id: string
  title: string
  totalAmount: number
  status: 'draft' | 'submitted' | 'approved' | 'reimbursed' | 'rejected'
  submittedAt: string | null
}

interface TrainingCard {
  id: string
  title: string
  duration: string
  format: string
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  rejected: 'Refusée',
  draft: 'Brouillon',
  submitted: 'Soumise',
  reimbursed: 'Remboursée',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-orange-100 text-orange-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  draft: 'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-700',
  reimbursed: 'bg-emerald-100 text-emerald-700',
}

const ABSENCE_COLORS = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500']

export function MonEspacePage() {
  const { user, tenantConfig } = useAuthStore()
  const primaryColor = tenantConfig?.primaryColor ?? '#4F46E5'

  const { data: balances, isLoading: loadingBalances } = useQuery<AbsenceBalance[]>({
    queryKey: ['my-absence-balances'],
    queryFn: async () => {
      const res = await api.get<{ data: AbsenceBalance[] }>('/absences/my-balances')
      return res.data.data
    },
  })

  const { data: lastPayslip, isLoading: loadingPayslip } = useQuery<PaySlipSummary | null>({
    queryKey: ['my-last-payslip'],
    queryFn: async () => {
      const res = await api.get<{ data: PaySlipSummary[] }>('/payroll/my-payslips?limit=1')
      return res.data.data[0] ?? null
    },
  })

  const { data: absences, isLoading: loadingAbsences } = useQuery<AbsenceSummary[]>({
    queryKey: ['my-recent-absences'],
    queryFn: async () => {
      const res = await api.get<{ data: AbsenceSummary[] }>('/absences/my-absences?limit=3')
      return res.data.data
    },
  })

  const { data: expenses, isLoading: loadingExpenses } = useQuery<ExpenseSummary[]>({
    queryKey: ['my-recent-expenses'],
    queryFn: async () => {
      const res = await api.get<{ data: ExpenseSummary[] }>('/expenses/my-expenses?limit=3')
      return res.data.data
    },
  })

  const { data: trainings, isLoading: loadingTrainings } = useQuery<TrainingCard[]>({
    queryKey: ['training-catalog-preview'],
    queryFn: async () => {
      const res = await api.get<{ data: TrainingCard[] }>('/training/catalog?limit=2')
      return res.data.data
    },
  })

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Welcome banner */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl p-6 text-white"
        style={{
          background: `linear-gradient(135deg, ${primaryColor}, ${tenantConfig?.secondaryColor ?? '#818CF8'})`,
        }}
      >
        <h1 className="text-xl font-bold">Bonjour {user?.firstName} 👋</h1>
        <p className="text-white/80 text-sm mt-1">
          Votre espace collaborateur — {tenantConfig?.name ?? 'NexusRH'}
        </p>
      </motion.div>

      {/* Absence balances */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-900">Mes soldes de congés</h2>
          <Link
            to="/mon-espace/absences"
            className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
          >
            Gérer <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        {loadingBalances ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (balances ?? []).length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">Aucun solde disponible</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(balances ?? []).slice(0, 4).map((balance, i) => {
              const remaining = Number(balance.acquired) - Number(balance.taken) - Number(balance.pending)
              const pct = Math.min(
                100,
                (Number(balance.taken) / Math.max(1, Number(balance.acquired))) * 100
              )
              return (
                <div key={balance.id} className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 truncate">{balance.absenceTypeName}</p>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-bold text-gray-900">{remaining}</span>
                    <span className="text-xs text-gray-400">j</span>
                  </div>
                  <div className="h-1.5 bg-gray-200 rounded-full mt-2">
                    <div
                      className={cn('h-full rounded-full transition-all', ABSENCE_COLORS[i % ABSENCE_COLORS.length])}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {Number(balance.taken)} pris / {Number(balance.acquired)} acquis
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </motion.div>

      {/* Last payslip */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-900">Mon dernier bulletin</h2>
          <Link
            to="/mon-espace/bulletins"
            className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
          >
            Voir tout <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        {loadingPayslip ? (
          <div className="h-16 bg-gray-100 rounded-lg animate-pulse" />
        ) : !lastPayslip ? (
          <p className="text-sm text-gray-400 text-center py-4">Aucun bulletin disponible</p>
        ) : (
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center">
                <FileText className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-gray-700 capitalize">
                    {new Date(lastPayslip.year, lastPayslip.month - 1).toLocaleDateString('fr-FR', {
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                  {!lastPayslip.viewedByEmployeeAt && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                      Nouveau
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  Net à payer : {formatCurrency(Number(lastPayslip.netPayable))}
                </p>
              </div>
            </div>
            <Link
              to={`/mon-espace/bulletins`}
              className="text-xs text-indigo-600 hover:underline font-medium"
            >
              Consulter
            </Link>
          </div>
        )}
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recent absences */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Mes dernières absences</h2>
            <Link
              to="/mon-espace/absences"
              className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
            >
              Voir tout <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
          {loadingAbsences ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (absences ?? []).length === 0 ? (
            <div className="text-center py-6">
              <Calendar className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-400">Aucune absence</p>
            </div>
          ) : (
            <div className="space-y-2">
              {(absences ?? []).map((a) => (
                <div key={a.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700">{a.absenceType}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(a.startDate).toLocaleDateString('fr-FR')} →{' '}
                      {new Date(a.endDate).toLocaleDateString('fr-FR')}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                      STATUS_COLORS[a.status] ?? 'bg-gray-100 text-gray-600'
                    )}
                  >
                    {STATUS_LABELS[a.status] ?? a.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Recent expenses */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Mes dernières notes de frais</h2>
            <Link
              to="/mon-espace/notes-de-frais"
              className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
            >
              Voir tout <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
          {loadingExpenses ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : (expenses ?? []).length === 0 ? (
            <div className="text-center py-6">
              <Receipt className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-400">Aucune note de frais</p>
            </div>
          ) : (
            <div className="space-y-2">
              {(expenses ?? []).map((e) => (
                <div key={e.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700 truncate">{e.title}</p>
                    <p className="text-xs text-gray-500">{formatCurrency(Number(e.totalAmount))}</p>
                  </div>
                  <span
                    className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
                      STATUS_COLORS[e.status] ?? 'bg-gray-100 text-gray-600'
                    )}
                  >
                    {STATUS_LABELS[e.status] ?? e.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>

      {/* Recommended trainings */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-900">Formations recommandées</h2>
          <Link
            to="/mon-espace/formation"
            className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
          >
            Voir le catalogue <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        {loadingTrainings ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (trainings ?? []).length === 0 ? (
          <div className="text-center py-6">
            <BookOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-400">Aucune formation disponible</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(trainings ?? []).map((t) => (
              <div
                key={t.id}
                className="flex items-start gap-3 p-3 bg-indigo-50 rounded-lg border border-indigo-100"
              >
                <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
                  <BookOpen className="w-5 h-5 text-indigo-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{t.title}</p>
                  <p className="text-xs text-gray-500">
                    {t.duration} · {t.format}
                  </p>
                  <Link
                    to="/mon-espace/formation"
                    className="text-xs text-indigo-600 hover:underline font-medium mt-1 inline-block"
                  >
                    S'inscrire
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </div>
  )
}
