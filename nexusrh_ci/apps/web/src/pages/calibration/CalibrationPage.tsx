import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Grid3x3, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const SCALE = [1, 2, 3] as const

interface SessionRow { id: string; title: string; session_date: string | null; scope: string | null; status: string; entry_count: string }
interface NineBox { cell: number; key: string }
interface EntryRow {
  id: string; employee_id: string; first_name: string; last_name: string
  performance_before: number | null; potential_before: number | null
  performance_after: number | null; potential_after: number | null
  qualities: string | null; gaps: string | null; corrective_actions: string | null
  boxBefore: NineBox | null; boxAfter: NineBox | null
}
interface SessionDetail extends SessionRow { entries: EntryRow[]; summary: { total: number; byKey: Record<string, number> } }
interface EmployeeRow { id: string; first_name: string; last_name: string }

// Disposition de la matrice : potentiel (lignes, élevé→faible) × performance (colonnes, faible→élevé)
const GRID: { pot: number; perf: number; key: string }[][] = [
  [{ pot: 3, perf: 1, key: 'enigma' }, { pot: 3, perf: 2, key: 'high_pot' }, { pot: 3, perf: 3, key: 'star' }],
  [{ pot: 2, perf: 1, key: 'inconsistent' }, { pot: 2, perf: 2, key: 'core' }, { pot: 2, perf: 3, key: 'high_perf' }],
  [{ pot: 1, perf: 1, key: 'risk' }, { pot: 1, perf: 2, key: 'solid' }, { pot: 1, perf: 3, key: 'expert' }],
]

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground', in_progress: 'bg-amber-100 text-amber-800', closed: 'bg-emerald-100 text-emerald-800',
}

export default function CalibrationPage() {
  const { t } = useTranslation('calibration')
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', sessionDate: '', scope: '' })
  const [newEmp, setNewEmp] = useState('')

  const listQ = useQuery({
    queryKey: ['calibration', 'sessions'],
    queryFn: async () => (await api.get('/calibration/sessions')).data.data as SessionRow[],
  })
  const empQ = useQuery({
    queryKey: ['employees', 'min'],
    queryFn: async () => (await api.get('/employees')).data.data as EmployeeRow[],
  })
  const detailQ = useQuery({
    queryKey: ['calibration', 'session', open],
    enabled: !!open,
    queryFn: async () => (await api.get(`/calibration/sessions/${open}`)).data.data as SessionDetail,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['calibration', 'sessions'] })
    if (open) qc.invalidateQueries({ queryKey: ['calibration', 'session', open] })
  }
  const createSession = useMutation({
    mutationFn: async () => { await api.post('/calibration/sessions', { title: form.title, sessionDate: form.sessionDate || undefined, scope: form.scope || undefined }) },
    onSuccess: () => { setShowForm(false); setForm({ title: '', sessionDate: '', scope: '' }); refresh() },
  })
  const deleteSession = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/calibration/sessions/${id}`) },
    onSuccess: () => { setOpen(null); refresh() },
  })
  const closeSession = useMutation({
    mutationFn: async (id: string) => { await api.patch(`/calibration/sessions/${id}`, { status: 'closed' }) },
    onSuccess: refresh,
  })
  const addEntry = useMutation({
    mutationFn: async (sessionId: string) => { await api.post(`/calibration/sessions/${sessionId}/entries`, { employeeId: newEmp }) },
    onSuccess: () => { setNewEmp(''); refresh() },
  })
  const patchEntry = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => { await api.patch(`/calibration/entries/${id}`, body) },
    onSuccess: refresh,
  })
  const removeEntry = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/calibration/entries/${id}`) },
    onSuccess: refresh,
  })

  const ScoreSelect = ({ value, onChange }: { value: number | null; onChange: (n: number) => void }) => (
    <select value={value ?? ''} onChange={e => onChange(Number(e.target.value))}
      className="rounded-md border border-border bg-background px-1.5 py-1 text-xs">
      <option value="">—</option>
      {SCALE.map(n => <option key={n} value={n}>{t(`scale.${n}`)}</option>)}
    </select>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Grid3x3 className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <button type="button" onClick={() => setShowForm(s => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
          <Plus className="h-4 w-4" /> {t('new')}
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input type="text" placeholder={t('form.name')} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
            <input type="date" value={form.sessionDate} onChange={e => setForm(f => ({ ...f, sessionDate: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
            <input type="text" placeholder={t('form.scope')} value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          </div>
          <div className="mt-2 flex justify-end">
            <button type="button" disabled={!form.title.trim() || createSession.isPending} onClick={() => createSession.mutate()}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {createSession.isPending ? t('form.submitting') : t('form.submit')}
            </button>
          </div>
        </div>
      )}

      {listQ.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
      {listQ.isError && <p className="py-10 text-center text-sm text-destructive">{t('loadError')}</p>}
      {!listQ.isLoading && (listQ.data?.length ?? 0) === 0 && (
        <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>
      )}

      <div className="space-y-3">
        {(listQ.data ?? []).map(s => (
          <div key={s.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="text-left" onClick={() => setOpen(o => o === s.id ? null : s.id)}>
                <p className="font-semibold">{s.title}</p>
                <p className="text-xs text-muted-foreground">{s.session_date ?? '—'} · {s.scope ?? '—'} · {t('session.count', { count: Number(s.entry_count) })}</p>
              </button>
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[s.status] ?? 'bg-muted')}>{t(`statuses.${s.status}`)}</span>
                {s.status !== 'closed' && <button type="button" onClick={() => closeSession.mutate(s.id)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('session.close')}</button>}
                <button type="button" onClick={() => { if (window.confirm(t('session.deleteConfirm'))) deleteSession.mutate(s.id) }} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>

            {open === s.id && (
              <div className="mt-3 space-y-4 border-t border-border pt-3">
                {/* Matrice 9-box */}
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('session.grid')}</h3>
                  <div className="grid grid-cols-3 gap-1.5">
                    {GRID.flat().map(cell => {
                      const count = detailQ.data?.summary.byKey[cell.key] ?? 0
                      return (
                        <div key={cell.key} className={cn('rounded-lg border p-2 text-center', count > 0 ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/30')}>
                          <p className="text-[11px] font-medium text-foreground">{t(`box.${cell.key}`)}</p>
                          <p className="text-lg font-bold text-primary">{count}</p>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Collaborateurs */}
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('session.entries')}</h3>
                  {(detailQ.data?.entries?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">{t('session.noEntries')}</p>}
                  <div className="space-y-1.5">
                    {(detailQ.data?.entries ?? []).map(en => (
                      <div key={en.id} className="rounded-lg border border-border p-2 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{en.first_name} {en.last_name}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{t('session.before')}:</span>
                            <ScoreSelect value={en.performance_before} onChange={n => patchEntry.mutate({ id: en.id, body: { performanceBefore: n } })} />
                            <ScoreSelect value={en.potential_before} onChange={n => patchEntry.mutate({ id: en.id, body: { potentialBefore: n } })} />
                            <span className="text-xs text-muted-foreground">{t('session.after')}:</span>
                            <ScoreSelect value={en.performance_after} onChange={n => patchEntry.mutate({ id: en.id, body: { performanceAfter: n } })} />
                            <ScoreSelect value={en.potential_after} onChange={n => patchEntry.mutate({ id: en.id, body: { potentialAfter: n } })} />
                            {(en.boxAfter ?? en.boxBefore) && (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{t(`box.${(en.boxAfter ?? en.boxBefore)!.key}`)}</span>
                            )}
                            <button type="button" onClick={() => removeEntry.mutate(en.id)} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        </div>
                        <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                          <input type="text" placeholder={t('session.qualities')} defaultValue={en.qualities ?? ''}
                            onBlur={e => { if (e.target.value !== (en.qualities ?? '')) patchEntry.mutate({ id: en.id, body: { qualities: e.target.value } }) }}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs" />
                          <input type="text" placeholder={t('session.gaps')} defaultValue={en.gaps ?? ''}
                            onBlur={e => { if (e.target.value !== (en.gaps ?? '')) patchEntry.mutate({ id: en.id, body: { gaps: e.target.value } }) }}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs" />
                          <input type="text" placeholder={t('session.corrective')} defaultValue={en.corrective_actions ?? ''}
                            onBlur={e => { if (e.target.value !== (en.corrective_actions ?? '')) patchEntry.mutate({ id: en.id, body: { correctiveActions: e.target.value } }) }}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs" />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <select value={newEmp} onChange={e => setNewEmp(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                      <option value="">{t('session.select')}</option>
                      {(empQ.data ?? []).map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                    </select>
                    <button type="button" disabled={!newEmp || addEntry.isPending} onClick={() => addEntry.mutate(s.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                      <Plus className="h-4 w-4" /> {t('session.addEmployee')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
