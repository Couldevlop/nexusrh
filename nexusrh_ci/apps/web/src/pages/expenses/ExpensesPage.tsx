import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { Receipt, CheckCircle, XCircle, CreditCard } from 'lucide-react'

interface ExpenseReport {
  id: string; employee_id: string; first_name: string; last_name: string
  department_name: string | null; title: string; month: string
  total_amount: string; status: string; submitted_at: string | null
  approved_at: string | null; paid_at: string | null
  rejection_reason: string | null; created_at: string
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Brouillon',  color: 'bg-gray-100 text-gray-600' },
  submitted: { label: 'Soumise',    color: 'bg-yellow-100 text-yellow-700' },
  approved:  { label: 'Approuvée',  color: 'bg-blue-100 text-blue-700' },
  paid:      { label: 'Remboursée', color: 'bg-green-100 text-green-700' },
  rejected:  { label: 'Refusée',    color: 'bg-red-100 text-red-700' },
}

export default function ExpensesPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('submitted')
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

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

  const payMut = useMutation({
    mutationFn: (id: string) => api.patch(`/expenses/${id}/pay`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expenses'] }),
  })

  const reports = data?.data ?? []
  const totalAmount = reports.reduce((sum, r) => sum + parseInt(r.total_amount || '0'), 0)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notes de frais</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {reports.length} note(s) · {formatFCFA(totalAmount)} total
          </p>
        </div>
      </div>

      {/* Filtres statut */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(STATUS_CONFIG).map(([s, cfg]) => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground hover:bg-accent'
            }`}>
            {cfg.label}
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
                <th className="p-4">Employé</th>
                <th className="p-4">Titre</th>
                <th className="p-4">Mois</th>
                <th className="p-4 text-right">Montant</th>
                <th className="p-4">Statut</th>
                <th className="p-4">Date soumission</th>
                <th className="p-4">Actions</th>
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
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CONFIG[r.status]?.color ?? 'bg-muted'}`}>
                      {STATUS_CONFIG[r.status]?.label ?? r.status}
                    </span>
                    {r.rejection_reason && (
                      <p className="mt-0.5 text-xs text-red-500 max-w-[160px] truncate" title={r.rejection_reason}>
                        {r.rejection_reason}
                      </p>
                    )}
                  </td>
                  <td className="p-4 text-muted-foreground text-xs">
                    {r.submitted_at ? formatDate(r.submitted_at) : '—'}
                  </td>
                  <td className="p-4">
                    <div className="flex gap-2 flex-wrap">
                      {r.status === 'submitted' && (
                        <>
                          <button onClick={() => approveMut.mutate(r.id)} disabled={approveMut.isPending}
                            className="flex items-center gap-1 rounded-lg bg-green-100 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-200 disabled:opacity-50">
                            <CheckCircle className="h-3 w-3" /> Approuver
                          </button>
                          <button onClick={() => setRejectId(r.id)}
                            className="flex items-center gap-1 rounded-lg bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200">
                            <XCircle className="h-3 w-3" /> Refuser
                          </button>
                        </>
                      )}
                      {r.status === 'approved' && (
                        <button onClick={() => payMut.mutate(r.id)} disabled={payMut.isPending}
                          className="flex items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200 disabled:opacity-50">
                          <CreditCard className="h-3 w-3" /> Rembourser
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
                    Aucune note de frais {STATUS_CONFIG[statusFilter]?.label?.toLowerCase()}
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
            <h3 className="font-semibold mb-3">Motif du refus</h3>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              placeholder="Expliquer la raison du refus (optionnel)..."
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none resize-none"
              rows={3} />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setRejectId(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => rejectMut.mutate({ id: rejectId, reason: rejectReason })}
                disabled={rejectMut.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
                Confirmer le refus
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
