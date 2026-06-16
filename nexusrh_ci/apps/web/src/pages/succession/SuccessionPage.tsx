import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitBranch, Plus, Trash2, AlertTriangle, CheckCircle2, UserPlus } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Criticality = 'low' | 'medium' | 'high' | 'critical'
type Readiness = 'ready_now' | 'short_term' | 'medium_term' | 'long_term'
const READINESS: Readiness[] = ['ready_now', 'short_term', 'medium_term', 'long_term']

interface EmployeeRow { id: string; first_name: string; last_name: string }
interface Coverage { candidateCount: number; readyNow: number; atRisk: boolean }
interface PlanRow {
  id: string
  position_title: string
  criticality: Criticality
  status: string
  incumbent_first_name: string | null
  incumbent_last_name: string | null
  coverage: Coverage
}
interface CandidateRow { id: string; employee_id: string; first_name: string; last_name: string; readiness: Readiness }
interface PlanDetail extends PlanRow { candidates: CandidateRow[] }

const CRIT_STYLE: Record<Criticality, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-blue-100 text-blue-800',
  high: 'bg-amber-100 text-amber-800',
  critical: 'bg-rose-100 text-rose-800',
}

export default function SuccessionPage() {
  const { t } = useTranslation('succession')
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [openPlan, setOpenPlan] = useState<string | null>(null)
  const [form, setForm] = useState<{ positionTitle: string; incumbentEmployeeId: string; criticality: Criticality }>({
    positionTitle: '', incumbentEmployeeId: '', criticality: 'medium',
  })
  const [newCand, setNewCand] = useState<{ employeeId: string; readiness: Readiness }>({ employeeId: '', readiness: 'medium_term' })

  const listQ = useQuery({
    queryKey: ['succession', 'plans'],
    queryFn: async () => {
      const res = await api.get('/succession/plans')
      return (res.data as { data: PlanRow[] }).data
    },
  })
  const empQ = useQuery({
    queryKey: ['employees', 'min'],
    queryFn: async () => {
      const res = await api.get('/employees')
      return (res.data as { data: EmployeeRow[] }).data
    },
  })
  const detailQ = useQuery({
    queryKey: ['succession', 'plan', openPlan],
    enabled: !!openPlan,
    queryFn: async () => {
      const res = await api.get(`/succession/plans/${openPlan}`)
      return (res.data as { data: PlanDetail }).data
    },
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['succession', 'plans'] })
    if (openPlan) void qc.invalidateQueries({ queryKey: ['succession', 'plan', openPlan] })
  }

  const createMut = useMutation({
    mutationFn: async () => {
      await api.post('/succession/plans', {
        positionTitle: form.positionTitle,
        incumbentEmployeeId: form.incumbentEmployeeId || undefined,
        criticality: form.criticality,
      })
    },
    onSuccess: () => { setShowForm(false); setForm({ positionTitle: '', incumbentEmployeeId: '', criticality: 'medium' }); invalidate() },
  })
  const deleteMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/succession/plans/${id}`) },
    onSuccess: () => { setOpenPlan(null); invalidate() },
  })
  const addCandMut = useMutation({
    mutationFn: async (planId: string) => { await api.post(`/succession/plans/${planId}/candidates`, newCand) },
    onSuccess: () => { setNewCand({ employeeId: '', readiness: 'medium_term' }); invalidate() },
  })
  const candReadinessMut = useMutation({
    mutationFn: async ({ id, readiness }: { id: string; readiness: Readiness }) => { await api.patch(`/succession/candidates/${id}`, { readiness }) },
    onSuccess: invalidate,
  })
  const removeCandMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/succession/candidates/${id}`) },
    onSuccess: invalidate,
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><GitBranch className="h-5 w-5" /></div>
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
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold">{t('form.title')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input type="text" value={form.positionTitle} placeholder={t('form.positionPlaceholder')}
              onChange={(e) => setForm((f) => ({ ...f, positionTitle: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm sm:col-span-2" />
            <select value={form.criticality} onChange={(e) => setForm((f) => ({ ...f, criticality: e.target.value as Criticality }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
              {(['low', 'medium', 'high', 'critical'] as Criticality[]).map((c) => <option key={c} value={c}>{t(`criticality.${c}`)}</option>)}
            </select>
            <select value={form.incumbentEmployeeId} onChange={(e) => setForm((f) => ({ ...f, incumbentEmployeeId: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm sm:col-span-3">
              <option value="">{t('form.incumbentPlaceholder')}</option>
              {(empQ.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">{t('form.cancel')}</button>
            <button type="button" disabled={!form.positionTitle.trim() || createMut.isPending} onClick={() => createMut.mutate()}
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

      <div className="space-y-3">
        {(listQ.data ?? []).map((p) => (
          <div key={p.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="text-left" onClick={() => setOpenPlan((cur) => cur === p.id ? null : p.id)}>
                <p className="font-semibold">{p.position_title}</p>
                {p.incumbent_first_name && <p className="text-xs text-muted-foreground">{p.incumbent_first_name} {p.incumbent_last_name}</p>}
              </button>
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', CRIT_STYLE[p.criticality])}>{t(`criticality.${p.criticality}`)}</span>
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', p.coverage.atRisk ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800')}>
                  {p.coverage.atRisk ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                  {p.coverage.atRisk ? t('coverage.atRisk') : t('coverage.covered')}
                </span>
                <span className="text-xs text-muted-foreground">{t('coverage.candidates', { count: p.coverage.candidateCount })}</span>
                <button type="button" onClick={() => { if (window.confirm(t('actions.deleteConfirm'))) deleteMut.mutate(p.id) }}
                  className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>

            {openPlan === p.id && (
              <div className="mt-3 border-t border-border pt-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('candidates.title')}</h3>
                {detailQ.isLoading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
                {detailQ.data && detailQ.data.candidates.length === 0 && <p className="text-sm text-muted-foreground">{t('candidates.empty')}</p>}
                <ul className="space-y-1.5">
                  {(detailQ.data?.candidates ?? []).map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span>{c.first_name} {c.last_name}</span>
                      <div className="flex items-center gap-2">
                        <select value={c.readiness} onChange={(e) => candReadinessMut.mutate({ id: c.id, readiness: e.target.value as Readiness })}
                          className="rounded-md border border-border bg-background px-2 py-1 text-xs">
                          {READINESS.map((r) => <option key={r} value={r}>{t(`readiness.${r}`)}</option>)}
                        </select>
                        <button type="button" onClick={() => removeCandMut.mutate(c.id)} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <select value={newCand.employeeId} onChange={(e) => setNewCand((c) => ({ ...c, employeeId: e.target.value }))}
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                    <option value="">{t('candidates.employeePlaceholder')}</option>
                    {(empQ.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                  </select>
                  <select value={newCand.readiness} onChange={(e) => setNewCand((c) => ({ ...c, readiness: e.target.value as Readiness }))}
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                    {READINESS.map((r) => <option key={r} value={r}>{t(`readiness.${r}`)}</option>)}
                  </select>
                  <button type="button" disabled={!newCand.employeeId || addCandMut.isPending} onClick={() => addCandMut.mutate(p.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    <UserPlus className="h-4 w-4" /> {t('candidates.add')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
