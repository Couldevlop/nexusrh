import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useSpeech } from '@/hooks/useSpeech'

interface AttemptRow { id: string; role_key: string; langue: string; created_at: string }
interface StartData {
  poste: { title: string; secteur: string | null; langue: 'fr' | 'en' }
  roleKey: string; langue: 'fr' | 'en'; nbQuestions: number
  questions: string[]; categories: string[]
}
interface CategoryScore { category: string; score: number; commentaire: string }
interface Feedback {
  disponible: boolean; message: string | null
  scoreGlobal: number | null
  scoresParCategorie: CategoryScore[]
  pointsForts: string[]; axesProgres: string[]
  reponsesReperes: Array<{ index: number; question: string; reponseRepere: string }>
}

/** Bande de couleur du score : rouge < 50, ambre < 75, vert ≥ 75. */
function scoreTone(score: number): { text: string; bar: string; ring: string } {
  if (score >= 75) return { text: 'text-emerald-600', bar: 'bg-emerald-500', ring: '#10b981' }
  if (score >= 50) return { text: 'text-amber-600', bar: 'bg-amber-500', ring: '#f59e0b' }
  return { text: 'text-red-600', bar: 'bg-red-500', ring: '#ef4444' }
}

/** Jauge circulaire du score global (0-100). SVG pur, sans dépendance. */
function ScoreGauge({ score, label }: { score: number; label: string }) {
  const r = 52
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const tone = scoreTone(pct)
  return (
    <div className="flex flex-col items-center">
      <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label={`${label} ${pct}/100`}>
        <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/30" />
        <circle
          cx="64" cy="64" r={r} fill="none" stroke={tone.ring} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100}
          transform="rotate(-90 64 64)" style={{ transition: 'stroke-dashoffset 700ms ease' }}
        />
        <text x="64" y="60" textAnchor="middle" className={`fill-current ${tone.text}`} style={{ fontSize: 30, fontWeight: 700 }}>{pct}</text>
        <text x="64" y="82" textAnchor="middle" className="fill-current text-muted-foreground" style={{ fontSize: 11 }}>/ 100</text>
      </svg>
      <span className="mt-1 text-sm font-medium text-muted-foreground">{label}</span>
    </div>
  )
}

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

            {!feedback.disponible && <p className="text-amber-600">{feedback.message}</p>}

            {feedback.disponible && (
              <>
                {/* Score global — héros de la restitution */}
                {feedback.scoreGlobal !== null && (
                  <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
                    <ScoreGauge score={feedback.scoreGlobal} label={t('globalScore')} />
                    {feedback.scoresParCategorie.length > 0 && (
                      <div className="flex-1 space-y-3 self-stretch">
                        <h3 className="text-sm font-semibold text-muted-foreground">{t('byCategory')}</h3>
                        {feedback.scoresParCategorie.map((s, i) => {
                          const tone = scoreTone(s.score)
                          return (
                            <div key={i} className="space-y-1">
                              <div className="flex items-center justify-between text-sm">
                                <span className="font-medium">{s.category}</span>
                                <span className={`font-semibold ${tone.text}`}>{s.score}</span>
                              </div>
                              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                                <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(0, Math.min(100, s.score))}%`, transition: 'width 700ms ease' }} />
                              </div>
                              {s.commentaire && <p className="text-xs text-muted-foreground">{s.commentaire}</p>}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Forces / Axes de progrès */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
                    <h3 className="mb-2 font-medium text-emerald-700">{t('strengths')}</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm">{feedback.pointsForts.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
                    <h3 className="mb-2 font-medium text-amber-700">{t('improvements')}</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm">{feedback.axesProgres.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                </div>

                {/* Réponses repères (dépliable) */}
                {feedback.reponsesReperes.length > 0 && (
                  <details className="rounded-lg border p-4">
                    <summary className="cursor-pointer font-medium">{t('modelAnswers')}</summary>
                    <div className="mt-3 space-y-3">
                      {feedback.reponsesReperes.map((r, i) => (
                        <div key={i} className="text-sm">
                          <p className="font-medium">{r.question}</p>
                          <p className="text-muted-foreground">{r.reponseRepere}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}

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
