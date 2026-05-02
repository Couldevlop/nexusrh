import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Search, X, ChevronLeft, ChevronRight, Activity, User, Building2, FileText, AlertTriangle, Info, RefreshCw } from 'lucide-react'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

interface LogEntry {
  id: string
  user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  ip_address: string | null
  created_at: string
  tenant_name: string
  schema_name: string
}

const ACTION_ICONS: Record<string, React.ElementType> = {
  login: User, logout: User, create: FileText, update: FileText, delete: AlertTriangle,
  suspend: AlertTriangle, activate: Activity, view: Info,
}

const ACTION_COLORS: Record<string, string> = {
  login:    'bg-emerald-100 text-emerald-600',
  logout:   'bg-gray-100 text-gray-500',
  create:   'bg-blue-100 text-blue-600',
  update:   'bg-amber-100 text-amber-600',
  delete:   'bg-red-100 text-red-600',
  suspend:  'bg-orange-100 text-orange-600',
  activate: 'bg-teal-100 text-teal-600',
  view:     'bg-violet-100 text-violet-600',
}

function getActionCategory(action: string): string {
  const a = action.toLowerCase()
  if (a.includes('login')) return 'login'
  if (a.includes('logout')) return 'logout'
  if (a.includes('create') || a.includes('insert')) return 'create'
  if (a.includes('update') || a.includes('edit') || a.includes('modify')) return 'update'
  if (a.includes('delete') || a.includes('remove')) return 'delete'
  if (a.includes('suspend')) return 'suspend'
  if (a.includes('activate')) return 'activate'
  return 'view'
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'À l\'instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours}h`
  const days = Math.floor(hours / 24)
  return `il y a ${days} jour${days > 1 ? 's' : ''}`
}

export function PlatformLogsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const limit = 50

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['platform-logs', page, limit],
    queryFn: async () => {
      const res = await api.get<{ data: LogEntry[]; meta: { total: number; page: number } }>(
        `/platform/logs?page=${page}&limit=${limit}`
      )
      return res.data
    },
    refetchInterval: 30_000,
  })

  const allLogs = data?.data ?? []

  // Client-side filtering
  const filtered = allLogs.filter(log => {
    const matchSearch = !search || log.action.toLowerCase().includes(search.toLowerCase())
      || log.tenant_name.toLowerCase().includes(search.toLowerCase())
      || (log.entity_type ?? '').toLowerCase().includes(search.toLowerCase())
    const matchAction = !actionFilter || getActionCategory(log.action) === actionFilter
    return matchSearch && matchAction
  })

  const totalPages = Math.ceil((data?.meta.total ?? 0) / limit)

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
          <h1 className="text-2xl font-bold text-gray-900">Logs d'activité</h1>
          <p className="text-sm text-gray-500 mt-0.5">Journal cross-tenant en temps réel</p>
        </motion.div>
        <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          onClick={() => refetch()}
          className={cn('flex items-center gap-2 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors',
            isFetching && 'opacity-60 cursor-not-allowed')}>
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          Actualiser
        </motion.button>
      </div>

      {/* Stats cards */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total logs', value: data?.meta.total ?? 0, color: 'bg-violet-50 text-violet-600 border-violet-100' },
          { label: 'Connexions', value: allLogs.filter(l => getActionCategory(l.action) === 'login').length, color: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
          { label: 'Modifications', value: allLogs.filter(l => ['create','update','delete'].includes(getActionCategory(l.action))).length, color: 'bg-blue-50 text-blue-600 border-blue-100' },
          { label: 'Suppressions', value: allLogs.filter(l => getActionCategory(l.action) === 'delete').length, color: 'bg-red-50 text-red-600 border-red-100' },
        ].map(card => (
          <div key={card.label} className={cn('rounded-xl border p-4', card.color)}>
            <p className="text-2xl font-bold">{card.value.toLocaleString('fr-FR')}</p>
            <p className="text-xs font-medium mt-1 opacity-70">{card.label}</p>
          </div>
        ))}
      </motion.div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher action, tenant, entité..."
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X size={13} />
          </button>}
        </div>
        <div className="flex gap-2 flex-wrap">
          {[
            { value: '', label: 'Tout' },
            { value: 'login', label: 'Connexions' },
            { value: 'create', label: 'Créations' },
            { value: 'update', label: 'Modifications' },
            { value: 'delete', label: 'Suppressions' },
          ].map(f => (
            <button key={f.value} onClick={() => setActionFilter(f.value)}
              className={cn('px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors border',
                actionFilter === f.value
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Logs list */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}
        className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(8)].map((_, i) => <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Activity size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Aucun log trouvé</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((log, idx) => {
              const cat = getActionCategory(log.action)
              const Icon = ACTION_ICONS[cat] ?? Activity
              const colorCls = ACTION_COLORS[cat] ?? 'bg-gray-100 text-gray-500'
              return (
                <motion.div key={log.id ?? idx}
                  initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.015 }}
                  className="flex items-start gap-4 px-5 py-3.5 hover:bg-gray-50/60 transition-colors">
                  {/* Icon */}
                  <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5', colorCls)}>
                    <Icon size={13} />
                  </div>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{log.action}</span>
                      {log.entity_type && (
                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{log.entity_type}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <div className="flex items-center gap-1 text-xs text-gray-400">
                        <Building2 size={10} />
                        <span>{log.tenant_name}</span>
                      </div>
                      {log.ip_address && (
                        <span className="text-xs text-gray-400 font-mono">{String(log.ip_address)}</span>
                      )}
                    </div>
                  </div>
                  {/* Timestamp */}
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-gray-400">{timeAgo(log.created_at)}</p>
                    <p className="text-[10px] text-gray-300 mt-0.5">{new Date(log.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </motion.div>
              )
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3.5 border-t border-gray-50 bg-gray-50/50">
            <p className="text-xs text-gray-400">Page {page} sur {totalPages}</p>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="p-1.5 rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-100 transition-colors">
                <ChevronLeft size={14} />
              </button>
              <span className="text-xs font-medium text-gray-600 px-2">{page}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="p-1.5 rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-100 transition-colors">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}
