/**
 * Circuit de validation N+1 … N+n → RH (absences, notes de frais) — types du
 * contrat API, helpers d'affichage (étape, échéance) et hooks partagés par la
 * file RH des absences, la page RH des notes de frais, « Mes validations », la
 * bannière/fenêtre de rappel des échéances et le widget du tableau de bord.
 *
 * Les droits (qui peut agir, qui voit quoi) sont calculés côté API : l'UI se
 * contente d'afficher `workflow.canAct` — jamais de règle métier dupliquée ici.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api } from '@/lib/api'

export type ApprovalModule = 'absences' | 'expenses'

export interface WorkflowSummary {
  totalSteps: number
  doneSteps: number
  next: { kind: 'manager'; level: number; approverEmployeeId: string } | { kind: 'hr' } | null
  dueAt: string | null
  overdue: boolean
  canAct: boolean
  /** L'utilisateur est le valideur désigné de l'étape (sinon : reprise après échéance). */
  designated: boolean
}

export interface PendingApproval {
  module: ApprovalModule
  id: string
  employeeId: string
  employeeName: string
  label: string
  detail: string
  submittedAt: string
  workflow: WorkflowSummary
  dueSoon: boolean
}

export interface PendingSummary { actionable: number; overdue: number; dueSoon: number; readOnly: number }
export interface PendingApprovalsResponse { data: PendingApproval[]; summary: PendingSummary }

/** Une échéance est « proche » à moins de 12 h de son terme (même seuil que l'API). */
export const DUE_SOON_MS = 12 * 3_600_000
/** Rafraîchissement des validations en attente : toutes les 5 minutes (+ au retour sur l'onglet). */
export const PENDING_REFETCH_MS = 5 * 60_000
export const PENDING_QUERY_KEY = ['approvals-pending'] as const

export type SlaState = 'overdue' | 'dueSoon' | 'ok' | 'none'

export function slaState(workflow: WorkflowSummary | null | undefined, now: number = Date.now()): SlaState {
  if (!workflow?.dueAt) return 'none'
  if (workflow.overdue) return 'overdue'
  const due = Date.parse(workflow.dueAt)
  if (Number.isNaN(due)) return 'none'
  return due - now <= DUE_SOON_MS ? 'dueSoon' : 'ok'
}

/** Échéance au format court date + heure (fr-CI, comme formatDate). */
export function formatDueAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('fr-CI', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d)
}

/** Libellé de l'étape courante : « Visa N+1 », « Validation RH »… (namespace approvals). */
export function stepLabel(workflow: WorkflowSummary | null | undefined, t: TFunction): string {
  const next = workflow?.next
  if (!next) return t('step.done')
  return next.kind === 'hr' ? t('step.hr') : t('step.manager', { level: next.level })
}

/** Libellé « lecture seule » : à quelle étape la demande est-elle bloquée ? */
export function readOnlyLabel(workflow: WorkflowSummary | null | undefined, t: TFunction): string {
  const next = workflow?.next
  if (next?.kind === 'manager') return t('readOnlyWaiting', { level: next.level })
  if (next?.kind === 'hr') return t('readOnlyWaitingHr')
  return t('waitingOther')
}

/** Message d'erreur renvoyé par l'API (`{ error }`), sinon le libellé de repli. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error
  return typeof msg === 'string' && msg ? msg : fallback
}

/** Demandes en attente de l'utilisateur connecté (valideur), rafraîchies périodiquement. */
export function usePendingApprovals(enabled: boolean = true) {
  return useQuery<PendingApprovalsResponse>({
    queryKey: PENDING_QUERY_KEY,
    queryFn: () => api.get('/approvals/pending').then(r => r.data as PendingApprovalsResponse),
    enabled,
    staleTime: 60_000,
    refetchInterval: PENDING_REFETCH_MS,
    refetchOnWindowFocus: true,
  })
}

export interface Feedback { type: 'success' | 'error'; message: string }
interface DecisionTarget { module: ApprovalModule; id: string }
interface DecisionResponse { message?: string; fullyApproved?: boolean }

// Toutes les vues alimentées par le circuit : elles se rafraîchissent après une décision.
const DECISION_INVALIDATES = ['absences', 'expenses', 'approvals-pending', 'manager-absences-submitted', 'manager-expenses-submitted']

/**
 * Approbation / refus d'une demande avec retour visible : message d'étape de
 * l'API en cas de succès (« Étape 1/2 validée — suite : validation RH »),
 * message d'erreur de l'API (403 : pas votre étape, propre demande…) sinon.
 */
export function useApprovalDecision() {
  const { t } = useTranslation('approvals')
  const queryClient = useQueryClient()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const refresh = () => {
    for (const key of DECISION_INVALIDATES) void queryClient.invalidateQueries({ queryKey: [key] })
  }

  const approve = useMutation({
    mutationFn: ({ module, id }: DecisionTarget) =>
      api.patch(`/${module}/${id}/approve`).then(r => (r?.data ?? {}) as DecisionResponse),
    onMutate: () => setFeedback(null),
    onSuccess: (res) => { setFeedback({ type: 'success', message: res.message || t('approved') }); refresh() },
    onError: (err) => { setFeedback({ type: 'error', message: apiErrorMessage(err, t('errors.generic')) }); refresh() },
  })

  const reject = useMutation({
    mutationFn: ({ module, id, reason }: DecisionTarget & { reason: string }) =>
      api.patch(`/${module}/${id}/reject`, { reason }).then(r => (r?.data ?? {}) as DecisionResponse),
    onMutate: () => setFeedback(null),
    onSuccess: (res) => { setFeedback({ type: 'success', message: res.message || t('rejected') }); refresh() },
    onError: (err) => { setFeedback({ type: 'error', message: apiErrorMessage(err, t('errors.generic')) }); refresh() },
  })

  return { approve, reject, feedback, setFeedback }
}
