import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { Receipt, CheckCircle, XCircle, CreditCard } from 'lucide-react'

interface ExpenseReport {
  id: string; employee_id: string; first_name: string; last_name: string
  department_name: string | null; title: string; month: string
  total_amount: string; status: string; submitted_at: string | null
  approved_at: string | null; paid_at: string | null
  rejection_reason: string | null; created_at: string
}

const STATUS_COLOR: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  submitted: 'bg-yellow-100 text-yellow-700',
  approved:  'bg-blue-100 text-blue-700',
  paid:      'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
}
const STATUS_ORDER = ['draft', 'submitted', 'approved', 'paid', 'rejected'] as const

export default function ExpensesPage() {
  const { t } = useTranslation('expenses')
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('submitted')
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [payId, setPayId] = useState<string | null>(null)
  const [payProvider, setPayProvider] = useState('wave')
  const [payError, setPayError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: ExpenseReport[] }>({
    queryKey: ['expenses', statusFilter],
    queryFn: () => api.get(`/expenses?status=${statusFilter}`).then(r => r.data),
  })

  const approveMut = useMutation({
    mutationFn: (id: string) => api.patch(`/expenses/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expenses'] }),
  })

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.patch(`/expenses/${id}/reject`, { reason }),
    onSuccess: () => {
      setRejectId(null); setRejectReason('')
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
    },
  })

  // FRA-006 — remboursement Mobile Money : on transmet le provider choisi.
  const payMut = useMutation({
    mutationFn: ({ id, provider }: { id: string; provider?: string }) =>
      api.patch(`/expenses/${id}/pay`, provider ? { provider } : {}),
    onSuccess: () => {
      setPayId(null)
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
    },
    onError: (err: unknown) => {
      const apiErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setPayError(apiErr ?? t('payModal.error', { defaultValue: 'Échec du remboursement.' }))
    },
  })

  const reports = data?.data ?? []
  const totalAmount = reports.reduce((sum, r) => sum + parseInt(r.total_amount || '0'), 0)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('summary', { count: reports.length, total: formatFCFA(totalAmount) })}
          </p>
        </div>
      </div>

      {/* Filtres statut */}
      <div className="flex flex-wrap gap-2">
        {STATUS_ORDER.map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground hover:bg-accent'
            }`}>
            {t(`status.${s}`)}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">{t('table.employee')}</th>
                <th className="p-4">{t('table.title')}</th>
                <th className="p-4">{t('table.month')}</th>
                <th className="p-4 text-right">{t('table.amount')}</th>
                <th className="p-4">{t('table.status')}</th>
                <th className="p-4">{t('table.submittedAt')}</th>
                <th className="p-4">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {reports.map(r => (
                <tr key={r.id} className="hover:bg-muted/30">
                  <td className="p-4">
                    <p className="font-medium">{r.first_name} {r.last_name}</p>
                    {r.department_name && (
                      <p className="text-xs text-muted-foreground">{r.department_name}</p>
                    )}
                  </td>
                  <td className="p-4 max-w-[180px] truncate">{r.title}</td>
                  <td className="p-4">{r.month}</td>
                  <td className="p-4 text-right font-medium">{formatFCFA(parseInt(r.total_amount || '0'))}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[r.status] ?? 'bg-muted'}`}>
                      {STATUS_COLOR[r.status] ? t(`status.${r.status}`) : r.status}
                    </span>
                    {r.rejection_reason && (
                      <p className="mt-0.5 text-xs text-red-500 max-w-[160px] truncate" title={r.rejection_reason}>
                        {r.rejection_reason}
                      </p>
                    )}
                  </td>
                  <td className="p-4 text-muted-foreground text-xs">
                    {r.submitted_at ? formatDate(r.submitted_at) : t('noDate')}
                  </td>
                  <td className="p-4">
                    <div className="flex gap-2 flex-wrap">
                      {r.status === 'submitted' && (
                        <>
                          <button onClick={() => approveMut.mutate(r.id)} disabled={approveMut.isPending}
                            className="flex items-center gap-1 rounded-lg bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200 disabled:opacity-50">
                            <CheckCircle className="h-3 w-3" /> {t('actions.approve')}
                          </button>
                          <button onClick={() => setRejectId(r.id)}
                            className="flex items-center gap-1 rounded-lg bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200">
                            <XCircle className="h-3 w-3" /> {t('actions.reject')}
                          </button>
                        </>
                      )}
                      {r.status === 'approved' && (
                        <button onClick={() => { setPayError(null); setPayProvider('wave'); setPayId(r.id) }}
                          className="flex items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200">
                          <CreditCard className="h-3 w-3" /> {t('actions.pay')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {reports.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    <Receipt className="mx-auto mb-2 h-8 w-8 opacity-30" />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRejectId(null)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-3">{t('rejectModal.title')}</h3>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              placeholder={t('rejectModal.placeholder')}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none resize-none"
              rows={3} />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setRejectId(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('rejectModal.cancel')}</button>
              <button onClick={() => rejectMut.mutate({ id: rejectId, reason: rejectReason })}
                disabled={rejectMut.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
                {t('rejectModal.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FRA-006 — Modal remboursement Mobile Money */}
      {payId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPayId(null)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-3">{t('payModal.title', { defaultValue: 'Rembourser via Mobile Money' })}</h3>
            <label className="text-xs font-medium text-muted-foreground">{t('payModal.provider', { defaultValue: 'Opérateur' })}</label>
            <select value={payProvider} onChange={e => setPayProvider(e.target.value)}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
              <option value="wave">Wave</option>
              <option value="mtn_momo">MTN MoMo</option>
              <option value="orange_money">Orange Money</option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('payModal.hint', { defaultValue: 'Le virement utilise le numéro Mobile Money enregistré du salarié.' })}
            </p>
            {payError && <p className="mt-2 text-xs text-red-600">{payError}</p>}
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setPayId(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('rejectModal.cancel')}</button>
              <button onClick={() => payMut.mutate({ id: payId, provider: payProvider })}
                disabled={payMut.isPending}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
                {t('payModal.confirm', { defaultValue: 'Confirmer le remboursement' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
