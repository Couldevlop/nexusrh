import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import {
  Building2, Send, Loader2, CheckCircle2, Lock, Layers,
  PlayCircle, ShieldCheck, ChevronRight, AlertTriangle,
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
 *      soumis → validated_central + somme des totaux
 *   5. Clôturer (POST .../close) → closed (terminal)
 *
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
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft_central:     { label: 'Brouillon',     color: 'bg-slate-100 text-slate-700 border-slate-200' },
  sent_to_sites:     { label: 'À compléter',   color: 'bg-amber-100 text-amber-800 border-amber-200' },
  completed_by_site: { label: 'Soumise',       color: 'bg-blue-100 text-blue-800 border-blue-200' },
  validated_central: { label: 'Consolidée',    color: 'bg-green-100 text-green-800 border-green-200' },
  closed:            { label: 'Clôturée',      color: 'bg-gray-200 text-gray-700 border-gray-300' },
}

// Étapes de la frise parent (l'ordre du workflow central).
const PARENT_STEPS = [
  { key: 'draft_central',     label: 'Brouillon',  icon: PlayCircle },
  { key: 'sent_to_sites',     label: 'Décliné',    icon: Send },
  { key: 'validated_central', label: 'Consolidé',  icon: ShieldCheck },
  { key: 'closed',            label: 'Clôturé',    icon: Lock },
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
  const qc = useQueryClient()
  const [month, setMonth] = useState(currentMonthValue())
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: WfPeriod[] }>({
    queryKey: ['wf-periods'],
    queryFn: () => api.get('/payroll-workflow/periods').then(r => r.data),
  })

  const invalidate = () => { setErrorMsg(null); qc.invalidateQueries({ queryKey: ['wf-periods'] }) }
  const onError = (fallback: string) => (err: unknown) => setErrorMsg(apiError(err, fallback))

  const createDraft = useMutation({
    mutationFn: (m: string) => api.post('/payroll-workflow/periods', { month: m }),
    onSuccess: invalidate,
    onError: onError('Impossible de créer le brouillon'),
  })
  const sendToSites = useMutation({
    mutationFn: (id: string) => api.post(`/payroll-workflow/periods/${id}/send-to-sites`, {}),
    onSuccess: invalidate,
    onError: onError('Échec de la déclinaison aux filiales'),
  })
  const validateCentral = useMutation({
    mutationFn: (id: string) => api.post(`/payroll-workflow/periods/${id}/validate-central`),
    onSuccess: invalidate,
    onError: onError('Échec de la consolidation'),
  })
  const closePeriod = useMutation({
    mutationFn: (id: string) => api.post(`/payroll-workflow/periods/${id}/close`),
    onSuccess: invalidate,
    onError: onError('Échec de la clôture'),
  })
  const busy = createDraft.isPending || sendToSites.isPending || validateCentral.isPending || closePeriod.isPending

  const periods = data?.data ?? []
  const parents = periods
    .filter(p => !p.parent_period_id)
    .sort((a, b) => b.month.localeCompare(a.month))
  const childrenOf = (parentId: string) => periods.filter(p => p.parent_period_id === parentId)

  return (
    <div className="p-6 space-y-6">
      {/* En-tête */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Layers className="h-6 w-6" /> Paie multi-filiales
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pilotage centralisé : initiez le brouillon du mois, déclinez-le aux filiales,
          suivez la soumission de chaque RAF, puis consolidez et clôturez.
        </p>
      </div>

      {/* Initier le draft du mois */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs font-semibold text-muted-foreground mb-1">Mois de paie</label>
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
          Initier le brouillon
        </button>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {isLoading && (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-muted-foreground">
          Chargement…
        </div>
      )}

      {!isLoading && parents.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card px-4 py-10 text-center text-muted-foreground">
          Aucune paie multi-filiales en cours. Choisissez un mois et cliquez « Initier le brouillon ».
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
                  {parent.status === 'draft_central' && (
                    <ActionBtn
                      onClick={() => sendToSites.mutate(parent.id)}
                      loading={sendToSites.isPending} disabled={busy}
                      icon={Send} label="Décliner aux filiales"
                    />
                  )}
                  {parent.status === 'sent_to_sites' && (
                    <ActionBtn
                      onClick={() => validateCentral.mutate(parent.id)}
                      loading={validateCentral.isPending}
                      disabled={busy || !allSubmitted}
                      icon={ShieldCheck}
                      label={allSubmitted ? 'Consolider la paie' : `Consolider (${submitted}/${total} soumises)`}
                    />
                  )}
                  {parent.status === 'validated_central' && (
                    <ActionBtn
                      onClick={() => closePeriod.mutate(parent.id)}
                      loading={closePeriod.isPending} disabled={busy}
                      icon={Lock} label="Clôturer la paie"
                    />
                  )}
                </div>
              </div>

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
                        {step.label}
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
                    <span>Soumissions des filiales</span>
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
                    <th className="px-4 py-2 font-semibold">Filiale</th>
                    <th className="px-4 py-2 font-semibold">Pack</th>
                    <th className="px-4 py-2 font-semibold">RAF</th>
                    <th className="px-4 py-2 font-semibold">Statut</th>
                    <th className="px-4 py-2 font-semibold text-right">Masse brute</th>
                    <th className="px-4 py-2 font-semibold text-right">Net à payer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {total === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      Pas encore décliné aux filiales. Cliquez « Décliner aux filiales ».
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
                          ? <span className="inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle2 className="h-3 w-3" /> assigné</span>
                          : <span className="inline-flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3 w-3" /> non assigné</span>}
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
                      <td className="px-4 py-2.5" colSpan={4}>Total consolidé ({total} filiale{total > 1 ? 's' : ''})</td>
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
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, color: 'bg-muted text-foreground border-border' }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${meta.color}`}>
      {SUBMITTED_STATES.includes(status) && status !== 'sent_to_sites' && <CheckCircle2 className="h-3 w-3" />}
      {meta.label}
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
