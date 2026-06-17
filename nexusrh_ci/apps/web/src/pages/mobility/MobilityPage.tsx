import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Route as RouteIcon, Plus, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

type Tab = 'requests' | 'assessments'
const BLOOM = [1, 2, 3, 4, 5, 6] as const
const DECIDE_ROLES = ['admin', 'hr_manager']

interface EmployeeRow { id: string; first_name: string; last_name: string }
interface JobProfile { id: string; title: string }
interface Competency { id: string; label: string; category: string | null }
interface AssessedRow { id: string; competency_id: string; label: string; level: number }
interface RequestRow { id: string; employee_id: string; first_name: string; last_name: string; target_title: string; status: string; reason: string | null; corrective_actions: string | null }
interface GapRow { competencyId: string; label: string; requiredLevel: number; currentLevel: number | null; gap: number }
interface Gap { rows: GapRow[]; gapsCount: number; ready: boolean; coveragePct: number }
interface RequestDetail extends RequestRow { gap: Gap }

const STATUS_STYLE: Record<string, string> = {
  proposed: 'bg-muted text-muted-foreground', in_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800', rejected: 'bg-rose-100 text-rose-800', cancelled: 'bg-slate-200 text-slate-600',
}

export default function MobilityPage() {
  const { t } = useTranslation('mobility')
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canDecide = DECIDE_ROLES.includes(role)
  const [tab, setTab] = useState<Tab>('requests')

  const empQ = useQuery({ queryKey: ['employees', 'min'], queryFn: async () => (await api.get('/employees')).data.data as EmployeeRow[] })
  const jobsQ = useQuery({ queryKey: ['competencies', 'profiles'], queryFn: async () => (await api.get('/competencies/job-profiles')).data.data as JobProfile[] })

  // ── Passerelles ──
  const listQ = useQuery({ queryKey: ['mobility', 'requests'], queryFn: async () => (await api.get('/mobility/requests')).data.data as RequestRow[] })
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ employeeId: '', targetJobProfileId: '', reason: '' })
  const [open, setOpen] = useState<string | null>(null)
  const detailQ = useQuery({
    queryKey: ['mobility', 'request', open], enabled: !!open,
    queryFn: async () => (await api.get(`/mobility/requests/${open}`)).data.data as RequestDetail,
  })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['mobility', 'requests'] }); if (open) qc.invalidateQueries({ queryKey: ['mobility', 'request', open] }) }
  const createReq = useMutation({
    mutationFn: async () => { await api.post('/mobility/requests', { employeeId: form.employeeId, targetJobProfileId: form.targetJobProfileId, reason: form.reason || undefined }) },
    onSuccess: () => { setShowForm(false); setForm({ employeeId: '', targetJobProfileId: '', reason: '' }); refresh() },
  })
  const patchReq = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => { await api.patch(`/mobility/requests/${id}`, body) },
    onSuccess: refresh,
  })
  const deleteReq = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/mobility/requests/${id}`) },
    onSuccess: () => { setOpen(null); refresh() },
  })

  // ── Évaluations ──
  const catalogQ = useQuery({ queryKey: ['competencies', 'catalog'], queryFn: async () => (await api.get('/competencies/catalog')).data.data as Competency[] })
  const [assessEmp, setAssessEmp] = useState('')
  const assessedQ = useQuery({
    queryKey: ['mobility', 'assessed', assessEmp], enabled: !!assessEmp,
    queryFn: async () => (await api.get(`/mobility/employees/${assessEmp}/competencies`)).data.data as AssessedRow[],
  })
  const setLevel = useMutation({
    mutationFn: async ({ competencyId, level }: { competencyId: string; level: number }) => { await api.put(`/mobility/employees/${assessEmp}/competencies`, { competencyId, level }) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mobility', 'assessed', assessEmp] }),
  })
  const assessedLevel = (competencyId: string): number | '' => assessedQ.data?.find((a) => a.competency_id === competencyId)?.level ?? ''

  const TabBtn = ({ value, label }: { value: Tab; label: string }) => (
    <button type="button" onClick={() => setTab(value)}
      className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', tab === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent')}>{label}</button>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><RouteIcon className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        {tab === 'requests' && (
          <button type="button" onClick={() => setShowForm((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90">
            <Plus className="h-4 w-4" /> {t('requests.new')}
          </button>
        )}
      </div>

      <div className="flex w-fit gap-1.5 rounded-xl border border-border bg-muted/40 p-1">
        <TabBtn value="requests" label={t('tabs.requests')} />
        <TabBtn value="assessments" label={t('tabs.assessments')} />
      </div>

      {/* ── Passerelles ── */}
      {tab === 'requests' && (
        <div className="space-y-4">
          {showForm && (
            <div className="max-w-2xl rounded-xl border border-border bg-card p-4 space-y-2">
              <select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                <option value="">{t('requests.employee')}</option>
                {(empQ.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
              </select>
              <select value={form.targetJobProfileId} onChange={(e) => setForm((f) => ({ ...f, targetJobProfileId: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                <option value="">{t('requests.target')}</option>
                {(jobsQ.data ?? []).map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
              </select>
              <input type="text" placeholder={t('requests.reason')} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
              <div className="flex justify-end">
                <button type="button" disabled={!form.employeeId || !form.targetJobProfileId || createReq.isPending} onClick={() => createReq.mutate()}
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  {createReq.isPending ? t('requests.creating') : t('requests.create')}
                </button>
              </div>
            </div>
          )}

          {(listQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('requests.empty')}</p>}

          <div className="space-y-3">
            {(listQ.data ?? []).map((r) => (
              <div key={r.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" className="text-left" onClick={() => setOpen((o) => o === r.id ? null : r.id)}>
                    <p className="font-semibold">{r.first_name} {r.last_name} → {r.target_title}</p>
                    {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
                  </button>
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[r.status] ?? 'bg-muted')}>{t(`statuses.${r.status}`)}</span>
                    {r.status === 'proposed' && <button type="button" onClick={() => patchReq.mutate({ id: r.id, body: { status: 'in_review' } })} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('requests.toReview')}</button>}
                    {r.status === 'in_review' && canDecide && (
                      <>
                        <button type="button" onClick={() => patchReq.mutate({ id: r.id, body: { status: 'approved' } })} className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:opacity-90">{t('requests.approve')}</button>
                        <button type="button" onClick={() => patchReq.mutate({ id: r.id, body: { status: 'rejected' } })} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('requests.reject')}</button>
                      </>
                    )}
                    <button type="button" onClick={() => { if (window.confirm(t('requests.deleteConfirm'))) deleteReq.mutate(r.id) }} className="rounded-md p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>

                {open === r.id && detailQ.data && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('gap.title')}</h3>
                      <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', detailQ.data.gap.ready ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800')}>
                        {detailQ.data.gap.ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        {detailQ.data.gap.ready ? t('gap.ready') : t('gap.notReady')} · {t('gap.coverage', { pct: detailQ.data.gap.coveragePct })}
                      </span>
                    </div>
                    {detailQ.data.gap.rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t('gap.noData')}</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="px-2 py-1.5">{t('gap.competency')}</th>
                          <th className="px-2 py-1.5">{t('gap.required')}</th>
                          <th className="px-2 py-1.5">{t('gap.current')}</th>
                          <th className="px-2 py-1.5">{t('gap.gapCol')}</th>
                        </tr></thead>
                        <tbody>
                          {detailQ.data.gap.rows.map((g) => (
                            <tr key={g.competencyId} className="border-b border-border/60 last:border-0">
                              <td className="px-2 py-1.5 font-medium">{g.label}</td>
                              <td className="px-2 py-1.5">{g.requiredLevel}</td>
                              <td className="px-2 py-1.5">{g.currentLevel ?? t('gap.none')}</td>
                              <td className={cn('px-2 py-1.5 font-semibold', g.gap > 0 ? 'text-amber-600' : 'text-emerald-600')}>{g.gap > 0 ? `-${g.gap}` : '✓'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">{t('requests.correctiveActions')}</label>
                      <textarea rows={2} defaultValue={detailQ.data.corrective_actions ?? ''}
                        onBlur={(e) => { if (e.target.value !== (detailQ.data?.corrective_actions ?? '')) patchReq.mutate({ id: r.id, body: { correctiveActions: e.target.value } }) }}
                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Évaluations ── */}
      {tab === 'assessments' && (
        <div className="max-w-3xl space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <label className="text-xs font-medium text-muted-foreground">{t('assess.selectEmployee')}</label>
            <select value={assessEmp} onChange={(e) => setAssessEmp(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
              <option value="">{t('assess.select')}</option>
              {(empQ.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
            </select>
          </div>
          {!assessEmp && <p className="rounded-xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">{t('assess.empty')}</p>}
          {assessEmp && (catalogQ.data?.length ?? 0) === 0 && <p className="rounded-xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">{t('assess.noCatalog')}</p>}
          {assessEmp && (catalogQ.data?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-border bg-card divide-y divide-border">
              {(catalogQ.data ?? []).map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <div>
                    <p className="text-sm font-medium">{c.label}</p>
                    {c.category && <p className="text-xs text-muted-foreground">{c.category}</p>}
                  </div>
                  <select value={assessedLevel(c.id)} onChange={(e) => setLevel.mutate({ competencyId: c.id, level: Number(e.target.value) })}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                    <option value="">{t('bloom.na')}</option>
                    {BLOOM.map((n) => <option key={n} value={n}>{t(`bloom.${n}`)}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
