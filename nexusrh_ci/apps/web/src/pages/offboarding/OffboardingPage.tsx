import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { DoorOpen, Plus, Calculator, Trash2 } from 'lucide-react'
import { api, formatFCFA } from '@/lib/api'
import { cn } from '@/lib/utils'

interface EmployeeRow { id: string; first_name: string; last_name: string }
interface ChecklistItem { key: string; label: string; done: boolean }
interface SettlementLine { key: string; label: string; amount: number }
interface Settlement { total: number; lines: SettlementLine[] }
interface OffboardingRow {
  id: string
  employee_id: string
  first_name: string
  last_name: string
  departure_type: string
  departure_date: string
  status: string
  checklist: ChecklistItem[]
  settlement: Settlement | null
}

const TYPES = ['demission', 'retraite', 'licenciement', 'fin_cdd', 'rupture_conventionnelle', 'autre'] as const

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-muted text-muted-foreground',
  in_progress: 'bg-amber-100 text-amber-800',
  settled: 'bg-blue-100 text-blue-800',
  closed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-rose-100 text-rose-800',
}

export default function OffboardingPage() {
  const { t } = useTranslation('offboarding')
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ employeeId: '', departureType: 'demission', departureDate: '', reason: '', noticeServed: true })
  const [congesDays, setCongesDays] = useState<Record<string, number>>({})

  const listQ = useQuery({
    queryKey: ['offboarding'],
    queryFn: async () => {
      const res = await api.get('/offboarding')
      return (res.data as { data: OffboardingRow[] }).data
    },
  })
  const empQ = useQuery({
    queryKey: ['employees', 'min'],
    queryFn: async () => {
      const res = await api.get('/employees')
      return (res.data as { data: EmployeeRow[] }).data
    },
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['offboarding'] })

  const createMut = useMutation({
    mutationFn: async () => {
      await api.post('/offboarding', {
        employeeId: form.employeeId,
        departureType: form.departureType,
        departureDate: form.departureDate,
        reason: form.reason || undefined,
        noticeServed: form.noticeServed,
      })
    },
    onSuccess: () => {
      setShowForm(false)
      setForm({ employeeId: '', departureType: 'demission', departureDate: '', reason: '', noticeServed: true })
      invalidate()
    },
  })

  const patchMut = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      await api.patch(`/offboarding/${id}`, body)
    },
    onSuccess: invalidate,
  })

  const settlementMut = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await api.post(`/offboarding/${id}/settlement`, { congesDaysOutstanding: congesDays[id] ?? 0 })
    },
    onSuccess: invalidate,
  })

  const deleteMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/offboarding/${id}`) },
    onSuccess: invalidate,
  })

  function toggleChecklist(c: OffboardingRow, key: string) {
    const checklist = (c.checklist ?? []).map((it) => it.key === key ? { ...it, done: !it.done } : it)
    patchMut.mutate({ id: c.id, body: { checklist } })
  }

  const canSubmit = form.employeeId && form.departureDate

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <DoorOpen className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <button type="button" onClick={() => setShowForm((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('new')}
        </button>
      </div>

      {showForm && (
        <div className="max-w-2xl rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('form.title')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('form.employee')}</span>
              <select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                <option value="">{t('form.employeePlaceholder')}</option>
                {(empQ.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('form.type')}</span>
              <select value={form.departureType} onChange={(e) => setForm((f) => ({ ...f, departureType: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                {TYPES.map((ty) => <option key={ty} value={ty}>{t(`types.${ty}`)}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('form.date')}</span>
              <input type="date" value={form.departureDate} onChange={(e) => setForm((f) => ({ ...f, departureDate: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5" />
            </label>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={form.noticeServed} onChange={(e) => setForm((f) => ({ ...f, noticeServed: e.target.checked }))} />
              {t('form.noticeServed')}
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">{t('form.cancel')}</button>
            <button type="button" disabled={!canSubmit || createMut.isPending} onClick={() => createMut.mutate()}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {createMut.isPending ? t('form.submitting') : t('form.submit')}
            </button>
          </div>
        </div>
      )}

      {listQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
      {listQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('loadError')}</p>}
      {!listQ.isLoading && (listQ.data?.length ?? 0) === 0 && (
        <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>
      )}

      <div className="space-y-4">
        {(listQ.data ?? []).map((c) => (
          <div key={c.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold">{c.first_name} {c.last_name}</p>
                <p className="text-sm text-muted-foreground">{t(`types.${c.departure_type}`)} · {c.departure_date}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[c.status] ?? 'bg-muted')}>{t(`statuses.${c.status}`)}</span>
                {c.status === 'open' && (
                  <button type="button" onClick={() => patchMut.mutate({ id: c.id, body: { status: 'in_progress' } })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('actions.progress')}</button>
                )}
                {c.status === 'settled' && (
                  <button type="button" onClick={() => patchMut.mutate({ id: c.id, body: { status: 'closed' } })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('actions.close')}</button>
                )}
                <button type="button" onClick={() => { if (window.confirm(t('actions.deleteConfirm'))) deleteMut.mutate(c.id) }}
                  className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title={t('actions.delete')}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Checklist */}
              <div>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('checklist.title')}</h3>
                <ul className="space-y-1">
                  {(c.checklist ?? []).map((it) => (
                    <li key={it.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={it.done} onChange={() => toggleChecklist(c, it.key)} />
                      <span className={cn(it.done && 'text-muted-foreground line-through')}>{it.label}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Solde de tout compte */}
              <div>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settlement.title')}</h3>
                <div className="flex items-end gap-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{t('settlement.congesDays')}</span>
                    <input type="number" min={0} value={congesDays[c.id] ?? 0}
                      onChange={(e) => setCongesDays((m) => ({ ...m, [c.id]: Number(e.target.value) }))}
                      className="w-24 rounded-md border border-border bg-background px-2 py-1" />
                  </label>
                  <button type="button" disabled={settlementMut.isPending} onClick={() => settlementMut.mutate({ id: c.id })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    <Calculator className="h-4 w-4" /> {settlementMut.isPending ? t('settlement.computing') : t('settlement.compute')}
                  </button>
                </div>
                {c.settlement && (
                  <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2 text-sm">
                    {c.settlement.lines.filter((l) => l.amount > 0).map((l) => (
                      <div key={l.key} className="flex justify-between"><span className="text-muted-foreground">{l.label}</span><span>{formatFCFA(l.amount)}</span></div>
                    ))}
                    <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
                      <span>{t('settlement.total')}</span><span>{formatFCFA(c.settlement.total)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{t('settlement.estimateNote')}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
