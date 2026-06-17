import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Gavel, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface EmployeeRow { id: string; first_name: string; last_name: string; employee_number: string | null }
interface DisciplineRow {
  id: string
  employee_id: string
  first_name: string
  last_name: string
  type: string
  reason: string
  action_date: string
  status: string
}

const TYPES = ['observation', 'avertissement', 'blame', 'mise_a_pied', 'licenciement'] as const

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  issued: 'bg-amber-100 text-amber-800',
  contested: 'bg-orange-100 text-orange-800',
  closed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-rose-100 text-rose-800',
}

export default function DisciplinePage() {
  const { t } = useTranslation('discipline')
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ employeeId: '', type: 'avertissement', actionDate: '', reason: '', description: '' })

  const listQ = useQuery({
    queryKey: ['discipline'],
    queryFn: async () => {
      const res = await api.get('/discipline')
      return (res.data as { data: DisciplineRow[] }).data
    },
  })

  const empQ = useQuery({
    queryKey: ['employees', 'min'],
    queryFn: async () => {
      const res = await api.get('/employees')
      return (res.data as { data: EmployeeRow[] }).data
    },
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['discipline'] })

  const createMut = useMutation({
    mutationFn: async () => {
      await api.post('/discipline', {
        employeeId: form.employeeId,
        type: form.type,
        actionDate: form.actionDate,
        reason: form.reason,
        description: form.description || undefined,
      })
    },
    onSuccess: () => {
      setShowForm(false)
      setForm({ employeeId: '', type: 'avertissement', actionDate: '', reason: '', description: '' })
      invalidate()
    },
  })

  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await api.patch(`/discipline/${id}`, { status })
    },
    onSuccess: invalidate,
  })

  const deleteMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/discipline/${id}`) },
    onSuccess: invalidate,
  })

  const canSubmit = form.employeeId && form.actionDate && form.reason.trim().length > 0

  return (
    <div className="p-6 space-y-6">
      {/* En-tête */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Gavel className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> {t('new')}
        </button>
      </div>

      {/* Bandeau confidentialité niveau 4 */}
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <ShieldAlert className="h-4 w-4 shrink-0" /> {t('restricted')}
      </div>

      {/* Formulaire */}
      {showForm && (
        <div className="max-w-2xl rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('form.title')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('form.employee')}</span>
              <select
                value={form.employeeId}
                onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              >
                <option value="">{t('form.employeePlaceholder')}</option>
                {(empQ.data ?? []).map((e) => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('form.type')}</span>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              >
                {TYPES.map((ty) => <option key={ty} value={ty}>{t(`types.${ty}`)}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('form.date')}</span>
              <input
                type="date"
                value={form.actionDate}
                onChange={(e) => setForm((f) => ({ ...f, actionDate: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-muted-foreground">{t('form.reason')}</span>
              <input
                type="text"
                value={form.reason}
                placeholder={t('form.reasonPlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">
              {t('form.cancel')}
            </button>
            <button
              type="button"
              disabled={!canSubmit || createMut.isPending}
              onClick={() => createMut.mutate()}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {createMut.isPending ? t('form.submitting') : t('form.submit')}
            </button>
          </div>
        </div>
      )}

      {/* Liste */}
      <div className="rounded-xl border border-border bg-card">
        {listQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
        {listQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('loadError')}</p>}
        {!listQ.isLoading && !listQ.isError && (listQ.data?.length ?? 0) === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>
        )}
        {!listQ.isLoading && (listQ.data?.length ?? 0) > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">{t('columns.employee')}</th>
                <th className="px-3 py-2">{t('columns.type')}</th>
                <th className="px-3 py-2">{t('columns.date')}</th>
                <th className="px-3 py-2">{t('columns.reason')}</th>
                <th className="px-3 py-2">{t('columns.status')}</th>
                <th className="px-3 py-2 text-right">{t('columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(listQ.data ?? []).map((d) => (
                <tr key={d.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 font-medium">{d.first_name} {d.last_name}</td>
                  <td className="px-3 py-2">{t(`types.${d.type}`)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d.action_date}</td>
                  <td className="px-3 py-2 max-w-[18rem] truncate" title={d.reason}>{d.reason}</td>
                  <td className="px-3 py-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[d.status] ?? 'bg-muted')}>
                      {t(`statuses.${d.status}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {d.status === 'draft' && (
                        <button type="button" onClick={() => statusMut.mutate({ id: d.id, status: 'issued' })}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                          {t('actions.issue')}
                        </button>
                      )}
                      {(d.status === 'issued' || d.status === 'contested') && (
                        <button type="button" onClick={() => statusMut.mutate({ id: d.id, status: 'closed' })}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                          {t('actions.close')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => { if (window.confirm(t('actions.deleteConfirm'))) deleteMut.mutate(d.id) }}
                        className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title={t('actions.delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
