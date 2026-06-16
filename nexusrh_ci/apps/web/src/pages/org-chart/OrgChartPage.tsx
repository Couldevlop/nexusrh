import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Network, FileDown, Image as ImageIcon, Users, ChevronDown, ChevronRight } from 'lucide-react'
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

// ─── Carte d'un nœud ─────────────────────────────────────────────────────────
function NodeCard({ title, subtitle, meta }: { title: string; subtitle?: string; meta?: string }) {
  return (
    <div className="rounded-lg border border-l-4 border-border border-l-primary bg-card px-3 py-2 shadow-sm">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      {meta && <p className="mt-0.5 text-[11px] font-medium text-primary">{meta}</p>}
    </div>
  )
}

// ─── Arbre récursif (indentation + connecteurs) ──────────────────────────────
function TreeNode({ children, render }: { children: React.ReactNode; render: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children
  return (
    <li className="relative">
      <div className="flex items-start gap-1.5">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="toggle"
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="mt-2 inline-block h-4 w-4 shrink-0" />
        )}
        <div className="flex-1">{render}</div>
      </div>
      {hasChildren && open && (
        <ul className="ml-5 mt-1.5 space-y-1.5 border-l border-dashed border-border pl-4">{children}</ul>
      )}
    </li>
  )
}

function DeptTree({ node, t }: { node: DeptNode; t: (k: string, o?: Record<string, unknown>) => string }) {
  return (
    <TreeNode
      render={
        <NodeCard
          title={node.code ? `${node.name} (${node.code})` : node.name}
          subtitle={node.managerName ? t('node.manager', { name: node.managerName }) : t('node.noManager')}
          meta={t('node.headcount', { count: node.totalHeadcount })}
        />
      }
    >
      {node.children.map((c) => (
        <DeptTree key={c.id} node={c} t={t} />
      ))}
    </TreeNode>
  )
}

function EmpTree({ node, t }: { node: EmpNode; t: (k: string, o?: Record<string, unknown>) => string }) {
  return (
    <TreeNode
      render={
        <NodeCard
          title={node.name}
          subtitle={node.title ?? t('node.noTitle')}
          meta={node.departmentName ?? undefined}
        />
      }
    >
      {node.children.map((c) => (
        <EmpTree key={c.id} node={c} t={t} />
      ))}
    </TreeNode>
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
    <div className="space-y-5">
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
          <ul className="space-y-1.5">
            {tab === 'departments'
              ? (deptQ.data ?? []).map((n) => <DeptTree key={n.id} node={n} t={t} />)
              : (repQ.data ?? []).map((n) => <EmpTree key={n.id} node={n} t={t} />)}
          </ul>
        )}
      </div>
    </div>
  )
}
