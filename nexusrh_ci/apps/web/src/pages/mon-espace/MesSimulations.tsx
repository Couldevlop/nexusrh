import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useSpeech } from '@/hooks/useSpeech'
import { InterviewRestitution, type InterviewFeedback } from '@/components/interview-sim/InterviewRestitution'

interface AttemptRow { id: string; role_key: string; langue: string; created_at: string }
interface StartData {
  poste: { title: string; secteur: string | null; langue: 'fr' | 'en' }
  roleKey: string; langue: 'fr' | 'en'; nbQuestions: number
  questions: string[]; categories: string[]
}
type Feedback = InterviewFeedback

export default function MesSimulations() {
  const { t } = useTranslation('interviewSim')
  const qc = useQueryClient()
  const speech = useSpeech()

  const [session, setSession] = useState<StartData | null>(null)
  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<Array<{ index: number; question: string; transcript: string }>>([])
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const attempts = useQuery({
    queryKey: ['interview-sim', 'my-attempts'],
    queryFn: async () => (await api.get('/interview-sim/my-attempts')).data.data as AttemptRow[],
  })

  const start = useMutation({
    mutationFn: async () => (await api.get('/interview-sim/start')).data.data as StartData,
    onSuccess: (data) => {
      setSession(data); setCurrent(0); setAnswers([]); setDraft(''); setFeedback(null)
      if (speech.supported && data.questions[0]) speech.speak(data.questions[0], data.langue === 'en' ? 'en-US' : 'fr-FR')
    },
  })

  const submit = useMutation({
    mutationFn: async (payload: { roleKey: string; langue: string; questions: string[]; categories: string[]; answers: typeof answers }) =>
      (await api.post('/interview-sim/attempts/submit', payload)).data.data as { id: string; retour: Feedback },
    onSuccess: (data) => { setFeedback(data.retour); qc.invalidateQueries({ queryKey: ['interview-sim', 'my-attempts'] }) },
  })

  const removeAttempt = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/interview-sim/my-attempts/${id}`) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['interview-sim', 'my-attempts'] }),
  })

  function nextQuestion() {
    if (!session) return
    const item = { index: current, question: session.questions[current]!, transcript: draft.trim() }
    const nextAnswers = [...answers, item]
    setAnswers(nextAnswers); setDraft('')
    if (current + 1 < session.questions.length) {
      const n = current + 1; setCurrent(n)
      if (speech.supported) speech.speak(session.questions[n]!, session.langue === 'en' ? 'en-US' : 'fr-FR')
    } else {
      submit.mutate({
        roleKey: session.roleKey, langue: session.langue,
        questions: session.questions, categories: session.categories ?? [], answers: nextAnswers,
      })
    }
  }

  const currentCategory = session?.categories?.[current]

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      {!session && !feedback && (
        <div className="max-w-2xl rounded-lg border p-4 space-y-3">
          <p className="text-muted-foreground">{t('intro')}</p>
          <button className="rounded bg-primary px-4 py-2 text-white" onClick={() => start.mutate()} disabled={start.isPending}>
            {t('startButton')}
          </button>
          {!speech.supported && <p className="text-sm text-amber-600">{t('voiceUnsupported')}</p>}
        </div>
      )}

      {session && !feedback && (
        <div className="max-w-2xl rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t('questionProgress', { current: current + 1, total: session.questions.length })}</span>
            {currentCategory && currentCategory !== 'Général' && (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{currentCategory}</span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${((current) / session.questions.length) * 100}%` }} />
          </div>
          <p className="text-lg font-medium">{session.questions[current]}</p>
          <textarea className="w-full rounded border p-2" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('answerPlaceholder')} />
          <div className="flex gap-2">
            {speech.supported && (
              <button className="rounded border px-3 py-2" onClick={() => speech.startListening(session.langue === 'en' ? 'en-US' : 'fr-FR', (txt) => setDraft((d) => (d ? d + ' ' : '') + txt))}>
                {speech.listening ? t('listening') : t('speakButton')}
              </button>
            )}
            <button className="rounded bg-primary px-4 py-2 text-white" onClick={nextQuestion} disabled={submit.isPending}>
              {current + 1 < session.questions.length ? t('nextButton') : t('finishButton')}
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div className="max-w-2xl space-y-4">
          <div className="rounded-lg border p-5 space-y-5">
            <h2 className="text-xl font-semibold">{t('feedbackTitle')}</h2>

            <InterviewRestitution feedback={feedback} />

            <button className="rounded border px-3 py-2" onClick={() => { setSession(null); setFeedback(null) }}>{t('restart')}</button>
          </div>
        </div>
      )}

      <div className="max-w-2xl space-y-2">
        <h2 className="text-xl font-semibold">{t('historyTitle')}</h2>
        {attempts.data?.length ? attempts.data.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded border p-2">
            <span>{a.role_key}</span>
            <button className="text-sm text-red-600" onClick={() => removeAttempt.mutate(a.id)}>{t('delete')}</button>
          </div>
        )) : <p className="text-muted-foreground">{t('historyEmpty')}</p>}
      </div>
    </div>
  )
}
