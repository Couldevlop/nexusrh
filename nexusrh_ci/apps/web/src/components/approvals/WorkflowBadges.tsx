import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, X } from 'lucide-react'
import { formatDueAt, slaState, stepLabel, type Feedback, type WorkflowSummary } from './workflow'

/** Étape courante du circuit (« Visa N+1 », « Validation RH ») + avancement doneSteps/totalSteps. */
export function WorkflowStep({ workflow }: { workflow?: WorkflowSummary | null }) {
  const { t } = useTranslation('approvals')
  if (!workflow) return <span className="text-muted-foreground">—</span>
  return (
    <div>
      <p className="text-xs font-medium">{stepLabel(workflow, t)}</p>
      <p className="text-[11px] text-muted-foreground">
        {t('progress', { done: workflow.doneSteps, total: workflow.totalSteps })}
      </p>
    </div>
  )
}

/**
 * Échéance de l'étape (SLA) : date/heure, badge rouge « En retard » une fois
 * dépassée, ambre « Échéance proche » à moins de 12 h.
 */
export function SlaBadge({ workflow, dueSoon }: { workflow?: WorkflowSummary | null; dueSoon?: boolean }) {
  const { t } = useTranslation('approvals')
  const state = dueSoon && !workflow?.overdue ? 'dueSoon' : slaState(workflow)
  if (state === 'none' || !workflow?.dueAt) return <span className="text-muted-foreground">—</span>
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{formatDueAt(workflow.dueAt)}</p>
      {state === 'overdue' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
          <AlertTriangle className="h-3 w-3" /> {t('sla.overdue')}
        </span>
      )}
      {state === 'dueSoon' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
          <Clock className="h-3 w-3" /> {t('sla.dueSoon')}
        </span>
      )}
    </div>
  )
}

/** Bandeau de retour inline (succès / erreur d'une décision), refermable. */
export function FeedbackBanner({ feedback, onClose }: { feedback: Feedback | null; onClose: () => void }) {
  if (!feedback) return null
  return (
    <div
      role={feedback.type === 'error' ? 'alert' : 'status'}
      className={`flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${
        feedback.type === 'success'
          ? 'border-green-200 bg-green-50 text-green-700'
          : 'border-red-200 bg-red-50 text-red-700'
      }`}>
      <span>{feedback.message}</span>
      <button onClick={onClose} className="ml-3 opacity-70 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

/** Fenêtre de saisie du motif de refus. */
export function RejectReasonModal({ pending, onCancel, onConfirm }: {
  pending: boolean; onCancel: () => void; onConfirm: (reason: string) => void
}) {
  const { t } = useTranslation('approvals')
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold mb-3">{t('rejectModal.title')}</h3>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder={t('rejectModal.placeholder')}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none resize-none"
          rows={3}
        />
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
            {t('rejectModal.cancel')}
          </button>
          <button
            onClick={() => onConfirm(reason)}
            disabled={pending}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
            {t('rejectModal.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
