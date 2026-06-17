import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Network, FileDown, Image as ImageIcon, Users, Building2, ChevronRight, ChevronDown, Home } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types (miroir de apps/api/src/modules/org-chart/org-chart.service.ts) ───
interface DeptNode {
  id: string; name: string; code: string | null; managerName: string | null
  headcount: number; totalHeadcount: number; children: DeptNode[]
}
interface EmpNode {
  id: string; name: string; title: string | null; departmentName: string | null
  photoUrl: string | null; children: EmpNode[]
}
type Tab = 'departments' | 'reporting'
type AnyNode = { id: string; children: AnyNode[] }

// Forme normalisée pour le rendu (indépendante de dept vs employé).
interface ViewNode {
  id: string; title: string; subtitle: string; meta: string | null
  avatar: string | null; isDept: boolean; childrenCount: number
}

function initials(name: string): string {
  const parts = name.split(' ').filter(Boolean)
  return (parts.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')) || '?'
}

// ─── Téléchargement d'un export (PDF/SVG) ────────────────────────────────────
async function downloadExport(type: Tab, format: 'pdf' | 'svg'): Promise<void> {
  const res = format === 'pdf'
    ? await api.get(`/org-chart/export.pdf?type=${type}`, { responseType: 'blob' })
    : await api.get(`/org-chart/export.svg?type=${type}`, { responseType: 'blob' })
  const url = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url; a.download = `organigramme-${type}.${format}`
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// ─── Indexation d'un arbre (recherche + chemin d'ancêtres) ───────────────────
function buildMaps<T extends AnyNode>(roots: T[]): { byId: Map<string, T>; parent: Map<string, string | null> } {
  const byId = new Map<string, T>()
  const parent = new Map<string, string | null>()
  const walk = (n: T, p: string | null) => {
    byId.set(n.id, n); parent.set(n.id, p)
    for (const c of n.children) walk(c as T, n.id)
  }
  for (const r of roots) walk(r, null)
  return { byId, parent }
}
function pathTo<T extends AnyNode>(byId: Map<string, T>, parent: Map<string, string | null>, id: string | null): T[] {
  const out: T[] = []
  let cur = id
  while (cur) {
    const n = byId.get(cur)
    if (!n) break
    out.unshift(n)
    cur = parent.get(cur) ?? null
  }
  return out
}

// ─── Carte cliquable d'un membre / responsable ───────────────────────────────
function TeamCard({ node, t, head, onOpen }: { node: ViewNode; t: (k: string, o?: Record<string, unknown>) => string; head?: boolean; onOpen?: () => void }) {
  const clickable = node.childrenCount > 0 && !!onOpen
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!clickable}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-left transition-all',
        head ? 'border-primary/40 shadow-sm ring-1 ring-primary/20' : 'border-border',
        clickable ? 'cursor-pointer hover:border-primary/50 hover:shadow-md' : 'cursor-default',
      )}
    >
      {node.avatar !== null ? (
        <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary', head ? 'h-12 w-12 text-sm' : 'h-10 w-10 text-xs')}>{node.avatar}</div>
      ) : (
        <div className={cn('flex shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary', head ? 'h-12 w-12' : 'h-10 w-10')}><Building2 className="h-5 w-5" /></div>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-semibold text-foreground', head ? 'text-base' : 'text-sm')}>{node.title}</p>
        <p className="truncate text-xs text-muted-foreground">{node.subtitle}</p>
        {node.meta && <p className="mt-0.5 text-[11px] font-medium text-primary">{node.meta}</p>}
      </div>
      {clickable && (
        <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary">
          {node.childrenCount}<ChevronRight className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  )
}

export default function OrgChartPage() {
  const { t } = useTranslation('orgChart')
  const [tab, setTab] = useState<Tab>('departments')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const deptQ = useQuery({
    queryKey: ['org-chart', 'departments'],
    queryFn: async () => (await api.get('/org-chart/departments')).data.data as DeptNode[],
  })
  const repQ = useQuery({
    queryKey: ['org-chart', 'reporting'],
    queryFn: async () => (await api.get('/org-chart/reporting')).data.data as EmpNode[],
  })

  const active = tab === 'departments' ? deptQ : repQ
  const roots = (active.data ?? []) as AnyNode[]
  const isEmpty = !active.isLoading && !active.isError && roots.length === 0

  const { byId, parent } = useMemo(() => buildMaps(roots), [roots])
  const focusNode = focusId ? byId.get(focusId) ?? null : null
  const breadcrumb = useMemo(() => pathTo(byId, parent, focusId), [byId, parent, focusId])
  // Équipe affichée : enfants du nœud focalisé, sinon les racines.
  const teamNodes = (focusNode ? focusNode.children : roots)

  // Normalisation dept/employé → ViewNode.
  const toView = (n: AnyNode): ViewNode => {
    if (tab === 'departments') {
      const d = n as unknown as DeptNode
      return {
        id: d.id, title: d.code ? `${d.name} (${d.code})` : d.name,
        subtitle: d.managerName ? t('node.manager', { name: d.managerName }) : t('node.noManager'),
        meta: t('node.headcount', { count: d.totalHeadcount }),
        avatar: null, isDept: true, childrenCount: d.children.length,
      }
    }
    const e = n as unknown as EmpNode
    return {
      id: e.id, title: e.name, subtitle: e.title ?? t('node.noTitle'),
      meta: e.departmentName, avatar: initials(e.name), isDept: false, childrenCount: e.children.length,
    }
  }

  function switchTab(v: Tab) { setTab(v); setFocusId(null) }
  async function handleExport(format: 'pdf' | 'svg') {
    try { setExporting(true); await downloadExport(tab, format) } finally { setExporting(false) }
  }

  const TabButton = ({ value, label }: { value: Tab; label: string }) => (
    <button type="button" onClick={() => switchTab(value)}
      className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>
      {label}
    </button>
  )

  return (
    <div className="p-6 space-y-6">
      {/* En-tête */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Network className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={exporting || isEmpty} onClick={() => handleExport('pdf')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50">
            <FileDown className="h-4 w-4" /> {t('export.pdf')}
          </button>
          <button type="button" disabled={exporting || isEmpty} onClick={() => handleExport('svg')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50">
            <ImageIcon className="h-4 w-4" /> {t('export.svg')}
          </button>
        </div>
      </div>

      {/* Onglets */}
      <div className="flex w-fit gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
        <TabButton value="departments" label={t('tabs.departments')} />
        <TabButton value="reporting" label={t('tabs.reporting')} />
      </div>

      {/* Contenu */}
      <div className="rounded-xl border border-border bg-card p-4">
        {active.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
        {active.isError && <p className="py-10 text-center text-sm text-destructive">{t('loadError')}</p>}
        {isEmpty && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        )}

        {!active.isLoading && !active.isError && !isEmpty && (
          <div className="space-y-4">
            {/* Fil d'Ariane */}
            <nav className="flex flex-wrap items-center gap-1 text-sm">
              <button type="button" onClick={() => setFocusId(null)}
                className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent', !focusId && 'font-semibold text-primary')}>
                <Home className="h-3.5 w-3.5" /> {t('team.root')}
              </button>
              {breadcrumb.map((n) => {
                const v = toView(n)
                const isLast = n.id === focusId
                return (
                  <span key={n.id} className="flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <button type="button" onClick={() => setFocusId(n.id)}
                      className={cn('rounded-md px-2 py-1 hover:bg-accent', isLast && 'font-semibold text-primary')}>
                      {v.title}
                    </button>
                  </span>
                )
              })}
            </nav>

            {/* Responsable focalisé (tête d'équipe) */}
            {focusNode && (
              <div className="max-w-md">
                <TeamCard node={toView(focusNode)} t={t} head />
              </div>
            )}

            {/* Équipe directe */}
            <div>
              {focusNode && (
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <ChevronDown className="h-3.5 w-3.5" /> {t('team.members', { count: teamNodes.length })}
                </p>
              )}
              {teamNodes.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('team.empty')}</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {teamNodes.map((n) => (
                    <TeamCard key={n.id} node={toView(n)} t={t} onOpen={() => setFocusId(n.id)} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
