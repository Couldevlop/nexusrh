import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Plus, BarChart3, Trash2, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type QType = 'scale' | 'boolean' | 'text'
interface SurveyRow {
  id: string
  title: string
  description: string | null
  status: string
  anonymous: boolean
  response_count: string
}
interface ScaleAgg { type: 'scale'; key: string; label: string; count: number; average: number; distribution: Record<string, number> }
interface BoolAgg { type: 'boolean'; key: string; label: string; count: number; yes: number; yesRate: number }
interface TextAgg { type: 'text'; key: string; label: string; count: number; answers: string[] }
type Agg = ScaleAgg | BoolAgg | TextAgg
interface Results { responseCount: number; questions: Agg[] }

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  open: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-slate-200 text-slate-700',
}

export default function ClimatePage() {
  const { t } = useTranslation('climate')
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [resultsFor, setResultsFor] = useState<string | null>(null)
  const [form, setForm] = useState<{ title: string; description: string; anonymous: boolean; questions: { label: string; type: QType }[] }>({
    title: '', description: '', anonymous: true, questions: [{ label: '', type: 'scale' }],
  })

  const listQ = useQuery({
    queryKey: ['climate', 'surveys'],
    queryFn: async () => {
      const res = await api.get('/climate/surveys')
      return (res.data as { data: SurveyRow[] }).data
    },
  })

  const resultsQ = useQuery({
    queryKey: ['climate', 'results', resultsFor],
    enabled: !!resultsFor,
    queryFn: async () => {
      const res = await api.get(`/climate/surveys/${resultsFor}/results`)
      return (res.data as { data: Results }).data
    },
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['climate', 'surveys'] })

  const createMut = useMutation({
    mutationFn: async () => {
      await api.post('/climate/surveys', {
        title: form.title,
        description: form.description || undefined,
        anonymous: form.anonymous,
        questions: form.questions.filter((q) => q.label.trim()),
      })
    },
    onSuccess: () => {
      setShowForm(false)
      setForm({ title: '', description: '', anonymous: true, questions: [{ label: '', type: 'scale' }] })
      invalidate()
    },
  })
  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => { await api.patch(`/climate/surveys/${id}`, { status }) },
    onSuccess: invalidate,
  })
  const deleteMut = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/climate/surveys/${id}`) },
    onSuccess: () => { setResultsFor(null); invalidate() },
  })

  const canSubmit = form.title.trim() && form.questions.some((q) => q.label.trim())

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><MessageSquare className="h-5 w-5" /></div>
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

      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        <ShieldCheck className="h-4 w-4 shrink-0" /> {t('anonymousNote')}
      </div>

      {showForm && (
        <div className="max-w-2xl rounded-xl border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold">{t('form.title')}</h2>
          <input type="text" value={form.title} placeholder={t('form.name')}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          <input type="text" value={form.description} placeholder={t('form.description')}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.anonymous} onChange={(e) => setForm((f) => ({ ...f, anonymous: e.target.checked }))} />
            {t('form.anonymous')}
          </label>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('form.questions')}</p>
            <div className="space-y-2">
              {form.questions.map((q, idx) => (
                <div key={idx} className="flex gap-2">
                  <input type="text" value={q.label} placeholder={t('form.questionLabel')}
                    onChange={(e) => setForm((f) => ({ ...f, questions: f.questions.map((x, i) => i === idx ? { ...x, label: e.target.value } : x) }))}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
                  <select value={q.type}
                    onChange={(e) => setForm((f) => ({ ...f, questions: f.questions.map((x, i) => i === idx ? { ...x, type: e.target.value as QType } : x) }))}
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                    <option value="scale">{t('questionTypes.scale')}</option>
                    <option value="boolean">{t('questionTypes.boolean')}</option>
                    <option value="text">{t('questionTypes.text')}</option>
                  </select>
                  {form.questions.length > 1 && (
                    <button type="button" onClick={() => setForm((f) => ({ ...f, questions: f.questions.filter((_, i) => i !== idx) }))}
                      className="rounded-md p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setForm((f) => ({ ...f, questions: [...f.questions, { label: '', type: 'scale' }] }))}
              className="mt-2 text-sm text-primary hover:underline">+ {t('form.addQuestion')}</button>
          </div>
          <div className="flex justify-end gap-2">
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

      <div className="space-y-3">
        {(listQ.data ?? []).map((s) => (
          <div key={s.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold">{s.title}</p>
                <p className="text-xs text-muted-foreground">{Number(s.response_count)} {t('columns.responses').toLowerCase()}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[s.status] ?? 'bg-muted')}>{t(`statuses.${s.status}`)}</span>
                {s.status === 'draft' && <button type="button" onClick={() => statusMut.mutate({ id: s.id, status: 'open' })} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('actions.open')}</button>}
                {s.status === 'open' && <button type="button" onClick={() => statusMut.mutate({ id: s.id, status: 'closed' })} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('actions.close')}</button>}
                <button type="button" onClick={() => setResultsFor((cur) => cur === s.id ? null : s.id)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"><BarChart3 className="h-3.5 w-3.5" /> {t('actions.results')}</button>
                <button type="button" onClick={() => { if (window.confirm(t('actions.deleteConfirm'))) deleteMut.mutate(s.id) }} className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>

            {resultsFor === s.id && (
              <div className="mt-3 border-t border-border pt-3">
                {resultsQ.isLoading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
                {resultsQ.data && resultsQ.data.responseCount === 0 && <p className="text-sm text-muted-foreground">{t('results.noData')}</p>}
                {resultsQ.data && resultsQ.data.responseCount > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">{t('results.responseCount', { count: resultsQ.data.responseCount })}</p>
                    {resultsQ.data.questions.map((q) => (
                      <div key={q.key} className="rounded-lg bg-muted/30 p-2 text-sm">
                        <p className="font-medium">{q.label}</p>
                        {q.type === 'scale' && <p className="text-muted-foreground">{t('results.average')} : <span className="font-semibold text-foreground">{q.average} / 5</span> ({q.count})</p>}
                        {q.type === 'boolean' && <p className="text-muted-foreground">{t('results.yesRate')} : <span className="font-semibold text-foreground">{Math.round(q.yesRate * 100)}%</span> ({q.yes}/{q.count})</p>}
                        {q.type === 'text' && (
                          <div>
                            <p className="text-muted-foreground">{t('results.answersCount', { count: q.count })}</p>
                            <ul className="mt-1 space-y-0.5">{q.answers.slice(0, 10).map((a, i) => <li key={i} className="text-xs italic">“{a}”</li>)}</ul>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
