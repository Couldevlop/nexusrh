import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { PayrollWorkflowModal, formatDateTime as formatDueDate, type PendingWith } from './PayrollWorkflowModal'
import {
  Building2, Send, Loader2, CheckCircle2, Lock, Layers,
  PlayCircle, ShieldCheck, ChevronRight, AlertTriangle,
  History, ChevronDown, Clock, User, UserCheck, XCircle, Undo2, X,
} from 'lucide-react'

/**
 * Page RH CENTRALE — pilotage de la paie multi-filiales (tenants à filiales).
 *
 * Rend le processus transparent de bout en bout :
 *   1. Initier le draft du mois (POST /payroll-workflow/periods) → draft_central
 *   2. Décliner aux filiales (POST .../send-to-sites) → une période fille par
 *      filiale active, assignée à son RAF (sent_to_sites)
 *   3. Suivre la PROGRESSION : chaque RAF soumet sa filiale (completed_by_site).
 *      La frise montre en temps réel quelle filiale a soumis / reste en attente.
 *   4. Consolider (POST .../validate-central) quand toutes les filiales ont
 *      soumis → validated_central + somme des totaux. La consolidation INITIE
 *      le circuit de validation nominatif (mêmes règles que la paie
 *      mono-entité : valideur désigné par niveau, échéance, escalade, SoD).
 *   5. Circuit de validation (modale commune, pilotée par `viewer` de l'API) :
 *      valider le niveau courant, rejeter (commentaire obligatoire) ou annuler
 *      l'initiation ; la dernière validation clôture la parente ET les filles.
 *
 * « Mes validations » ouvre directement le circuit : ?validate=<id parente>.
 * Les RAF, eux, utilisent /raf/periods (soumission de leur filiale uniquement).
 */

interface WfPeriod {
  id: string
  month: string
  status: string
  parent_period_id: string | null
  legal_entity_id: string | null
  legal_entity_name: string | null
  legislation_pack_code: string | null
  raf_user_id: string | null
  total_gross: string | null
  total_net: string | null
  total_cnps: string | null
  total_its: string | null
  sent_to_sites_at: string | null
  completed_by_site_at: string | null
  validated_central_at: string | null
  closed_at: string | null
  rejection_reason?: string | null
  /** Paie consolidée en attente de validation : valideur attendu (calculé par l'API). */
  pending_with?: PendingWith | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Rôles qui pilotent la paie centrale (initier, décliner, consolider). */
const CENTRAL_ROLES = ['admin', 'hr_manager']

const STATUS_COLOR: Record<string, string> = {
  draft_central:     'bg-slate-100 text-slate-700 border-slate-200',
  sent_to_sites:     'bg-amber-100 text-amber-800 border-amber-200',
  completed_by_site: 'bg-blue-100 text-blue-800 border-blue-200',
  validated_central: 'bg-green-100 text-green-800 border-green-200',
  closed:            'bg-gray-200 text-gray-700 border-gray-300',
}

// Étapes de la frise parent (l'ordre du workflow central).
const PARENT_STEPS = [
  { key: 'draft_central',     labelKey: 'multiSites.steps.draft',        icon: PlayCircle },
  { key: 'sent_to_sites',     labelKey: 'multiSites.steps.declined',     icon: Send },
  { key: 'validated_central', labelKey: 'multiSites.steps.consolidated', icon: ShieldCheck },
  { key: 'closed',            labelKey: 'multiSites.steps.closed',       icon: Lock },
]
const SUBMITTED_STATES = ['completed_by_site', 'validated_central', 'closed']

function currentMonthValue(): string {
  // type=month → 'YYYY-MM' ; on évite Date.now() côté SSR mais ici c'est le client.
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
}

export default function PayrollMultiSitesPage() {
  const { t } = useTranslation('payroll')
  const qc = useQueryClient()
  const [month, setMonth] = useState(currentMonthValue())
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Suivi transparent : id du draft dont la chronologie est dépliée (null = aucune)
  const [openTimelineId, setOpenTimelineId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const role = useAuthStore(s => s.user?.role)
  const canManage = !!role && CENTRAL_ROLES.includes(role)

  // Circuit de validation ouvert (période parente) ; « Mes validations » → ?validate=<id>
  const [searchParams, setSearchParams] = useSearchParams()
  const [circuitId, setCircuitId] = useState<string | null>(null)
  useEffect(() => {
    const id = searchParams.get('validate')
    if (id && UUID_RE.test(id)) setCircuitId(id)
  }, [searchParams])
  const closeCircuit = () => {
    setCircuitId(null)
    if (searchParams.has('validate')) {
      const next = new URLSearchParams(searchParams)
      next.delete('validate')
      setSearchParams(next, { replace: true })
    }
  }

  const { data, isLoading } = useQuery<{ data: WfPeriod[] }>({
    queryKey: ['wf-periods'],
    queryFn: () => api.get('/payroll-workflow/periods').then(r => r.data),
  })

  const invalidate = () => { setErrorMsg(null); qc.invalidateQueries({ queryKey: ['wf-periods'] }) }
  const onError = (fallback: string) => (err: unknown) => setErrorMsg(apiError(err, fallback))
  const pendingText = (month: string, pw: PendingWith | null | undefined) => pw?.name
    ? t('close.pendingWithNamed', { month, name: pw.name, fn: pw.functionLabel ?? '' })
    : t('close.pendingWithTeam', { month })

  const createDraft = useMutation({
    mutationFn: (m: string) => api.post('/payroll-workflow/periods', { month: m }),
    onSuccess: invalidate,
    onError: onError(t('multiSites.errors.createDraft')),
  })
  const sendToSites = useMutation({
    mutationFn: (id: string) => api.post(`/payroll-workflow/periods/${id}/send-to-sites`, {}),
    onSuccess: invalidate,
    onError: onError(t('multiSites.errors.sendToSites')),
  })
  // Consolidation = initiation du circuit : message « Période … en attente de validation par … »
  const validateCentral = useMutation({
    mutationFn: (p: { id: string; month: string }) =>
      api.post(`/payroll-workflow/periods/${p.id}/validate-central`)
        .then(r => ({ month: p.month, pendingWith: (r.data as { pendingWith?: PendingWith | null }).pendingWith ?? null })),
    onSuccess: ({ month: m, pendingWith }) => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['approvals-pending'] })
      setNotice(`${t('multiSites.consolidatedNotice', { month: m })} ${pendingText(m, pendingWith)}.`)
    },
    onError: onError(t('multiSites.errors.consolidate')),
  })
  const busy = createDraft.isPending || sendToSites.isPending || validateCentral.isPending

  const periods = data?.data ?? []
  const parents = periods
    .filter(p => !p.parent_period_id)
    .sort((a, b) => b.month.localeCompare(a.month))
  const childrenOf = (parentId: string) => periods.filter(p => p.parent_period_id === parentId)
  const circuitParent = circuitId ? parents.find(p => p.id === circuitId) : undefined

  return (
    <div className="p-6 space-y-6">
      {/* En-tête */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Layers className="h-6 w-6" /> {t('multiSites.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('multiSites.subtitle')}
        </p>
      </div>

      <p className="text-xs text-muted-foreground flex items-start gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {t('multiSites.circuitHint')}
      </p>

      {notice && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start justify-between gap-2">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label={t('workflow.cancel')} className="opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Initier le draft du mois (RH centrale) */}
      {canManage && <div className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs font-semibold text-muted-foreground mb-1">{t('multiSites.monthLabel')}</label>
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="w-full sm:w-56 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => createDraft.mutate(month)}
          disabled={busy || !month}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {createDraft.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
          {t('multiSites.initDraft')}
        </button>
      </div>}

      {errorMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {isLoading && (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-muted-foreground">
          {t('multiSites.loading')}
        </div>
      )}

      {!isLoading && parents.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card px-4 py-10 text-center text-muted-foreground">
          {t('multiSites.emptyParents')}
        </div>
      )}

      {/* Une carte par période parente (mois) */}
      <div className="space-y-5">
        {parents.map(parent => {
          const kids = childrenOf(parent.id)
          const total = kids.length
          const submitted = kids.filter(k => SUBMITTED_STATES.includes(k.status)).length
          const allSubmitted = total > 0 && submitted === total
          const stepIndex = PARENT_STEPS.findIndex(s => s.key === parent.status)
          const pct = total > 0 ? Math.round((submitted / total) * 100) : 0

          return (
            <div key={parent.id} className="rounded-xl border border-border bg-card overflow-hidden">
              {/* Bandeau parent */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-semibold capitalize">{formatMonth(parent.month)}</h2>
                  <StatusBadge status={parent.status} />
                </div>
                <div className="flex items-center gap-2">
                  {/* Suivi transparent : chronologie nominative du draft (lecture seule) */}
                  <button
                    onClick={() => setOpenTimelineId(prev => prev === parent.id ? null : parent.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50"
                    title={t('multiSites.trackTitle')}
                  >
                    <History className="h-3.5 w-3.5" />
                    {t('multiSites.track')}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${openTimelineId === parent.id ? 'rotate-180' : ''}`} />
                  </button>
                  {canManage && parent.status === 'draft_central' && (
                    <ActionBtn
                      onClick={() => sendToSites.mutate(parent.id)}
                      loading={sendToSites.isPending} disabled={busy}
                      icon={Send} label={t('multiSites.sendToSites')}
                    />
                  )}
                  {canManage && parent.status === 'sent_to_sites' && (
                    <ActionBtn
                      onClick={() => validateCentral.mutate({ id: parent.id, month: parent.month })}
                      loading={validateCentral.isPending}
                      disabled={busy || !allSubmitted}
                      icon={ShieldCheck}
                      label={allSubmitted ? t('multiSites.consolidate') : t('multiSites.consolidatePartial', { submitted, total })}
                    />
                  )}
                  {/* Circuit de validation : droits (valider / rejeter / annuler) calculés par l'API */}
                  {(parent.status === 'validated_central' || parent.status === 'closed') && (
                    <ActionBtn
                      onClick={() => setCircuitId(parent.id)}
                      loading={false} disabled={false}
                      icon={parent.status === 'closed' ? Lock : UserCheck} label={t('multiSites.openCircuit')}
                    />
                  )}
                </div>
              </div>

              {/* Paie consolidée : valideur attendu + échéance */}
              {parent.status === 'validated_central' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-amber-50 px-4 py-2 text-xs text-amber-900">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <UserCheck className="h-3.5 w-3.5" />
                    {parent.pending_with?.name
                      ? t('history.pendingWith', { name: parent.pending_with.name, fn: parent.pending_with.functionLabel ?? '' })
                      : t('history.pendingWithTeam')}
                  </span>
                  {parent.pending_with && (
                    <span>{t('history.levelProgress', { level: parent.pending_with.level, total: parent.pending_with.requiredLevels })}</span>
                  )}
                  {parent.pending_with?.dueAt && (
                    <span className={parent.pending_with.overdue ? 'font-medium text-red-600' : ''}>
                      {t('history.dueAt', { date: formatDueDate(parent.pending_with.dueAt) })}
                      {parent.pending_with.overdue ? ` · ${t('history.overdue')}` : ''}
                    </span>
                  )}
                </div>
              )}
              {parent.status === 'sent_to_sites' && parent.rejection_reason && (
                <p className="border-b border-border bg-destructive/5 px-4 py-2 text-xs italic text-destructive">
                  {t('multiSites.rejected', { reason: parent.rejection_reason })}
                </p>
              )}

              {/* Frise d'étapes parent */}
              <div className="flex items-center gap-1 px-4 py-3 overflow-x-auto">
                {PARENT_STEPS.map((step, i) => {
                  const done = i < stepIndex
                  const active = i === stepIndex
                  const Icon = step.icon
                  return (
                    <div key={step.key} className="flex items-center gap-1 shrink-0">
                      <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${
                        active ? 'bg-primary text-primary-foreground border-primary'
                        : done ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-muted text-muted-foreground border-border'
                      }`}>
                        {done ? <CheckCircle2 className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                        {t(step.labelKey)}
                      </div>
                      {i < PARENT_STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
                    </div>
                  )
                })}
              </div>

              {/* Barre de progression soumissions filiales */}
              {total > 0 && parent.status !== 'closed' && (
                <div className="px-4 pb-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>{t('multiSites.submissions')}</span>
                    <span className="tabular-nums">{submitted}/{total}</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${allSubmitted ? 'bg-green-500' : 'bg-amber-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Tableau des filiales (progression détaillée) */}
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left">
                    <th className="px-4 py-2 font-semibold">{t('multiSites.colSubsidiary')}</th>
                    <th className="px-4 py-2 font-semibold">{t('multiSites.colPack')}</th>
                    <th className="px-4 py-2 font-semibold">{t('multiSites.colRaf')}</th>
                    <th className="px-4 py-2 font-semibold">{t('multiSites.colStatus')}</th>
                    <th className="px-4 py-2 font-semibold text-right">{t('multiSites.colGross')}</th>
                    <th className="px-4 py-2 font-semibold text-right">{t('multiSites.colNet')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {total === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      {t('multiSites.notDeclined')}
                    </td></tr>
                  )}
                  {kids.map(k => (
                    <tr key={k.id} className="hover:bg-muted/20">
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          {k.legal_entity_name ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs font-mono">{k.legislation_pack_code ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        {k.raf_user_id
                          ? <span className="inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle2 className="h-3 w-3" /> {t('multiSites.rafAssigned')}</span>
                          : <span className="inline-flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3 w-3" /> {t('multiSites.rafUnassigned')}</span>}
                      </td>
                      <td className="px-4 py-2.5"><StatusBadge status={k.status} /></td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {k.total_gross ? formatFCFA(parseInt(k.total_gross)) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {k.total_net ? formatFCFA(parseInt(k.total_net)) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Total consolidé parent (après validate-central) */}
                {total > 0 && (parent.total_gross || parent.total_net) && (
                  <tfoot className="bg-muted/40 font-semibold">
                    <tr>
                      <td className="px-4 py-2.5" colSpan={4}>{t('multiSites.consolidatedTotal', { count: total })}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {parent.total_gross ? formatFCFA(parseInt(parent.total_gross)) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {parent.total_net ? formatFCFA(parseInt(parent.total_net)) : '—'}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>

              {/* Suivi transparent : chronologie nominative dépliable */}
              {openTimelineId === parent.id && (
                <DraftTimeline periodId={parent.id} />
              )}
            </div>
          )
        })}
      </div>

      {circuitParent && (
        <PayrollWorkflowModal
          target={{ kind: 'multi', periodId: circuitParent.id, month: circuitParent.month }}
          onClose={closeCircuit}
          onDone={(message) => { setNotice(message); closeCircuit() }}
        />
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('payroll')
  const color = STATUS_COLOR[status] ?? 'bg-muted text-foreground border-border'
  const label = STATUS_COLOR[status] ? t(`statuses.${status}`) : status
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${color}`}>
      {SUBMITTED_STATES.includes(status) && status !== 'sent_to_sites' && <CheckCircle2 className="h-3 w-3" />}
      {label}
    </span>
  )
}

function ActionBtn({
  onClick, loading, disabled, icon: Icon, label,
}: {
  onClick: () => void; loading: boolean; disabled: boolean
  icon: React.ElementType; label: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  )
}

// ── Suivi transparent du draft : chronologie nominative (lecture seule) ───────
interface WfEvent {
  action: string
  label: string
  actorName: string
  at: string
  filiale: string | null
  detail: Record<string, unknown>
}

const EVENT_ICON: Record<string, React.ElementType> = {
  'workflow.create_draft':     PlayCircle,
  'workflow.send_to_sites':    Send,
  'workflow.submit_by_raf':    Building2,
  'workflow.validate_central': ShieldCheck,
  'workflow.approve':          UserCheck,
  'workflow.reject':           XCircle,
  'workflow.cancel_initiation': Undo2,
  'workflow.close':            Lock,
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d)
}

function eventDetail(ev: WfEvent, t: TFunction): string | null {
  const d = ev.detail ?? {}
  const parts: string[] = []
  if (typeof d.sitesCount === 'number') parts.push(t('multiSites.timeline.detailSubsidiaries', { count: d.sitesCount }))
  if (typeof d.inserted === 'number') parts.push(t('multiSites.timeline.detailPayslips', { count: d.inserted }))
  if (typeof d.totalGross === 'number') parts.push(t('multiSites.timeline.detailGross', { amount: formatFCFA(d.totalGross) }))
  if (typeof d.sumGross === 'number') parts.push(t('multiSites.timeline.detailGrossConsolidated', { amount: formatFCFA(d.sumGross) }))
  if (typeof d.sumNet === 'number') parts.push(t('multiSites.timeline.detailNet', { amount: formatFCFA(d.sumNet) }))
  return parts.length > 0 ? parts.join(' · ') : null
}

function DraftTimeline({ periodId }: { periodId: string }) {
  const { t } = useTranslation('payroll')
  const { data, isLoading, isError } = useQuery<{
    data: { period: { month: string; status: string }; totalSites: number; events: WfEvent[] }
  }>({
    queryKey: ['wf-timeline', periodId],
    queryFn: () => api.get(`/payroll-workflow/periods/${periodId}/timeline`).then(r => r.data),
  })

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-3">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <History className="h-3.5 w-3.5" /> {t('multiSites.timeline.heading')}
      </h3>

      {isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('multiSites.timeline.loading')}
        </div>
      )}

      {isError && (
        <p className="py-2 text-sm text-destructive">{t('multiSites.timeline.error')}</p>
      )}

      {!isLoading && !isError && data && data.data.events.length === 0 && (
        <p className="py-2 text-sm text-muted-foreground">
          {t('multiSites.timeline.empty')}
        </p>
      )}

      {!isLoading && !isError && data && data.data.events.length > 0 && (
        <ol className="relative space-y-3 pl-5">
          {/* ligne verticale */}
          <span className="absolute left-1.5 top-1 bottom-1 w-px bg-border" aria-hidden />
          {data.data.events.map((ev, i) => {
            const Icon = EVENT_ICON[ev.action] ?? Clock
            const detail = eventDetail(ev, t)
            return (
              <li key={i} className="relative">
                <span className="absolute -left-[18px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-card">
                  <Icon className="h-2 w-2 text-primary" />
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-foreground">{ev.label}</span>
                  {ev.filiale && (
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      <Building2 className="h-2.5 w-2.5" /> {ev.filiale}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><User className="h-3 w-3" /> {ev.actorName}</span>
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {formatDateTime(ev.at)}</span>
                  {detail && <span className="text-muted-foreground/80">{detail}</span>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
