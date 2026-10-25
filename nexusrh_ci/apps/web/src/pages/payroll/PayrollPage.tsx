import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api, formatFCFA, formatMonth } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Loader2, Lock, Calculator, Download, BookOpen, CheckCircle2, XCircle,
  Clock, Shield, ShieldAlert, Users, AlertCircle, ChevronRight, X, CalendarPlus, Undo2, UserCheck
} from 'lucide-react'

/** Valideur attendu d'une période en validation (circuit nominatif, calculé par l'API). */
interface PendingWith {
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

interface PayPeriod {
  id: string; month: string; status: string
  total_gross: string; total_net: string; total_cnps: string; total_its: string
  employees_count: string; closed_at: string | null
  initiated_at: string | null; initiated_by: string | null
  rejection_reason: string | null
  pending_with?: PendingWith | null
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
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-FR')
}

/** « Prénom Nom (fonction) » ou équipe RH : libellé du valideur attendu. */
function pendingWithText(pw: PendingWith | null | undefined, t: TFunction): string {
  if (pw?.name) return t('history.pendingWith', { name: pw.name, fn: pw.functionLabel ?? '' })
  return t('history.pendingWithTeam')
}

/** Message de clôture : « Période 2026-10 en attente de validation de … ». */
function closeMessage(month: string, pw: PendingWith | null | undefined, t: TFunction): string {
  return pw?.name
    ? t('close.pendingWithNamed', { month, name: pw.name, fn: pw.functionLabel ?? '' })
    : t('close.pendingWithTeam', { month })
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('payroll')
  const map: Record<string, { cls: string; Icon: typeof Lock }> = {
    open: { cls: 'bg-gray-100 text-gray-700', Icon: Clock },
    pending_validation: { cls: 'bg-amber-100 text-amber-800', Icon: ShieldAlert },
    closed: { cls: 'bg-green-100 text-green-700', Icon: CheckCircle2 },
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

function WorkflowModal({ month, onClose, onDone }: { month: string; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useTranslation('payroll')
  const queryClient = useQueryClient()
  const [notes, setNotes] = useState('')
  const [mode, setMode] = useState<'idle' | 'reject' | 'cancel'>('idle')
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')

  const { data, isLoading } = useQuery<WorkflowState>({
    queryKey: ['payroll-workflow', month],
    queryFn: () => api.get(`/payroll/periods/${month}/workflow`).then(r => r.data as WorkflowState),
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['payroll-workflow', month] })
    queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    queryClient.invalidateQueries({ queryKey: ['approvals-pending'] })
  }

  const approveMut = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${month}/approve`, notes.trim() ? { notes: notes.trim() } : {}),
    onSuccess: () => { refresh(); setNotes('') },
  })

  const rejectMut = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${month}/reject`, { reason: reason.trim() }),
    onSuccess: () => {
      refresh()
      setMode('idle'); setReason('')
      onDone(t('workflow.rejectedNotice'))
    },
  })

  const cancelMut = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${month}/cancel`, comment.trim() ? { comment: comment.trim() } : {}),
    onSuccess: () => {
      refresh()
      setMode('idle'); setComment('')
      onDone(t('workflow.cancelledNotice'))
    },
  })

  const viewer = data?.viewer
  const periodStatus = data?.period.status
  const pending = periodStatus === 'pending_validation'
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
                  <div className="mt-1"><StatusBadge status={data.period.status} /></div>
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
                    <p className="text-sm font-medium">{t('workflow.initiated')}</p>
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
                <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">{t('workflow.cancelHint')}</p>
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
                <p className="text-xs text-muted-foreground">{t('workflow.rejectHint')}</p>
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
                <p className="text-xs text-muted-foreground">{t('workflow.cancelHint')}</p>
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

interface LegalEntity { id: string; name: string; city?: string | null; cnps_number?: string | null }

export default function PayrollPage() {
  const { t } = useTranslation('payroll')
  const queryClient = useQueryClient()
  const user = useAuthStore(s => s.user)
  const tenantConfig = useAuthStore(s => s.tenantConfig)
  const hasSubsidiaries = tenantConfig?.hasSubsidiaries === true

  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [selectedEntityId, setSelectedEntityId] = useState<string>('')
  const [closingResult, setClosingResult] = useState<{
    status?: string; message?: string; employeesCount?: number; bulletinsDeSolde?: number
    totals?: Record<string, number>; pendingWith?: PendingWith | null; month?: string
  } | null>(null)
  const [livreYear, setLivreYear] = useState(new Date().getFullYear().toString())
  const [livreLoading, setLivreLoading] = useState(false)
  // « Mes validations » ouvre directement le circuit d'une période : /payroll?validate=AAAA-MM
  const [searchParams, setSearchParams] = useSearchParams()
  const [workflowMonth, setWorkflowMonth] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const m = searchParams.get('validate')
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) setWorkflowMonth(m)
  }, [searchParams])
  const closeWorkflow = () => {
    setWorkflowMonth(null)
    if (searchParams.has('validate')) {
      const next = new URLSearchParams(searchParams)
      next.delete('validate')
      setSearchParams(next, { replace: true })
    }
  }

  // Charge les filiales SEULEMENT si tenant multi-filiales (évite query inutile)
  const { data: entitiesData } = useQuery<{ data: LegalEntity[] }>({
    queryKey: ['legal-entities-for-payroll'],
    queryFn: () => api.get('/settings/legal-entities').then(r => r.data),
    enabled: hasSubsidiaries,
  })
  const legalEntities = entitiesData?.data ?? []

  const { data: periodsData, isLoading } = useQuery<{ data: PayPeriod[] }>({
    queryKey: ['payroll-periods'],
    queryFn: () => api.get('/payroll/periods').then(r => r.data),
  })

  const closeMut = useMutation({
    mutationFn: (month: string) => api.post(`/payroll/periods/${month}/close`,
      hasSubsidiaries && selectedEntityId ? { legalEntityId: selectedEntityId } : {},
    ),
    onSuccess: (res, month) => {
      setNotice(null)
      setClosingResult({
        ...(res.data as {
          status?: string; message?: string; employeesCount?: number; bulletinsDeSolde?: number
          totals?: Record<string, number>; pendingWith?: PendingWith | null
        }),
        month,
      })
      queryClient.invalidateQueries({ queryKey: ['payroll-periods'] })
    },
  })

  // PAY-019 — créer une période au statut 'open' (avant la génération via close).
  const createMut = useMutation({
    mutationFn: (month: string) => api.post(`/payroll/periods/${month}`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payroll-periods'] }),
  })

  const periods = periodsData?.data ?? []

  const exportLivre = async () => {
    setLivreLoading(true)
    try {
      const res = await api.get(`/payroll/livre-de-paie/${livreYear}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]))
      const a = document.createElement('a')
      a.href = url
      a.download = `livre-de-paie-${livreYear}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setLivreLoading(false)
    }
  }

  const availableMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  const monthIsLocked = (m: string) => periods.some(p => p.month === m && (p.status === 'closed' || p.status === 'pending_validation'))
  const pendingCount = periods.filter(p => p.status === 'pending_validation').length

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('page.subtitle')}
          </p>
        </div>
        {pendingCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <ShieldAlert className="h-4 w-4" />
            <Trans i18nKey="page.pendingBanner" ns="payroll" count={pendingCount} components={{ strong: <strong /> }} />
          </div>
        )}
      </div>

      {notice && (
        <div role="status" className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label={t('workflow.cancel')} className="ml-3 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Clôture */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <Lock className="h-4 w-4" /> {t('close.title')}
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          <Trans i18nKey="close.intro" ns="payroll" components={{ strong: <strong /> }} />
        </p>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('close.monthLabel')}</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none"
            >
              <option value="">{t('close.monthPlaceholder')}</option>
              {availableMonths.map(m => (
                <option key={m} value={m} disabled={monthIsLocked(m)}>
                  {formatMonth(m)}{monthIsLocked(m) ? t('close.monthLocked') : ''}
                </option>
              ))}
            </select>
          </div>

          {hasSubsidiaries && (
            <div>
              <label className="text-sm font-medium mb-1 block">
                {t('close.subsidiaryLabel')} <span className="text-red-500">*</span>
              </label>
              <select
                value={selectedEntityId}
                onChange={e => setSelectedEntityId(e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none min-w-[200px]"
              >
                <option value="">{t('close.subsidiaryPlaceholder')}</option>
                {legalEntities.map(le => (
                  <option key={le.id} value={le.id}>
                    {le.name}{le.city ? ` (${le.city})` : ''}{le.cnps_number ? ` — CNPS ${le.cnps_number}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {t('close.subsidiaryHint')}
              </p>
            </div>
          )}

          {/* PAY-019 — créer la période au statut open (si elle n'existe pas encore) */}
          <button
            onClick={() => selectedMonth && createMut.mutate(selectedMonth)}
            disabled={!selectedMonth || createMut.isPending || periods.some(p => p.month === selectedMonth)}
            title={t('create.title', 'Créer la période (statut open)')}
            className="flex items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {createMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <CalendarPlus className="h-4 w-4" />
            {t('create.submit', 'Créer la période')}
          </button>

          <button
            onClick={() => selectedMonth && closeMut.mutate(selectedMonth)}
            disabled={!selectedMonth || (hasSubsidiaries && !selectedEntityId) || closeMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {closeMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <Lock className="h-4 w-4" />
            {t('close.submit')}
          </button>
        </div>

        {closeMut.isError && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {(closeMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('close.error')}
          </div>
        )}

        {closingResult && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="font-medium text-amber-900 mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              {closingResult.month
                ? `${closeMessage(closingResult.month, closingResult.pendingWith, t)}. ${t('close.generated', { count: closingResult.employeesCount ?? 0 })}`
                : closingResult.message ?? t('close.resultDefault', { count: closingResult.employeesCount ?? 0 })}
            </p>
            {(closingResult.bulletinsDeSolde ?? 0) > 0 && (
              <p className="mb-2 text-sm text-amber-800">
                {t('close.resultFinalPayslips', { count: closingResult.bulletinsDeSolde })}
              </p>
            )}
            {closingResult.totals && (
              <div className="grid grid-cols-2 gap-2 text-sm text-amber-800">
                <p>{t('close.resultGross')} <strong>{formatFCFA(closingResult.totals['grossSalary'] ?? 0)}</strong></p>
                <p>{t('close.resultNet')} <strong>{formatFCFA(closingResult.totals['netPayable'] ?? 0)}</strong></p>
                <p>{t('close.resultCnps')} <strong>{formatFCFA(closingResult.totals['cnps'] ?? 0)}</strong></p>
                <p>{t('close.resultIts')} <strong>{formatFCFA(closingResult.totals['its'] ?? 0)}</strong></p>
              </div>
            )}
            <p className="mt-2 text-xs text-amber-700">
              {t('close.resultHint')}
            </p>
          </div>
        )}
      </div>

      {/* Livre de paie numérique */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> {t('livre.title')}
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('livre.intro')}
        </p>
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('livre.yearLabel')}</label>
            <select value={livreYear} onChange={e => setLivreYear(e.target.value)}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none">
              {[0, 1, 2, 3].map(i => {
                const y = (new Date().getFullYear() - i).toString()
                return <option key={y} value={y}>{y}</option>
              })}
            </select>
          </div>
          <button
            onClick={exportLivre}
            disabled={livreLoading}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {livreLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t('livre.exportCsv')}
          </button>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
          <span>{t('livre.feature1')}</span>
          <span>{t('livre.feature2')}</span>
          <span>{t('livre.feature3')}</span>
          <span>{t('livre.feature4')}</span>
        </div>
      </div>

      {/* Historique des périodes */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="font-semibold">{t('history.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('history.hint')}</p>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">{t('history.colPeriod')}</th>
                <th className="p-4 text-right">{t('history.colGross')}</th>
                <th className="p-4 text-right">{t('history.colNet')}</th>
                <th className="p-4 text-right">{t('history.colCnps')}</th>
                <th className="p-4 text-right">{t('history.colIts')}</th>
                <th className="p-4">{t('history.colStatus')}</th>
                <th className="p-4 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {periods.map(p => {
                const isInitiator = p.initiated_by === user?.sub
                const pw = p.pending_with ?? null
                // Indicatif (libellé du bouton) : les droits réels sont calculés par l'API dans la modale.
                const canValidate = !isInitiator && (pw
                  ? pw.userId === user?.sub || (pw.teamCanAct && (user?.role === 'admin' || user?.role === 'hr_manager'))
                  : (user?.role === 'admin' || user?.role === 'hr_manager'))
                return (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="p-4 font-medium capitalize">
                      {formatMonth(p.month)}
                      {p.rejection_reason && (
                        <p className="mt-1 text-xs text-destructive italic">{t('history.rejected', { reason: p.rejection_reason })}</p>
                      )}
                    </td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_gross ?? '0'))}</td>
                    <td className="p-4 text-right font-mono">{formatFCFA(parseInt(p.total_net ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-orange-600">{formatFCFA(parseInt(p.total_cnps ?? '0'))}</td>
                    <td className="p-4 text-right font-mono text-blue-600">{formatFCFA(parseInt(p.total_its ?? '0'))}</td>
                    <td className="p-4">
                      <StatusBadge status={p.status} />
                      {p.status === 'pending_validation' && (
                        <div className="mt-1 space-y-0.5 text-xs">
                          <p className="font-medium text-amber-900">{pendingWithText(pw, t)}</p>
                          {pw && (
                            <p className="text-muted-foreground">
                              {t('history.levelProgress', { level: pw.level, total: pw.requiredLevels })}
                              {pw.dueAt ? ` · ${t('history.dueAt', { date: formatDateTime(pw.dueAt) })}` : ''}
                            </p>
                          )}
                          {pw?.overdue && <p className="text-red-600">{t('history.overdue')}</p>}
                        </div>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      {p.status === 'pending_validation' && (
                        <button
                          onClick={() => setWorkflowMonth(p.month)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1 text-xs font-medium transition ${
                            canValidate
                              ? 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
                              : 'border-border text-muted-foreground hover:bg-accent'
                          }`}
                        >
                          {canValidate ? t('history.validate') : t('history.viewWorkflow')}
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      )}
                      {p.status === 'closed' && (
                        <button
                          onClick={() => setWorkflowMonth(p.month)}
                          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          {t('history.audit')} <ChevronRight className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {periods.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    <Calculator className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    {t('history.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {workflowMonth && (
        <WorkflowModal
          month={workflowMonth}
          onClose={closeWorkflow}
          onDone={(message) => { setNotice(message); setClosingResult(null); closeWorkflow() }}
        />
      )}
    </div>
  )
}
