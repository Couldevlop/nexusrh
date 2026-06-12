import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, formatDate } from '@/lib/api'
import {
  Activity, ChevronDown, AlertTriangle, CalendarRange, UserRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types (contrats GET /dg/activity et GET /dg/actors) ──────────────────────

type ActivityPeriod = 'day' | 'week' | 'month' | 'custom'

interface DgActor {
  id: string
  name: string
  role: string
  email: string
}

interface DgActivityItem {
  id: string
  action: string
  entityId: string | null
  userId: string
  userName: string
  userRole: string
  changes: Record<string, unknown> | null
  createdAt: string
}

interface DgActivityGroup {
  category: string
  count: number
  items: DgActivityItem[]
}

interface DgActivityData {
  from: string
  to: string
  userId: string | null
  totalActions: number
  groups: DgActivityGroup[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const KNOWN_CATEGORIES = [
  'payroll', 'payslip', 'absence', 'expense', 'employee', 'reporting', 'ai',
  'auth', 'settings', 'dg', 'recruitment', 'onboarding', 'training',
  'contract', 'cnps', 'user', 'mobile_money', 'career',
] as const

function formatDateTime(date: string): string {
  try {
    return new Intl.DateTimeFormat('fr-CI', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(date))
  } catch {
    return date
  }
}

/** Résumé lisible d'un objet `changes` d'audit (clé: valeur, tronqué). */
function summarizeChanges(changes: Record<string, unknown> | null): string {
  if (!changes || typeof changes !== 'object') return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(changes)) {
    let rendered: string
    if (value === null || value === undefined) {
      rendered = '—'
    } else if (typeof value === 'object') {
      try {
        rendered = JSON.stringify(value)
      } catch {
        rendered = '[…]'
      }
    } else {
      rendered = String(value)
    }
    if (rendered.length > 60) rendered = `${rendered.slice(0, 60)}…`
    parts.push(`${key}: ${rendered}`)
    if (parts.length >= 5) break
  }
  const summary = parts.join(' · ')
  return summary.length > 220 ? `${summary.slice(0, 220)}…` : summary
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DgActivityPage() {
  const { t } = useTranslation('dg')

  const [period, setPeriod] = useState<ActivityPeriod>('week')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [userId, setUserId] = useState('')
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({})

  const { data: actorsData } = useQuery<{ data: DgActor[] }>({
    queryKey: ['dg-actors'],
    queryFn: () => api.get('/dg/actors').then(r => r.data),
  })

  const customRangeReady = period !== 'custom' || (from !== '' && to !== '')

  const { data, isLoading, isError } = useQuery<{ data: DgActivityData }>({
    queryKey: ['dg-activity', period, from, to, userId],
    queryFn: () => {
      const params = new URLSearchParams()
      if (period === 'custom') {
        params.set('from', from)
        params.set('to', to)
      } else {
        params.set('period', period)
      }
      if (userId) params.set('userId', userId)
      return api.get(`/dg/activity?${params.toString()}`).then(r => r.data)
    },
    enabled: customRangeReady,
  })

  const actors = actorsData?.data ?? []
  const activity = data?.data

  const toggleCategory = (category: string) => {
    setOpenCategories(prev => ({ ...prev, [category]: !prev[category] }))
  }

  const categoryLabel = (category: string): string => {
    const known = (KNOWN_CATEGORIES as readonly string[]).includes(category)
    return known ? t(`activity.categories.${category}`) : category
  }

  const periodButtons: { value: ActivityPeriod; label: string }[] = [
    { value: 'day',    label: t('activity.filters.day') },
    { value: 'week',   label: t('activity.filters.week') },
    { value: 'month',  label: t('activity.filters.month') },
    { value: 'custom', label: t('activity.filters.custom') },
  ]

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5 lg:p-8 space-y-5 bg-background min-h-full">

      {/* ── En-tête ──────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2.5 mt-0.5">
          <Activity className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{t('activity.title')}</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t('activity.subtitle')}</p>
        </div>
      </div>

      {/* ── Filtres ──────────────────────────────────────────── */}
      <div className="rounded-2xl border bg-card p-4 shadow-sm flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
          {/* Responsable */}
          <div className="flex flex-col gap-1">
            <label htmlFor="dg-actor" className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <UserRound className="h-3.5 w-3.5" /> {t('activity.filters.actor')}
            </label>
            <select
              id="dg-actor"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              className="h-9 rounded-lg border bg-background px-3 text-sm min-w-[200px]"
            >
              <option value="">{t('activity.filters.allActors')}</option>
              {actors.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.role.replace('_', ' ')})</option>
              ))}
            </select>
          </div>

          {/* Période */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" /> {t('activity.period', { from: activity?.from ? formatDate(activity.from) : '—', to: activity?.to ? formatDate(activity.to) : '—' })}
            </span>
            <div className="flex rounded-lg border overflow-hidden">
              {periodButtons.map(b => (
                <button
                  key={b.value}
                  onClick={() => setPeriod(b.value)}
                  className={cn(
                    'px-3 h-9 text-sm font-medium transition-colors border-r last:border-r-0',
                    period === b.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-muted'
                  )}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {/* Plage personnalisée */}
          {period === 'custom' && (
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="dg-from" className="text-xs font-medium text-muted-foreground">{t('activity.filters.from')}</label>
                <input
                  id="dg-from" type="date" value={from}
                  onChange={e => setFrom(e.target.value)}
                  className="h-9 rounded-lg border bg-background px-3 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="dg-to" className="text-xs font-medium text-muted-foreground">{t('activity.filters.to')}</label>
                <input
                  id="dg-to" type="date" value={to}
                  onChange={e => setTo(e.target.value)}
                  className="h-9 rounded-lg border bg-background px-3 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        {/* Total */}
        {activity && (
          <div className="shrink-0 rounded-xl bg-primary/10 px-4 py-2">
            <p className="text-sm font-semibold text-primary">
              {t('activity.totalActions', { count: activity.totalActions })}
            </p>
          </div>
        )}
      </div>

      {/* ── Contenu ──────────────────────────────────────────── */}
      {isLoading && customRangeReady && (
        <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm">{t('activity.loading')}</p>
        </div>
      )}

      {isError && (
        <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertTriangle className="h-10 w-10 opacity-30" />
          <p className="text-sm font-medium">{t('activity.loadError')}</p>
        </div>
      )}

      {!isLoading && !isError && activity && activity.groups.length === 0 && (
        <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Activity className="h-10 w-10 opacity-20" />
          <p className="text-sm font-medium">{t('activity.empty')}</p>
        </div>
      )}

      {/* Groupes par catégorie (accordéon) */}
      {!isLoading && !isError && activity && activity.groups.length > 0 && (
        <div className="space-y-3">
          {activity.groups.map(group => {
            const isOpen = openCategories[group.category] === true
            return (
              <div key={group.category} className="rounded-2xl border bg-card shadow-sm overflow-hidden">
                <button
                  onClick={() => toggleCategory(group.category)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/40 transition-colors"
                  aria-expanded={isOpen}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-semibold truncate">{categoryLabel(group.category)}</span>
                    <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                      {group.count}
                    </span>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                </button>

                {isOpen && (
                  <div className="border-t overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/40 text-left text-xs text-muted-foreground uppercase tracking-wide">
                          <th className="px-5 py-3 whitespace-nowrap">{t('activity.table.date')}</th>
                          <th className="px-5 py-3 whitespace-nowrap">{t('activity.table.actor')}</th>
                          <th className="px-5 py-3 whitespace-nowrap">{t('activity.table.action')}</th>
                          <th className="px-5 py-3">{t('activity.table.details')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {group.items.map((item, i) => {
                          const details = summarizeChanges(item.changes)
                          return (
                            <tr key={item.id} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                              <td className="px-5 py-3 whitespace-nowrap font-mono text-xs">{formatDateTime(item.createdAt)}</td>
                              <td className="px-5 py-3 whitespace-nowrap">
                                <span className="font-medium">{item.userName}</span>
                                <span className="ml-1.5 text-xs text-muted-foreground capitalize">
                                  {item.userRole.replace('_', ' ')}
                                </span>
                              </td>
                              <td className="px-5 py-3">
                                <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
                                  {item.action}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-xs text-muted-foreground break-all">
                                {details !== '' ? details : t('activity.noDetails')}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
