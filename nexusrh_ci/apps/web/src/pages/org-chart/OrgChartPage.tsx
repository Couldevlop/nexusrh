import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Network, FileDown, Image as ImageIcon, Users, ChevronDown, ChevronRight, Building2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types (miroir de apps/api/src/modules/org-chart/org-chart.service.ts) ───
interface DeptNode {
  id: string
  name: string
  code: string | null
  managerName: string | null
  headcount: number
  totalHeadcount: number
  children: DeptNode[]
}
interface EmpNode {
  id: string
  name: string
  title: string | null
  departmentName: string | null
  photoUrl: string | null
  children: EmpNode[]
}

type Tab = 'departments' | 'reporting'

// ─── Téléchargement d'un export (PDF/SVG) — porte le Bearer via l'intercepteur ─
// Chemins littéraux (pas de template partiel) pour rester vérifiables par le
// golden de contrat UI↔API (chaque appel doit cibler un endpoint réel).
async function downloadExport(type: Tab, format: 'pdf' | 'svg'): Promise<void> {
  const res = format === 'pdf'
    ? await api.get(`/org-chart/export.pdf?type=${type}`, { responseType: 'blob' })
    : await api.get(`/org-chart/export.svg?type=${type}`, { responseType: 'blob' })
  const url = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `organigramme-${type}.${format}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

type Tt = (k: string, o?: Record<string, unknown>) => string

function initials(name: string): string {
  const parts = name.split(' ').filter(Boolean)
  return (parts.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')) || '?'
}

// ─── Carte d'un nœud (style organigramme professionnel) ──────────────────────
function OrgCard(props: {
  title: string; subtitle?: string; meta?: string
  avatar?: string; icon?: React.ReactNode
  hasChildren: boolean; collapsed: boolean; childCount: number; onToggle: () => void
}) {
  return (
    <div className="org-node">
      <div className="relative inline-flex w-52 flex-col rounded-xl border border-border bg-card px-3 py-2.5 text-left shadow-sm transition-shadow hover:shadow-md">
        <div className="flex items-center gap-2.5">
          {props.avatar !== undefined ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{props.avatar}</div>
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{props.icon}</div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{props.title}</p>
            {props.subtitle && <p className="truncate text-xs text-muted-foreground">{props.subtitle}</p>}
          </div>
        </div>
        {props.meta && (
          <span className="mt-1.5 inline-flex w-fit items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{props.meta}</span>
        )}
        {props.hasChildren && (
          <button
            type="button"
            onClick={props.onToggle}
            aria-label="toggle"
            className="absolute -bottom-2.5 left-1/2 z-10 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center gap-0.5 rounded-full border border-border bg-card px-1 text-[10px] font-bold text-muted-foreground shadow-sm hover:text-foreground"
          >
            {props.collapsed ? <>{props.childCount}<ChevronRight className="h-3 w-3" /></> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>
    </div>
  )
}

function DeptOrgNode({ node, collapsed, toggle, t }: { node: DeptNode; collapsed: Set<string>; toggle: (id: string) => void; t: Tt }) {
  const isCollapsed = collapsed.has(node.id)
  const hasChildren = node.children.length > 0
  return (
    <li>
      <OrgCard
        title={node.code ? `${node.name} (${node.code})` : node.name}
        subtitle={node.managerName ? t('node.manager', { name: node.managerName }) : t('node.noManager')}
        meta={t('node.headcount', { count: node.totalHeadcount })}
        icon={<Building2 className="h-4 w-4" />}
        hasChildren={hasChildren} collapsed={isCollapsed} childCount={node.children.length}
        onToggle={() => toggle(node.id)}
      />
      {hasChildren && !isCollapsed && (
        <ul>{node.children.map((c) => <DeptOrgNode key={c.id} node={c} collapsed={collapsed} toggle={toggle} t={t} />)}</ul>
      )}
    </li>
  )
}

function EmpOrgNode({ node, collapsed, toggle, t }: { node: EmpNode; collapsed: Set<string>; toggle: (id: string) => void; t: Tt }) {
  const isCollapsed = collapsed.has(node.id)
  const hasChildren = node.children.length > 0
  return (
    <li>
      <OrgCard
        title={node.name}
        subtitle={node.title ?? t('node.noTitle')}
        meta={node.departmentName ?? undefined}
        avatar={initials(node.name)}
        hasChildren={hasChildren} collapsed={isCollapsed} childCount={node.children.length}
        onToggle={() => toggle(node.id)}
      />
      {hasChildren && !isCollapsed && (
        <ul>{node.children.map((c) => <EmpOrgNode key={c.id} node={c} collapsed={collapsed} toggle={toggle} t={t} />)}</ul>
      )}
    </li>
  )
}

export default function OrgChartPage() {
  const { t } = useTranslation('orgChart')
  const [tab, setTab] = useState<Tab>('departments')
  const [exporting, setExporting] = useState(false)

  const deptQ = useQuery({
    queryKey: ['org-chart', 'departments'],
    queryFn: async () => {
      const res = await api.get('/org-chart/departments')
      return (res.data as { data: DeptNode[] }).data
    },
  })
  const repQ = useQuery({
    queryKey: ['org-chart', 'reporting'],
    queryFn: async () => {
      const res = await api.get('/org-chart/reporting')
      return (res.data as { data: EmpNode[] }).data
    },
  })

  const active = tab === 'departments' ? deptQ : repQ
  const isEmpty = !active.isLoading && !active.isError && (active.data?.length ?? 0) === 0

  // Repli/dérepli des branches (par id de nœud) — ergonomie des grands arbres.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  async function handleExport(format: 'pdf' | 'svg') {
    try {
      setExporting(true)
      await downloadExport(tab, format)
    } finally {
      setExporting(false)
    }
  }

  const TabButton = ({ value, label }: { value: Tab; label: string }) => (
    <button
      type="button"
      onClick={() => setTab(value)}
      className={cn(
        'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="p-6 space-y-6">
      {/* En-tête */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Network className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={exporting || isEmpty}
            onClick={() => handleExport('pdf')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" /> {t('export.pdf')}
          </button>
          <button
            type="button"
            disabled={exporting || isEmpty}
            onClick={() => handleExport('svg')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            <ImageIcon className="h-4 w-4" /> {t('export.svg')}
          </button>
        </div>
      </div>

      {/* Onglets */}
      <div className="flex gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
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
          <div className="overflow-x-auto pb-4">
            <div className="orgchart">
              <ul>
                {tab === 'departments'
                  ? (deptQ.data ?? []).map((n) => <DeptOrgNode key={n.id} node={n} collapsed={collapsed} toggle={toggle} t={t} />)
                  : (repQ.data ?? []).map((n) => <EmpOrgNode key={n.id} node={n} collapsed={collapsed} toggle={toggle} t={t} />)}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
