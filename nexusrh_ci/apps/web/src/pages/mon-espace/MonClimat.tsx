import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { MessageSquare, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type QType = 'scale' | 'boolean' | 'text'
interface Question { key: string; label: string; type: QType }
interface MySurvey {
  id: string
  title: string
  description: string | null
  questions: Question[]
  responded: boolean
}

function SurveyForm({ survey, onDone }: { survey: MySurvey; onDone: () => void }) {
  const { t } = useTranslation('climate')
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({})

  const submitMut = useMutation({
    mutationFn: async () => { await api.post(`/climate/surveys/${survey.id}/responses`, { answers }) },
    onSuccess: onDone,
  })

  const set = (key: string, value: string | number | boolean) => setAnswers((a) => ({ ...a, [key]: value }))

  return (
    <div className="space-y-4">
      {survey.questions.map((q) => (
        <div key={q.key}>
          <p className="mb-1 text-sm font-medium">{q.label}</p>
          {q.type === 'scale' && (
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => set(q.key, n)}
                  className={cn('h-9 w-9 rounded-md border text-sm font-medium',
                    answers[q.key] === n ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent')}>
                  {n}
                </button>
              ))}
            </div>
          )}
          {q.type === 'boolean' && (
            <div className="flex gap-2">
              {[['true', t('self.yes')], ['false', t('self.no')]].map(([val, label]) => (
                <button key={val} type="button" onClick={() => set(q.key, val === 'true')}
                  className={cn('rounded-md border px-3 py-1.5 text-sm',
                    answers[q.key] === (val === 'true') ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent')}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {q.type === 'text' && (
            <textarea rows={2} placeholder={t('self.textPlaceholder')}
              onChange={(e) => set(q.key, e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          )}
        </div>
      ))}
      <button type="button" disabled={submitMut.isPending} onClick={() => submitMut.mutate()}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {submitMut.isPending ? t('self.submitting') : t('self.submit')}
      </button>
    </div>
  )
}

export default function MonClimat() {
  const { t } = useTranslation('climate')
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['climate', 'my-surveys'],
    queryFn: async () => {
      const res = await api.get('/climate/my-surveys')
      return (res.data as { data: MySurvey[] }).data
    },
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['climate', 'my-surveys'] })

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 lg:p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><MessageSquare className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('self.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('self.subtitle')}</p>
        </div>
      </div>

      {q.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>}
      {!q.isLoading && (q.data?.length ?? 0) === 0 && (
        <p className="rounded-xl border border-border bg-card py-12 text-center text-sm text-muted-foreground">{t('self.empty')}</p>
      )}

      <div className="space-y-4">
        {(q.data ?? []).map((s) => (
          <div key={s.id} className="rounded-xl border border-border bg-card p-4">
            <p className="font-semibold">{s.title}</p>
            {s.description && <p className="mb-3 text-sm text-muted-foreground">{s.description}</p>}
            {s.responded ? (
              <p className="flex items-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {t('self.alreadyDone')}</p>
            ) : (
              <SurveyForm survey={s} onDone={refresh} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
