/**
 * « Mes validations » — demandes d'absence et notes de frais en attente de
 * l'utilisateur connecté, quel que soit son rôle : manager N+1/N+2…, équipe RH,
 * ou chef d'équipe au rôle employé (servi alors depuis Mon espace).
 *  - « À traiter » : c'est l'étape de l'utilisateur (workflow.canAct) ;
 *  - « Pour information » : visible mais pas encore à son étape (ex. note de
 *    frais en attente d'un visa hiérarchique, vue par la RH en lecture seule).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, CheckCircle, Inbox, Loader2, Receipt, XCircle } from 'lucide-react'
import { formatFCFA } from '@/lib/api'
import {
  readOnlyLabel, usePendingApprovals, useApprovalDecision, type ApprovalModule, type PendingApproval,
} from '@/components/approvals/workflow'
import { FeedbackBanner, RejectReasonModal, SlaBadge, WorkflowStep } from '@/components/approvals/WorkflowBadges'

const MODULE_ICON: Record<ApprovalModule, React.ElementType> = { absences: CalendarDays, expenses: Receipt }

/** Le détail d'une note de frais arrive en « <montant> FCFA » brut : on le reformate. */
function formatDetail(item: PendingApproval): string {
  if (item.module !== 'expenses') return item.detail
  const amount = parseFloat(item.detail)
  return Number.isFinite(amount) ? formatFCFA(Math.round(amount)) : item.detail
}

export default function ApprovalsPage() {
  const { t } = useTranslation('approvals')
  const { data, isLoading, isError } = usePendingApprovals()
  const { approve, reject, feedback, setFeedback } = useApprovalDecision()
  const [rejectTarget, setRejectTarget] = useState<PendingApproval | null>(null)

  const items = data?.data ?? []
  const actionable = items.filter(i => i.workflow.canAct)
  const readOnly = items.filter(i => !i.workflow.canAct)
  const summary = data?.summary

  const renderRow = (item: PendingApproval) => {
    const Icon = MODULE_ICON[item.module]
    const busy = (approve.isPending && approve.variables?.id === item.id)
      || (reject.isPending && reject.variables?.id === item.id)
    return (
      <tr key={`${item.module}:${item.id}`} className="hover:bg-muted/30">
        <td className="p-4">
          <p className="font-medium">{item.employeeName}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Icon className="h-3 w-3" /> {t(`modules.${item.module}`)}
          </p>
        </td>
        <td className="p-4">
          <p className="text-sm">{item.label}</p>
          <p className="text-xs text-muted-foreground">{formatDetail(item)}</p>
        </td>
        <td className="p-4"><WorkflowStep workflow={item.workflow} /></td>
        <td className="p-4"><SlaBadge workflow={item.workflow} dueSoon={item.dueSoon} /></td>
        <td className="p-4">
          {item.workflow.canAct ? (
            <div className="flex gap-2">
              <button
                onClick={() => approve.mutate({ module: item.module, id: item.id })}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200 disabled:opacity-50">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />} {t('actions.approve')}
              </button>
              <button
                onClick={() => setRejectTarget(item)}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200 disabled:opacity-50">
                <XCircle className="h-3 w-3" /> {t('actions.reject')}
              </button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{readOnlyLabel(item.workflow, t)}</span>
          )}
        </td>
      </tr>
    )
  }

  const renderGroup = (title: string, rows: PendingApproval[], hint?: string) => (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">({rows.length})</span>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="p-4">{t('table.employee')}</th>
              <th className="p-4">{t('table.request')}</th>
              <th className="p-4">{t('table.step')}</th>
              <th className="p-4">{t('table.sla')}</th>
              <th className="p-4">{t('table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(renderRow)}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-sm text-muted-foreground">{t('emptyGroup')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([
            ['actionable', summary.actionable, 'text-primary'],
            ['overdue', summary.overdue, 'text-red-600'],
            ['dueSoon', summary.dueSoon, 'text-amber-600'],
            ['readOnly', summary.readOnly, 'text-muted-foreground'],
          ] as const).map(([key, value, color]) => (
            <div key={key} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t(`summary.${key}`)}</p>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      <FeedbackBanner feedback={feedback} onClose={() => setFeedback(null)} />

      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : isError ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t('errors.load')}</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center text-muted-foreground">
          <Inbox className="mx-auto mb-2 h-8 w-8 opacity-30" />
          {t('empty')}
        </div>
      ) : (
        <>
          {renderGroup(t('groups.actionable'), actionable)}
          {readOnly.length > 0 && renderGroup(t('groups.readOnly'), readOnly, t('groupsHint.readOnly'))}
        </>
      )}

      {rejectTarget && (
        <RejectReasonModal
          pending={reject.isPending}
          onCancel={() => setRejectTarget(null)}
          onConfirm={(reason) => reject.mutate(
            { module: rejectTarget.module, id: rejectTarget.id, reason },
            { onSettled: () => setRejectTarget(null) },
          )}
        />
      )}
    </div>
  )
}
