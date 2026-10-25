import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatDate } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { Calendar, CheckCircle, Plus, XCircle } from 'lucide-react'
import { useApprovalDecision, type WorkflowSummary } from '@/components/approvals/workflow'
import { FeedbackBanner, RejectReasonModal, SlaBadge, WorkflowStep } from '@/components/approvals/WorkflowBadges'
import AbsenceEntryModal from './AbsenceEntryModal'

interface Absence {
  id: string; employee_id: string; first_name: string; last_name: string
  type_label: string; type_color: string
  start_date: string; end_date: string; days: number
  half_day: boolean; reason: string | null
  status: string; validation_level: number
  created_at: string
  /** Circuit N+1 … N+n → RH : étape courante, échéance, droit d'agir (calculés par l'API). */
  workflow?: WorkflowSummary
}

const STATUS_COLOR: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-700',
  pending:   'bg-yellow-100 text-yellow-700',
  approved:  'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
}
// Statut DB « pending » (ancien libellé) affiché comme « En attente ».
const STATUS_LABEL: Record<string, string> = { pending: 'submitted' }

// Saisie pour un collaborateur : équipe RH (tout salarié) et managers (leur chaîne).
const ENTRY_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager']

export default function AbsencesPage() {
  const { t } = useTranslation('absences')
  const { t: ta } = useTranslation('approvals')
  const role = useAuthStore(s => s.user?.role ?? '')
  const [statusFilter, setStatusFilter] = useState<string>('submitted')
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [showEntry, setShowEntry] = useState(false)
  const { approve, reject, feedback, setFeedback } = useApprovalDecision()

  const { data, isLoading } = useQuery<{ data: Absence[] }>({
    queryKey: ['absences', statusFilter],
    queryFn: () => api.get(`/absences?status=${statusFilter}`).then(r => r.data),
  })

  const absences = data?.data ?? []
  const pendingView = statusFilter === 'submitted'
  const colCount = pendingView ? 9 : 6

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('requestsCount', { count: absences.length })}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {['submitted', 'approved', 'rejected'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent'
              }`}
            >
              {t(`status.${s}`)}
            </button>
          ))}
          {ENTRY_ROLES.includes(role) && (
            <button
              onClick={() => setShowEntry(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
              <Plus className="h-4 w-4" /> {t('entry.open')}
            </button>
          )}
        </div>
      </div>

      <FeedbackBanner feedback={feedback} onClose={() => setFeedback(null)} />

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">{t('table.employee')}</th>
                <th className="p-4">{t('table.type')}</th>
                <th className="p-4">{t('table.period')}</th>
                <th className="p-4 text-center">{t('table.days')}</th>
                <th className="p-4">{t('table.reason')}</th>
                <th className="p-4">{t('table.status')}</th>
                {pendingView && <th className="p-4">{t('table.step')}</th>}
                {pendingView && <th className="p-4">{t('table.sla')}</th>}
                {pendingView && <th className="p-4">{t('table.actions')}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {absences.map(abs => {
                const statusKey = STATUS_LABEL[abs.status] ?? abs.status
                return (
                  <tr key={abs.id} className="hover:bg-muted/30">
                    <td className="p-4">
                      <p className="font-medium">{abs.first_name} {abs.last_name}</p>
                    </td>
                    <td className="p-4">
                      <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                        style={{ backgroundColor: abs.type_color ?? '#888' }}>
                        {abs.type_label}
                      </span>
                    </td>
                    <td className="p-4">
                      <p className="text-xs">{formatDate(abs.start_date)} → {formatDate(abs.end_date)}</p>
                    </td>
                    <td className="p-4 text-center">{abs.half_day ? t('halfDay') : t('fullDays', { count: abs.days })}</td>
                    <td className="p-4 max-w-[200px] truncate text-muted-foreground">
                      {abs.reason ?? t('noReason')}
                    </td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[abs.status] ?? 'bg-muted'}`}>
                        {STATUS_COLOR[abs.status] ? t(`status.${statusKey}`) : abs.status}
                      </span>
                    </td>
                    {pendingView && <td className="p-4"><WorkflowStep workflow={abs.workflow} /></td>}
                    {pendingView && <td className="p-4"><SlaBadge workflow={abs.workflow} /></td>}
                    {pendingView && (
                      <td className="p-4">
                        {/* Boutons uniquement à l'étape de l'utilisateur (calcul API) */}
                        {abs.workflow?.canAct === true ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => approve.mutate({ module: 'absences', id: abs.id })}
                              disabled={approve.isPending}
                              className="flex items-center gap-1 rounded-lg bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200 disabled:opacity-50"
                            >
                              <CheckCircle className="h-3 w-3" /> {t('actions.approve')}
                            </button>
                            <button
                              onClick={() => setRejectId(abs.id)}
                              className="flex items-center gap-1 rounded-lg bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                            >
                              <XCircle className="h-3 w-3" /> {t('actions.reject')}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{ta('waitingOther')}</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
              {absences.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="p-8 text-center text-muted-foreground">
                    <Calendar className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    {t('empty', { status: t(`status.${statusFilter}`).toLowerCase() })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal refus */}
      {rejectId && (
        <RejectReasonModal
          pending={reject.isPending}
          onCancel={() => setRejectId(null)}
          onConfirm={(reason) => reject.mutate(
            { module: 'absences', id: rejectId, reason },
            { onSettled: () => setRejectId(null) },
          )}
        />
      )}

      {/* Saisie pour un collaborateur */}
      {showEntry && (
        <AbsenceEntryModal
          onClose={() => setShowEntry(false)}
          onCreated={(warning) => {
            setShowEntry(false)
            setFeedback(warning ? { type: 'error', message: warning } : { type: 'success', message: t('entry.created') })
          }}
        />
      )}
    </div>
  )
}
