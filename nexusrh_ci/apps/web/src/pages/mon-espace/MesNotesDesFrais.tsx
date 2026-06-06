import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, formatFCFA, formatDate } from '@/lib/api'
import { Receipt, Plus, Send, Trash2 } from 'lucide-react'

interface Line { description: string; category: string; date: string; amount: string }

interface ExpenseReport {
  id: string; title: string; month: string; total_amount: string; status: string
  submitted_at: string | null; paid_at: string | null; rejection_reason: string | null
  lines: Array<{ id: string; description: string; category: string; date: string; amount: string }> | null
}

const STATUS_COLOR: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  submitted: 'bg-yellow-100 text-yellow-700',
  approved:  'bg-blue-100 text-blue-700',
  paid:      'bg-green-100 text-green-700',
  rejected:  'bg-red-100 text-red-700',
}
const STATUS_KEY: Record<string, string> = {
  draft:     'common.status.draft',
  submitted: 'common.status.submitted',
  approved:  'common.status.approved',
  paid:      'common.status.paid',
  rejected:  'common.status.rejected',
}

const CATEGORY_VALUES = ['transport', 'repas', 'hebergement', 'materiel', 'communication', 'autre'] as const

export default function MesNotesDesFrais() {
  const { t } = useTranslation('monEspace')
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [title, setTitle] = useState('')
  const [lines, setLines] = useState<Line[]>([
    { description: '', category: 'transport', date: new Date().toISOString().slice(0, 10), amount: '' },
  ])

  const { data, isLoading } = useQuery<{ data: ExpenseReport[] }>({
    queryKey: ['my-expenses'],
    queryFn: () => api.get('/expenses/my-expenses').then(r => r.data),
  })

  const createMut = useMutation({
    mutationFn: (data: { title: string; lines: Line[] }) =>
      api.post('/expenses', { title: data.title, lines: data.lines.map(l => ({ ...l, amount: parseInt(l.amount) || 0 })) }),
    onSuccess: () => {
      setShowNew(false)
      setTitle('')
      setLines([{ description: '', category: 'transport', date: new Date().toISOString().slice(0, 10), amount: '' }])
      queryClient.invalidateQueries({ queryKey: ['my-expenses'] })
    },
  })

  const submitMut = useMutation({
    mutationFn: (id: string) => api.patch(`/expenses/${id}/submit`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-expenses'] }),
  })

  const reports = data?.data ?? []
  const totalPending = reports.filter(r => r.status === 'submitted').reduce((s, r) => s + parseInt(r.total_amount || '0'), 0)

  function addLine() {
    setLines(l => [...l, { description: '', category: 'transport', date: new Date().toISOString().slice(0, 10), amount: '' }])
  }
  function removeLine(i: number) {
    setLines(l => l.filter((_, idx) => idx !== i))
  }
  function updateLine(i: number, field: keyof Line, value: string) {
    setLines(l => l.map((line, idx) => idx === i ? { ...line, [field]: value } : line))
  }

  const linesTotal = lines.reduce((s, l) => s + (parseInt(l.amount) || 0), 0)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('expenses.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('expenses.subtitle', { count: reports.length, amount: formatFCFA(totalPending) })}
          </p>
        </div>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('expenses.newNote')}
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map(r => (
            <div key={r.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-xs text-muted-foreground">{r.month}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{formatFCFA(parseInt(r.total_amount || '0'))}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[r.status] ?? 'bg-muted'}`}>
                    {STATUS_KEY[r.status] ? t(STATUS_KEY[r.status] as string) : r.status}
                  </span>
                </div>
              </div>

              {r.rejection_reason && (
                <p className="mt-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{r.rejection_reason}</p>
              )}

              {r.lines && r.lines.length > 0 && (
                <div className="mt-3 space-y-1">
                  {r.lines.map(l => (
                    <div key={l.id} className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{l.description} <span className="text-muted-foreground/60">· {t(`expenses.categories.${l.category}`, { defaultValue: l.category })}</span></span>
                      <span className="font-medium">{formatFCFA(parseInt(l.amount || '0'))}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {r.submitted_at && <>{t('expenses.submittedOn', { date: formatDate(r.submitted_at) })}</>}
                  {r.paid_at && <> · {t('expenses.paidOn', { date: formatDate(r.paid_at) })}</>}
                </p>
                {r.status === 'draft' && (
                  <button onClick={() => submitMut.mutate(r.id)} disabled={submitMut.isPending}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    <Send className="h-3 w-3" /> {t('expenses.submit')}
                  </button>
                )}
              </div>
            </div>
          ))}
          {reports.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              <Receipt className="mx-auto mb-2 h-8 w-8 opacity-30" />
              {t('expenses.empty')}
            </div>
          )}
        </div>
      )}

      {/* Modal nouvelle note */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowNew(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-xl shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">{t('expenses.modalTitle')}</h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('expenses.fieldTitle')}</label>
                <input value={title} onChange={e => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder={t('expenses.titlePlaceholder')} />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-muted-foreground">{t('expenses.lines')}</label>
                  <button onClick={addLine} className="flex items-center gap-1 text-xs text-primary hover:underline">
                    <Plus className="h-3 w-3" /> {t('expenses.addLine')}
                  </button>
                </div>
                <div className="space-y-3">
                  {lines.map((line, i) => (
                    <div key={i} className="rounded-lg border border-border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{t('expenses.line', { number: i + 1 })}</span>
                        {lines.length > 1 && (
                          <button onClick={() => removeLine(i)} className="text-red-500 hover:text-red-700">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      <input value={line.description} onChange={e => updateLine(i, 'description', e.target.value)}
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                        placeholder={t('expenses.descriptionPlaceholder')} />
                      <div className="grid grid-cols-3 gap-2">
                        <select value={line.category} onChange={e => updateLine(i, 'category', e.target.value)}
                          className="rounded-lg border border-input bg-background px-2 py-2 text-sm outline-none">
                          {CATEGORY_VALUES.map(c => <option key={c} value={c}>{t(`expenses.categories.${c}`)}</option>)}
                        </select>
                        <input type="date" value={line.date} onChange={e => updateLine(i, 'date', e.target.value)}
                          className="rounded-lg border border-input bg-background px-2 py-2 text-sm outline-none" />
                        <input type="number" value={line.amount} onChange={e => updateLine(i, 'amount', e.target.value)}
                          className="rounded-lg border border-input bg-background px-2 py-2 text-sm outline-none"
                          placeholder={t('expenses.amountPlaceholder')} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {linesTotal > 0 && (
                <div className="rounded-lg bg-muted/50 px-4 py-2 flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('expenses.total')}</span>
                  <span className="font-bold">{formatFCFA(linesTotal)}</span>
                </div>
              )}
            </div>

            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNew(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('common.cancel')}</button>
              <button onClick={() => createMut.mutate({ title, lines })}
                disabled={!title || lines.some(l => !l.description || !l.amount) || createMut.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {createMut.isPending ? t('expenses.saving') : t('expenses.saveDraft')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
