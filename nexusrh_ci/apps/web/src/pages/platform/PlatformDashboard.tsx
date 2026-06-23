import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA } from '@/lib/api'
import { Building2, Users, TrendingUp, AlertCircle, Wallet } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

interface DashStats {
  activeCount: number
  trialCount: number
  suspendedCount: number
  totalCount: number
  // PLT-022 — MRR estimé (FCFA)
  estimatedMrr?: number
  // PLT-019 — trials expirant sous 7 jours
  expiringTrials?: { id: string; name: string; slug: string; trialEndsAt: string }[]
  // PLT-021 — croissance tenants (12 mois)
  growth?: { period: string; count: number }[]
}

interface Tenant {
  id: string; name: string; slug: string; plan_type: string
  status: string; city: string; created_at: string
  max_employees: number
}

export default function PlatformDashboard() {
  const { t } = useTranslation('platform')
  const { data: statsData } = useQuery<{ data: DashStats }>({
    queryKey: ['platform-stats'],
    queryFn: () => api.get('/platform/dashboard').then(r => r.data),
  })

  const { data: tenantsData } = useQuery<{ data: Tenant[]; total: number }>({
    queryKey: ['platform-tenants'],
    queryFn: () => api.get('/platform/tenants?limit=10').then(r => r.data),
  })

  const stats = statsData?.data
  const tenants = tenantsData?.data ?? []

  const statusLabel: Record<string, string> = {
    active: t('status.active'), trial: t('status.trial'), suspended: t('status.suspended'),
  }
  const statusColor: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    trial: 'bg-yellow-100 text-yellow-700',
    suspended: 'bg-red-100 text-red-700',
  }
  const planLabel: Record<string, string> = {
    trial: t('plans.trial'), starter: t('plans.starter'), business: t('plans.business'),
    enterprise: t('plans.enterprise'), public_sector: t('plans.public_sector'),
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('dashboard.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('dashboard.subtitle')}</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {[
          { label: t('dashboard.kpi.activeTenants'), value: String(stats?.activeCount ?? 0),    icon: Building2, color: 'bg-green-50 text-green-600', valueClass: 'text-2xl' },
          { label: t('dashboard.kpi.trial'),         value: String(stats?.trialCount ?? 0),     icon: TrendingUp, color: 'bg-yellow-50 text-yellow-600', valueClass: 'text-2xl' },
          { label: t('dashboard.kpi.suspended'),     value: String(stats?.suspendedCount ?? 0), icon: AlertCircle, color: 'bg-red-50 text-red-600', valueClass: 'text-2xl' },
          { label: t('dashboard.kpi.totalTenants'),  value: String(stats?.totalCount ?? 0),     icon: Users, color: 'bg-blue-50 text-blue-600', valueClass: 'text-2xl' },
          // PLT-022 — MRR estimé (FCFA)
          { label: 'MRR estimé', value: formatFCFA(stats?.estimatedMrr ?? 0), icon: Wallet, color: 'bg-indigo-50 text-indigo-600', valueClass: 'text-lg' },
        ].map(({ label, value, icon: Icon, color, valueClass }) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{label}</p>
                <p className={`font-bold ${valueClass}`}>{value}</p>
              </div>
              <div className={`rounded-lg p-2 ${color}`}>
                <Icon className="h-4 w-4" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* PLT-021 — Croissance des tenants (12 derniers mois) */}
      {(stats?.growth?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4">Croissance des tenants (12 mois)</h2>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={stats!.growth}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="period" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* PLT-019 — Alertes : trials expirant sous 7 jours */}
      {(stats?.expiringTrials?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-6">
          <h2 className="font-semibold text-red-800 mb-3 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> Trials expirant sous 7 jours
          </h2>
          <ul className="space-y-2">
            {stats!.expiringTrials!.map(tr => (
              <li key={tr.id} className="flex items-center justify-between rounded-lg border border-red-200 bg-white px-4 py-2 text-sm">
                <a href={`/platform/tenants/${tr.id}`} className="font-medium hover:underline">{tr.name}</a>
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  Expire le {new Date(tr.trialEndsAt).toLocaleDateString('fr-CI')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Liste tenants */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{t('dashboard.recentTenants')}</h2>
          <a href="/platform/tenants/new"
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
            {t('dashboard.createTenant')}
          </a>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 pr-4">{t('dashboard.table.company')}</th>
                <th className="pb-2 pr-4">{t('dashboard.table.city')}</th>
                <th className="pb-2 pr-4">{t('dashboard.table.plan')}</th>
                <th className="pb-2 pr-4">{t('dashboard.table.maxEmployees')}</th>
                <th className="pb-2">{t('dashboard.table.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tenants.map(tenant => (
                <tr key={tenant.id} className="hover:bg-muted/50">
                  <td className="py-2.5 pr-4">
                    <a href={`/platform/tenants/${tenant.id}`} className="font-medium hover:text-primary">
                      {tenant.name}
                    </a>
                    <p className="text-xs text-muted-foreground">{tenant.slug}</p>
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{tenant.city ?? '—'}</td>
                  <td className="py-2.5 pr-4">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                      {planLabel[tenant.plan_type] ?? tenant.plan_type}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{tenant.max_employees}</td>
                  <td className="py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[tenant.status] ?? ''}`}>
                      {statusLabel[tenant.status] ?? tenant.status}
                    </span>
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted-foreground">
                    {t('dashboard.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
