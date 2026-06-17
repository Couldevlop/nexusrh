import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Network, FileDown, Image as ImageIcon, Users, Building2,
  Plus, Minus, ZoomIn, ZoomOut, Maximize2, UnfoldVertical, FoldVertical,
} from 'lucide-react'
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

const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.4
const ZOOM_STEP = 0.1

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

// Tous les identifiants de nœuds ayant des subordonnés (pour « tout réduire »).
function collectParentIds(roots: AnyNode[]): string[] {
  const out: string[] = []
  const walk = (n: AnyNode) => { if (n.children.length > 0) { out.push(n.id); n.children.forEach(walk) } }
  roots.forEach(walk)
  return out
}

// ─── Carte d'un nœud (service ou collaborateur) ──────────────────────────────
function NodeBox({ v, head, isCollapsed, onToggle }: {
  v: ViewNode; head: boolean; isCollapsed: boolean; onToggle: () => void
}) {
  const hasChildren = v.childrenCount > 0
  return (
    <div
      className={cn(
        'relative flex w-56 flex-col items-center rounded-xl border bg-card px-3 py-3 text-center shadow-sm transition-all',
        head ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border',
      )}
    >
      {v.avatar !== null ? (
        <div className={cn('mb-1.5 flex items-center justify-center rounded-full bg-primary/10 font-bold text-primary',
          head ? 'h-12 w-12 text-sm' : 'h-10 w-10 text-xs')}>{v.avatar}</div>
      ) : (
        <div className={cn('mb-1.5 flex items-center justify-center rounded-lg bg-primary/10 text-primary',
          head ? 'h-12 w-12' : 'h-10 w-10')}><Building2 className="h-5 w-5" /></div>
      )}
      <p className={cn('w-full truncate font-semibold text-foreground', head ? 'text-sm' : 'text-[13px]')}>{v.title}</p>
      <p className="w-full truncate text-xs text-muted-foreground">{v.subtitle}</p>
      {v.meta && <p className="mt-0.5 w-full truncate text-[11px] font-medium text-primary">{v.meta}</p>}

      {hasChildren && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          className="absolute -bottom-3 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:text-primary"
        >
          {isCollapsed
            ? <span className="flex items-center text-[10px] font-bold leading-none"><Plus className="h-3 w-3" /></span>
            : <Minus className="h-3 w-3" />}
        </button>
      )}
      {hasChildren && isCollapsed && (
        <span className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
          {v.childrenCount}
        </span>
      )}
    </div>
  )
}

// ─── Nœud récursif de l'organigramme pyramidal ───────────────────────────────
function OrgNode({ node, toView, collapsed, onToggle, head = false }: {
  node: AnyNode
  toView: (n: AnyNode) => ViewNode
  collapsed: Set<string>
  onToggle: (id: string) => void
  head?: boolean
}) {
  const v = toView(node)
  const hasChildren = node.children.length > 0
  const isCollapsed = collapsed.has(node.id)
  const showChildren = hasChildren && !isCollapsed

  return (
    <div className="relative flex flex-col items-center">
      <NodeBox v={v} head={head} isCollapsed={isCollapsed} onToggle={() => onToggle(node.id)} />

      {showChildren && (
        <>
          {/* Tronc : ligne verticale descendant du nœud vers la barre de ses subordonnés */}
          <div className="h-7 w-px bg-border" />
          {/* Rangée des subordonnés */}
          <div className="flex items-start justify-center">
            {node.children.map((child, i) => {
              const single = node.children.length === 1
              return (
                <div key={child.id} className="relative flex flex-col items-center px-4 pt-7">
                  {/* Branche horizontale (demi-segment pour les extrémités) */}
                  {!single && (
                    <span className={cn('absolute top-0 h-px bg-border',
                      i === 0 ? 'left-1/2 right-0'
                        : i === node.children.length - 1 ? 'left-0 right-1/2'
                          : 'left-0 right-0')} />
                  )}
                  {/* Ramification verticale vers l'enfant */}
                  <span className="absolute left-1/2 top-0 h-7 w-px -translate-x-1/2 bg-border" />
                  <OrgNode node={child} toView={toView} collapsed={collapsed} onToggle={onToggle} />
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default function OrgChartPage() {
  const { t } = useTranslation('orgChart')
  const [tab, setTab] = useState<Tab>('departments')
  const [exporting, setExporting] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [zoom, setZoom] = useState(1)

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

  // Normalisation dept/employé → ViewNode.
  const toView = useCallback((n: AnyNode): ViewNode => {
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
  }, [tab, t])

  const allParentIds = useMemo(() => collectParentIds(roots), [roots])

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  const expandAll = () => setCollapsed(new Set())
  const collapseAll = () => setCollapsed(new Set(allParentIds))

  function switchTab(v: Tab) { setTab(v); setCollapsed(new Set()); setZoom(1) }
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

  const allCollapsed = allParentIds.length > 0 && allParentIds.every((id) => collapsed.has(id))

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

      {/* Onglets + contrôles */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-fit gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
          <TabButton value="departments" label={t('tabs.departments')} />
          <TabButton value="reporting" label={t('tabs.reporting')} />
        </div>
        {!isEmpty && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={allCollapsed ? expandAll : collapseAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
              {allCollapsed ? <UnfoldVertical className="h-3.5 w-3.5" /> : <FoldVertical className="h-3.5 w-3.5" />}
              {allCollapsed ? t('controls.expandAll') : t('controls.collapseAll')}
            </button>
            <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
              <button type="button" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
                disabled={zoom <= ZOOM_MIN} title={t('controls.zoomOut')}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40"><ZoomOut className="h-4 w-4" /></button>
              <button type="button" onClick={() => setZoom(1)} title={t('controls.zoomReset')}
                className="flex h-7 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold tabular-nums hover:bg-accent">{Math.round(zoom * 100)}%</button>
              <button type="button" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
                disabled={zoom >= ZOOM_MAX} title={t('controls.zoomIn')}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40"><ZoomIn className="h-4 w-4" /></button>
            </div>
          </div>
        )}
      </div>

      {/* Contenu */}
      <div className="rounded-xl border border-border bg-card">
        {active.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
        {active.isError && <p className="py-10 text-center text-sm text-destructive">{t('loadError')}</p>}
        {isEmpty && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        )}

        {!active.isLoading && !active.isError && !isEmpty && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 px-4 pt-3 text-xs text-muted-foreground">
              <Maximize2 className="h-3.5 w-3.5" /> {t('controls.hint')}
            </p>
            {/* Zone défilable : l'arbre peut être large/profond */}
            <div className="overflow-auto p-6">
              <div className="inline-block min-w-full origin-top" style={{ transform: `scale(${zoom})` }}>
                <div className="flex min-w-full items-start justify-center gap-10">
                  {roots.map((r) => (
                    <OrgNode key={r.id} node={r} toView={toView} collapsed={collapsed} onToggle={toggle} head />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
