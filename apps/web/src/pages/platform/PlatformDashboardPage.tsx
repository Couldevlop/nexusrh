import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  Building2, Users, TrendingUp, Euro, AlertTriangle, Plus,
  ExternalLink, Clock, CheckCircle2, XCircle, ArrowRight,
  Zap, Globe, Shield, Activity,
} from 'lucide-react'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

interface Kpis {
  activeTenants: number
  trialTenants: number
  suspendedTenants: number
  totalEmployees: number
  platformUsers: number
  mrrEstimate: number
}

interface TenantAlert {
  id: string
  name: string
  slug: string
  trial_ends_at?: string
}

interface DashboardData {
  kpis: Kpis
  alerts: { trialsExpiringSoon: TenantAlert[]; suspendedTenants: TenantAlert[] }
}

interface TenantRow {
  id: string; name: string; slug: string; plan_type: string; status: string
  primary_color: string; userCount: number; employeeCount: number; created_at: string
}

const PLAN_COLORS: Record<string, string> = {
  trial: 'bg-amber-100 text-amber-700 border-amber-200',
  starter: 'bg-sky-100 text-sky-700 border-sky-200',
  pro: 'bg-violet-100 text-violet-700 border-violet-200',
  enterprise: 'bg-purple-100 text-purple-700 border-purple-200',
}
const PLAN_LABELS: Record<string, string> = { trial: 'Trial', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' }
const STATUS_DOT: Record<string, string> = { active: 'bg-emerald-500', trial: 'bg-amber-400', suspended: 'bg-red-500' }

function formatEur(n: number) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
}

function daysUntil(dateStr: string) {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000)
}

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.07 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

export function PlatformDashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-dashboard'],
    queryFn: async () => {
      const [statsRes, tenantsRes] = await Promise.all([
        api.get<{ data: DashboardData }>('/platform/dashboard'),
        api.get<{ data: TenantRow[]; meta: { total: number } }>('/platform/tenants?limit=6'),
      ])
      return { stats: statsRes.data.data, tenants: tenantsRes.data.data, total: tenantsRes.data.meta.total }
    },
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
  })

  const kpis = data?.stats.kpis
  const alerts = data?.stats.alerts
  const alertCount = (alerts?.trialsExpiringSoon?.length ?? 0) + (alerts?.suspendedTenants?.length ?? 0)

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
          <h1 className="text-2xl font-bold text-gray-900">Tableau de bord Plateforme</h1>
          <p className="text-sm text-gray-500 mt-0.5">Vue globale de l'infrastructure NexusRH</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex gap-2">
          <Link to="/platform/tenants"
            className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">
            <Building2 size={15} /> Gérer les tenants
          </Link>
          <Link to="/platform/tenants/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition-colors shadow-sm shadow-violet-200">
            <Plus size={15} /> Nouveau tenant
          </Link>
        </motion.div>
      </div>

      {/* KPI Cards */}
      <motion.div variants={stagger} initial="hidden" animate="visible"
        className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {[
          { label: 'Tenants actifs', value: kpis?.activeTenants, icon: CheckCircle2, bg: 'from-emerald-500 to-teal-600', light: 'bg-emerald-50', text: 'text-emerald-700' },
          { label: 'En trial', value: kpis?.trialTenants, icon: Clock, bg: 'from-amber-400 to-orange-500', light: 'bg-amber-50', text: 'text-amber-700' },
          { label: 'Suspendus', value: kpis?.suspendedTenants, icon: XCircle, bg: 'from-red-500 to-rose-600', light: 'bg-red-50', text: 'text-red-700' },
          { label: 'Employés', value: kpis?.totalEmployees, icon: Users, bg: 'from-blue-500 to-indigo-600', light: 'bg-blue-50', text: 'text-blue-700' },
          { label: 'Admin. plateforme', value: kpis?.platformUsers, icon: Shield, bg: 'from-violet-500 to-purple-600', light: 'bg-violet-50', text: 'text-violet-700' },
          { label: 'MRR estimé', value: kpis?.mrrEstimate, icon: Euro, bg: 'from-pink-500 to-rose-600', light: 'bg-pink-50', text: 'text-pink-700', isCurrency: true },
        ].map((card) => (
          <motion.div key={card.label} variants={fadeUp}
            className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5">
            <div className={cn('w-9 h-9 rounded-xl bg-gradient-to-br flex items-center justify-center mb-3', card.bg)}>
              <card.icon size={16} className="text-white" />
            </div>
            <p className="text-2xl font-bold text-gray-900 leading-none">
              {isLoading ? <span className="w-12 h-6 bg-gray-200 rounded animate-pulse inline-block" />
                : card.isCurrency ? formatEur(card.value ?? 0) : (card.value ?? 0).toLocaleString('fr-FR')}
            </p>
            <p className="text-xs text-gray-500 mt-1.5 font-medium">{card.label}</p>
          </motion.div>
        ))}
      </motion.div>

      {/* Alerts */}
      {alertCount > 0 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
          className="bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-amber-100 bg-amber-50/50">
            <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center">
              <AlertTriangle size={15} className="text-amber-600" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Alertes requérant attention</h2>
              <p className="text-xs text-gray-500">{alertCount} alerte{alertCount > 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="divide-y divide-gray-50">
            {alerts?.trialsExpiringSoon?.map((t) => {
              const days = daysUntil(t.trial_ends_at!)
              return (
                <div key={t.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <Clock size={14} className="text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                    <p className="text-xs text-amber-600">
                      Trial expire dans <strong>{days} jour{days > 1 ? 's' : ''}</strong> · {new Date(t.trial_ends_at!).toLocaleDateString('fr-FR')}
                    </p>
                  </div>
                  <Link to={`/platform/tenants/${t.id}`}
                    className="flex items-center gap-1 text-xs text-violet-600 font-medium hover:text-violet-800 transition-colors">
                    Gérer <ArrowRight size={12} />
                  </Link>
                </div>
              )
            })}
            {alerts?.suspendedTenants?.map((t) => (
              <div key={t.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
                  <XCircle size={14} className="text-red-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                  <p className="text-xs text-red-600">Tenant suspendu — accès bloqué</p>
                </div>
                <Link to={`/platform/tenants/${t.id}`}
                  className="flex items-center gap-1 text-xs text-violet-600 font-medium hover:text-violet-800 transition-colors">
                  Réactiver <ArrowRight size={12} />
                </Link>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Stats + Tenants */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Recent tenants */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
          className="xl:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Tenants récents</h2>
              <p className="text-xs text-gray-400 mt-0.5">{data?.total ?? 0} au total</p>
            </div>
            <Link to="/platform/tenants" className="flex items-center gap-1 text-xs text-violet-600 font-medium hover:text-violet-800 transition-colors">
              Voir tout <ExternalLink size={11} />
            </Link>
          </div>

          {isLoading ? (
            <div className="p-5 space-y-3">
              {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />)}
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {(data?.tenants ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/80 transition-colors group">
                  {/* Avatar couleur tenant */}
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-sm"
                    style={{ backgroundColor: t.primary_color || '#4F46E5' }}>
                    {t.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900 truncate">{t.name}</p>
                      <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border', PLAN_COLORS[t.plan_type])}>
                        {PLAN_LABELS[t.plan_type]}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="flex items-center gap-1 text-xs text-gray-400">
                        <span className={cn('w-1.5 h-1.5 rounded-full', STATUS_DOT[t.status])} />
                        {t.status}
                      </span>
                      <span className="text-xs text-gray-400">{t.userCount} users · {t.employeeCount} emp.</span>
                    </div>
                  </div>
                  <Link to={`/platform/tenants/${t.id}`}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-violet-100 text-violet-600">
                    <ArrowRight size={14} />
                  </Link>
                </div>
              ))}
              {(data?.tenants ?? []).length === 0 && (
                <div className="px-5 py-10 text-center">
                  <Building2 size={28} className="text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">Aucun tenant.{' '}
                    <Link to="/platform/tenants/new" className="text-violet-600 hover:underline">Créer le premier</Link>
                  </p>
                </div>
              )}
            </div>
          )}
        </motion.div>

        {/* Quick stats side panel */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="space-y-4">
          {/* Plan distribution */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-4">Répartition des plans</h3>
            <div className="space-y-3">
              {[
                { label: 'Enterprise', color: 'bg-purple-500', plan: 'enterprise' },
                { label: 'Pro', color: 'bg-violet-500', plan: 'pro' },
                { label: 'Starter', color: 'bg-sky-500', plan: 'starter' },
                { label: 'Trial', color: 'bg-amber-400', plan: 'trial' },
              ].map(({ label, color, plan }) => {
                const total = (kpis?.activeTenants ?? 0) + (kpis?.trialTenants ?? 0) + (kpis?.suspendedTenants ?? 0) || 1
                const count = plan === 'trial' ? (kpis?.trialTenants ?? 0) : 0
                const pct = Math.round((count / total) * 100)
                return (
                  <div key={plan} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-600 font-medium">{label}</span>
                      <span className="text-gray-400">{count}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ delay: 0.5, duration: 0.6 }}
                        className={cn('h-full rounded-full', color)} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Platform health */}
          <div className="bg-gradient-to-br from-violet-600 to-purple-700 rounded-2xl p-5 text-white">
            <div className="flex items-center gap-2 mb-4">
              <Activity size={16} className="text-violet-200" />
              <h3 className="text-sm font-semibold">Santé plateforme</h3>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Base de données', ok: true },
                { label: 'API Gateway', ok: true },
                { label: 'Queue BullMQ', ok: true },
                { label: 'Meilisearch', ok: true },
              ].map(s => (
                <div key={s.label} className="flex items-center justify-between">
                  <span className="text-xs text-violet-200">{s.label}</span>
                  <div className="flex items-center gap-1.5">
                    <span className={cn('w-1.5 h-1.5 rounded-full', s.ok ? 'bg-emerald-400' : 'bg-red-400')} />
                    <span className="text-xs text-white/80">{s.ok ? 'Opérationnel' : 'Dégradé'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick actions */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Actions rapides</h3>
            <div className="space-y-2">
              <Link to="/platform/tenants/new"
                className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-violet-50 transition-colors group">
                <div className="w-7 h-7 rounded-lg bg-violet-100 flex items-center justify-center">
                  <Plus size={14} className="text-violet-600" />
                </div>
                <span className="text-sm text-gray-700 group-hover:text-violet-700 transition-colors font-medium">Créer un tenant</span>
              </Link>
              <Link to="/platform/logs"
                className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-blue-50 transition-colors group">
                <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Globe size={14} className="text-blue-600" />
                </div>
                <span className="text-sm text-gray-700 group-hover:text-blue-700 transition-colors font-medium">Voir les logs</span>
              </Link>
              <Link to="/platform/settings"
                className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-gray-50 transition-colors group">
                <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center">
                  <Zap size={14} className="text-gray-600" />
                </div>
                <span className="text-sm text-gray-700 font-medium">Paramètres</span>
              </Link>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
