import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatMonth } from '@/lib/api'
import {
  Loader2, Lock, CheckCircle2, XCircle, Clock, Shield, ShieldAlert, Users, AlertCircle, X, Undo2, UserCheck,
} from 'lucide-react'

/**
 * Circuit de validation NOMINATIF de la paie — modale commune aux deux flux :
 *  - mono-entité (écran Paie) : période du mois, statut « En validation » ;
 *  - multi-filiales (Paie multi-filiales) : période PARENTE consolidée
 *    (« Consolidée » = en attente de validation ; la validation finale clôture
 *    la parente et toutes les filiales).
 * Valideur attendu, échéance, historique des niveaux et actions (valider,
 * rejeter avec commentaire obligatoire, annuler l'initiation) sont pilotés par
 * l'objet `viewer` calculé par l'API — l'UI n'en duplique aucune règle.
 */

/** Période ciblée par le circuit. */
export type WorkflowTarget =
  | { kind: 'single'; month: string }
  | { kind: 'multi'; periodId: string; month: string }

/** Valideur attendu d'une période en validation (circuit nominatif, calculé par l'API). */
export interface PendingWith {
  level: number
  requiredLevels: number
  userId: string | null
  name: string | null
  functionLabel: string | null
  role: string | null
  dueAt: string | null
  overdue: boolean
  teamCanAct: boolean
}

interface WorkflowApproval {
  level: number
  approverId: string
  approverRole: string | null
  approverName: string | null
  approvedAt: string
  notes: string | null
}

interface WorkflowLevel {
  level: number
  status: 'approved' | 'current' | 'upcoming'
  validator: { userId: string; name: string | null; role: string | null; available: boolean } | null
  functionLabel: string | null
  slaDays: number
  dueAt: string | null
  overdue: boolean
  teamCanAct: boolean
  approval: (WorkflowApproval & { escalated: boolean }) | null
}

interface WorkflowViewer {
  canApprove: boolean
  canReject: boolean
  canCancel: boolean
  escalated: boolean
  deniedReason: 'initiator' | 'already_approved' | 'awaiting_designated' | 'role' | null
  deniedMessage: string | null
}

interface WorkflowState {
  period: { id: string; month: string; status: string; initiatedBy: string | null; initiatedAt: string | null; initiatorName: string | null }
  requiredLevels: number
  currentLevel: number
  isComplete: boolean
  approvals: WorkflowApproval[]
  levels?: WorkflowLevel[]
  pendingWith?: PendingWith | null
  viewer?: WorkflowViewer
}

type ApiError = { response?: { data?: { error?: string } } } | null

/** Date + heure courte (fr-CI). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-FR')
}

/** Statut d'une période (mono-entité ou paie multi-filiales). */
export function PayrollStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('payroll')
  const map: Record<string, { cls: string; Icon: typeof Lock }> = {
    open: { cls: 'bg-gray-100 text-gray-700', Icon: Clock },
    pending_validation: { cls: 'bg-amber-100 text-amber-800', Icon: ShieldAlert },
    closed: { cls: 'bg-green-100 text-green-700', Icon: CheckCircle2 },
    // Paie multi-filiales
    draft_central: { cls: 'bg-gray-100 text-gray-700', Icon: Clock },
    sent_to_sites: { cls: 'bg-gray-100 text-gray-700', Icon: Clock },
    completed_by_site: { cls: 'bg-blue-100 text-blue-800', Icon: CheckCircle2 },
    validated_central: { cls: 'bg-amber-100 text-amber-800', Icon: ShieldAlert },
  }
  const cfg = map[status] ?? map.open
  const { Icon, cls } = cfg!
  const label = map[status] ? t(`statuses.${status}`) : t('statuses.open')
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon className="h-3 w-3" /> {label}
    </span>
  )
}

export function PayrollWorkflowModal({ target, onClose, onDone }: { target: WorkflowTarget; onClose: () => void; onDone: (message: string) => void }) {
  const month = target.month
  const multi = target.kind === 'multi'
  const { t } = useTranslation('payroll')
  const queryClient = useQueryClient()
  const [notes, setNotes] = useState('')
  const [mode, setMode] = useState<'idle' | 'reject' | 'cancel'>('idle')
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')

  const { data, isLoading } = useQuery<WorkflowState>({
    queryKey: ['payroll-workflow', target.kind === 'multi' ? target.periodId : month],
    queryFn: () => (target.kind === 'multi'
      ? api.get(`/payroll-workflow/periods/${target.periodId}/workflow`)
      : api.get(`/payroll/periods/${month}/workflow`)
    ).then(r => r.data as WorkflowState),
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['payroll-workflow', target.kind === 'multi' ? target.periodId : month] })
    queryClient.invalidateQueries({ queryKey: [multi ? 'wf-periods' : 'payroll-periods'] })
    queryClient.invalidateQueries({ queryKey: ['approvals-pending'] })
  }

  const approveMut = useMutation({
    mutationFn: () => {
      const body = notes.trim() ? { notes: notes.trim() } : {}
      return target.kind === 'multi'
        ? api.post(`/payroll-workflow/periods/${target.periodId}/approve`, body)
        : api.post(`/payroll/periods/${month}/approve`, body)
    },
    onSuccess: () => { refresh(); setNotes('') },
  })

  const rejectMut = useMutation({
    mutationFn: () => target.kind === 'multi'
      ? api.post(`/payroll-workflow/periods/${target.periodId}/reject`, { reason: reason.trim() })
      : api.post(`/payroll/periods/${month}/reject`, { reason: reason.trim() }),
    onSuccess: () => {
      refresh()
      setMode('idle'); setReason('')
      onDone(t(multi ? 'multiSites.workflow.rejectedNotice' : 'workflow.rejectedNotice'))
    },
  })

  const cancelMut = useMutation({
    mutationFn: () => {
      const body = comment.trim() ? { comment: comment.trim() } : {}
      return target.kind === 'multi'
        ? api.post(`/payroll-workflow/periods/${target.periodId}/cancel`, body)
        : api.post(`/payroll/periods/${month}/cancel`, body)
    },
    onSuccess: () => {
      refresh()
      setMode('idle'); setComment('')
      onDone(t(multi ? 'multiSites.workflow.cancelledNotice' : 'workflow.cancelledNotice'))
    },
  })

  const viewer = data?.viewer
  const periodStatus = data?.period.status
  // Paie multi-filiales : « consolidée » = en attente de validation du circuit
  const pending = periodStatus === (multi ? 'validated_central' : 'pending_validation')
  const pendingWith = data?.pendingWith ?? null
  const canApprove = pending && !!viewer?.canApprove
  const canReject = pending && !!viewer?.canReject
  const canCancel = pending && !!viewer?.canCancel

  const approveError = (approveMut.error as ApiError)?.response?.data?.error
  const rejectError = (rejectMut.error as ApiError)?.response?.data?.error
  const cancelError = (cancelMut.error as ApiError)?.response?.data?.error

  // Niveaux à afficher : circuit nominatif de l'API (repli : niveaux génériques)
  const levels: WorkflowLevel[] = data?.levels ?? (data
    ? Array.from({ length: data.requiredLevels }, (_, i) => {
      const approval = data.approvals.find(a => a.level === i + 1)
      return {
        level: i + 1,
        status: approval ? 'approved' as const : i === data.currentLevel ? 'current' as const : 'upcoming' as const,
        validator: null, functionLabel: null, slaDays: 0, dueAt: null, overdue: false, teamCanAct: true,
        approval: approval ? { ...approval, escalated: false } : null,
      }
    })
    : [])

  const deniedText = (() => {
    if (!pending || !viewer?.deniedReason) return null
    switch (viewer.deniedReason) {
      case 'initiator': return t('workflow.sodInitiator')
      case 'already_approved': return t('workflow.sodAlreadyApproved')
      case 'awaiting_designated':
        return pendingWith?.name
          ? t('workflow.sodAwaitingDesignated', { name: pendingWith.name, fn: pendingWith.functionLabel ?? '', date: formatDateTime(pendingWith.dueAt) })
          : viewer.deniedMessage
      default: return t('workflow.sodRoleForbidden')
    }
  })()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              {t('workflow.title', { month: formatMonth(month) })}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('workflow.subtitle')}
            </p>
          </div>
          <button onClick={onClose} aria-label={t('workflow.cancel')} className="rounded-lg p-1 hover:bg-accent"><X className="h-5 w-5" /></button>
        </div>

        {isLoading || !data ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Statut global */}
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{t('workflow.currentStatus')}</p>
                  <div className="mt-1"><PayrollStatusBadge status={data.period.status} /></div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">{t('workflow.requiredLevels')}</p>
                  <p className="text-xl font-bold text-primary">{data.currentLevel} / {data.requiredLevels}</p>
                </div>
              </div>
              {/* Barre de progression */}
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(100, (data.currentLevel / Math.max(1, data.requiredLevels)) * 100)}%` }}
                />
              </div>
              {pending && (
                <p className="mt-3 flex items-center gap-1.5 text-sm font-medium">
                  <UserCheck className="h-4 w-4 text-primary" />
                  {pendingWith?.name
                    ? t('workflow.expectedValidator', { name: pendingWith.name, fn: pendingWith.functionLabel ?? '' })
                    : t('workflow.expectedTeam')}
                </p>
              )}
            </div>

            {/* Timeline */}
            <div>
              <h4 className="mb-3 text-sm font-semibold">{t('workflow.timeline')}</h4>
              <ol className="space-y-3">
                {/* Étape 0 : Initiation */}
                <li className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Users className="h-4 w-4" />
                  </div>
                  <div className="flex-1 rounded-lg border border-border bg-card p-3">
                    <p className="text-sm font-medium">{t(multi ? 'multiSites.workflow.initiated' : 'workflow.initiated')}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {data.period.initiatorName ?? (data.period.initiatedBy ? t('workflow.unknownUser', { id: data.period.initiatedBy.slice(0, 8) }) : t('workflow.unknown'))}
                      {' · '}
                      {formatDateTime(data.period.initiatedAt)}
                    </p>
                  </div>
                </li>

                {levels.map(lv => {
                  const who = lv.validator?.name
                    ? t('workflow.levelDesignated', { fn: lv.functionLabel ?? '', name: lv.validator.name })
                    : t('workflow.levelTeam')
                  if (lv.approval) {
                    const a = lv.approval
                    return (
                      <li key={lv.level} className="flex gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
                          <CheckCircle2 className="h-4 w-4" />
                        </div>
                        <div className="flex-1 rounded-lg border border-green-200 bg-green-50 p-3">
                          <p className="text-sm font-medium text-green-900">
                            {t('workflow.levelApproved', { level: lv.level })}
                            {lv.functionLabel ? ` — ${lv.functionLabel}` : ''}
                          </p>
                          <p className="text-xs text-green-700 mt-0.5">
                            {a.approverName ?? t('workflow.unknownUser', { id: a.approverId.slice(0, 8) })}
                            {a.escalated ? ` (${t('workflow.byEscalation')})` : ''}
                            {' · '}
                            {formatDateTime(a.approvedAt)}
                          </p>
                          {a.notes && <p className="mt-1 text-xs italic text-green-800">"{a.notes}"</p>}
                        </div>
                      </li>
                    )
                  }
                  const current = lv.status === 'current' && pending
                  return (
                    <li key={lv.level} className={`flex gap-3 ${current ? '' : 'opacity-60'}`}>
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed bg-card ${current ? 'border-amber-400' : 'border-muted-foreground/40'}`}>
                        <Clock className={`h-4 w-4 ${current ? 'text-amber-600' : 'text-muted-foreground'}`} />
                      </div>
                      <div className={`flex-1 rounded-lg border border-dashed p-3 ${current ? 'border-amber-300 bg-amber-50/50' : 'border-border'}`}>
                        <p className="text-sm">{t('workflow.levelPending', { level: lv.level })}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{who}</p>
                        {current && lv.dueAt && (
                          <p className={`text-xs mt-0.5 ${lv.overdue ? 'font-medium text-red-600' : 'text-muted-foreground'}`}>
                            {t('workflow.dueAt', { date: formatDateTime(lv.dueAt) })}
                            {lv.overdue ? ` · ${t('workflow.overdue')}` : ''}
                          </p>
                        )}
                      </div>
                    </li>
                  )
                })}

                {/* Clôture finale */}
                {periodStatus === 'closed' && (
                  <li className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
                      <Lock className="h-4 w-4" />
                    </div>
                    <div className="flex-1 rounded-lg border border-green-300 bg-green-100 p-3">
                      <p className="text-sm font-semibold text-green-900">{t('workflow.finalClosed')}</p>
                    </div>
                  </li>
                )}
              </ol>
            </div>

            {/* Bandeau SoD / attente du valideur désigné */}
            {deniedText && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>{deniedText}</p>
              </div>
            )}
            {pending && viewer?.escalated && (
              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>{t('workflow.escalatedNotice')}</p>
              </div>
            )}

            {/* Actions du valideur : approuver / rejeter */}
            {(canApprove || canReject) && mode === 'idle' && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                <label htmlFor="payroll-approve-notes" className="block text-xs font-medium">{t('workflow.notesLabel')}</label>
                <textarea
                  id="payroll-approve-notes"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder={t('workflow.notesPlaceholder')}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
                />
                {approveError && (
                  <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {approveError}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {canApprove && (
                    <button
                      onClick={() => approveMut.mutate()}
                      disabled={approveMut.isPending}
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {approveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      {t('workflow.approveLevel', { level: data.currentLevel + 1 })}
                    </button>
                  )}
                  {canReject && (
                    <button
                      onClick={() => setMode('reject')}
                      className="flex items-center gap-2 rounded-lg border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
                    >
                      <XCircle className="h-4 w-4" /> {t('workflow.reject')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Action de l'initiateur : annuler tant qu'aucun niveau n'a validé */}
            {canCancel && mode === 'idle' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">{t(multi ? 'multiSites.workflow.cancelHint' : 'workflow.cancelHint')}</p>
                <button
                  onClick={() => setMode('cancel')}
                  className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
                >
                  <Undo2 className="h-4 w-4" /> {t('workflow.cancelInitiation')}
                </button>
              </div>
            )}

            {/* Mode rejet : commentaire obligatoire */}
            {mode === 'reject' && (
              <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-xs text-muted-foreground">{t(multi ? 'multiSites.workflow.rejectHint' : 'workflow.rejectHint')}</p>
                <label htmlFor="payroll-reject-reason" className="block text-xs font-medium text-destructive">{t('workflow.rejectReasonLabel')}</label>
                <textarea
                  id="payroll-reject-reason"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder={t('workflow.rejectReasonPlaceholder')}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
                />
                {rejectError && (
                  <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {rejectError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => rejectMut.mutate()}
                    disabled={rejectMut.isPending || reason.trim().length < 10}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {rejectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                    {t('workflow.confirmReject')}
                  </button>
                  <button
                    onClick={() => { setMode('idle'); setReason('') }}
                    className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
                  >
                    {t('workflow.cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* Mode annulation de l'initiation */}
            {mode === 'cancel' && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs text-muted-foreground">{t(multi ? 'multiSites.workflow.cancelHint' : 'workflow.cancelHint')}</p>
                <label htmlFor="payroll-cancel-comment" className="block text-xs font-medium">{t('workflow.cancelCommentLabel')}</label>
                <textarea
                  id="payroll-cancel-comment"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
                />
                {cancelError && (
                  <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {cancelError}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => cancelMut.mutate()}
                    disabled={cancelMut.isPending}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {cancelMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                    {t('workflow.confirmCancel')}
                  </button>
                  <button
                    onClick={() => { setMode('idle'); setComment('') }}
                    className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
                  >
                    {t('workflow.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
