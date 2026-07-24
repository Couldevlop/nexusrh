import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { useSpeech } from '@/hooks/useSpeech'
import { InterviewRestitution, type InterviewFeedback } from '@/components/interview-sim/InterviewRestitution'

interface StartData { jobTitle: string; langue: 'fr' | 'en'; questions: string[]; categories: string[]; consentText: string }
type Feedback = InterviewFeedback

export default function PublicInterviewSimPage() {
  const { token } = useParams<{ token: string }>()
  const { t } = useTranslation('interviewSim')
  const speech = useSpeech()

  const [data, setData] = useState<StartData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [consented, setConsented] = useState(false)
  const [consenting, setConsenting] = useState(false)
  const [consentError, setConsentError] = useState(false)
  // Trace de consentement RGPD (POST .../consent) — le sessionId reçu doit
  // être transmis au submit final ; sans lui le backend renvoie 403.
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<Array<{ index: number; question: string; transcript: string }>>([])
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) return
    api.get(`/public/interview-sim/${token}`)
      .then((r) => setData(r.data.data as StartData))
      .catch(() => setError(t('linkInvalid')))
  }, [token, t])

  // Consentement RGPD OBLIGATOIRE : trace enregistrée AVANT de passer aux
  // questions. Un échec bloque explicitement la suite (pas de démarrage silencieux).
  async function begin() {
    if (!token) return
    setConsenting(true)
    setConsentError(false)
    try {
      const res = await api.post(`/public/interview-sim/${token}/consent`, { consentAccepted: true })
      setSessionId(res.data.data.sessionId as string)
      setConsented(true)
      if (speech.supported && data?.questions[0]) speech.speak(data.questions[0], data.langue === 'en' ? 'en-US' : 'fr-FR')
    } catch {
      setConsentError(true)
    } finally {
      setConsenting(false)
    }
  }

  async function next() {
    if (!data || !sessionId) return
    const item = { index: current, question: data.questions[current]!, transcript: draft.trim() }
    const nextAnswers = [...answers, item]
    setAnswers(nextAnswers); setDraft('')
    if (current + 1 < data.questions.length) {
      const n = current + 1; setCurrent(n)
      if (speech.supported) speech.speak(data.questions[n]!, data.langue === 'en' ? 'en-US' : 'fr-FR')
    } else {
      setSubmitting(true)
      try {
        const res = await api.post(`/public/interview-sim/${token}/submit`, {
          consentAccepted: true, consentAt: new Date().toISOString(), sessionId,
          questions: data.questions, categories: data.categories ?? [], answers: nextAnswers,
        })
        setFeedback(res.data.data.retour as Feedback)
      } catch { setError(t('submitError')) } finally { setSubmitting(false) }
    }
  }

  if (error) return <div className="mx-auto max-w-xl p-6"><p className="text-red-600">{error}</p></div>
  if (!data) return <div className="mx-auto max-w-xl p-6">{t('loading')}</div>

  return (
    <div className="mx-auto max-w-xl p-6 space-y-4">
      <h1 className="text-2xl font-bold">{t('publicTitle', { job: data.jobTitle })}</h1>

      {!consented && !feedback && (
        <div className="rounded-lg border p-4 space-y-3">
          <h2 className="text-lg font-semibold">{t('consentTitle')}</h2>
          <p className="text-sm text-muted-foreground">{data.consentText}</p>
          {!speech.supported && <p className="text-sm text-amber-600">{t('voiceUnsupported')}</p>}
          <button className="rounded bg-primary px-4 py-2 text-white disabled:opacity-60" onClick={begin} disabled={consenting}>
            {t('consentAccept')}
          </button>
          {consentError && <p className="text-sm text-red-600">{t('consentError')}</p>}
        </div>
      )}

      {consented && !feedback && (
        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t('questionProgress', { current: current + 1, total: data.questions.length })}</span>
            {data.categories?.[current] && data.categories[current] !== 'Général' && (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{data.categories[current]}</span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(current / data.questions.length) * 100}%` }} />
          </div>
          <p className="text-lg font-medium">{data.questions[current]}</p>
          <textarea className="w-full rounded border p-2" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('answerPlaceholder')} />
          <div className="flex gap-2">
            {speech.supported && (
              <button className="rounded border px-3 py-2" onClick={() => speech.startListening(data.langue === 'en' ? 'en-US' : 'fr-FR', (txt) => setDraft((d) => (d ? d + ' ' : '') + txt))}>
                {speech.listening ? t('listening') : t('speakButton')}
              </button>
            )}
            <button className="rounded bg-primary px-4 py-2 text-white" onClick={next} disabled={submitting}>
              {current + 1 < data.questions.length ? t('nextButton') : t('finishButton')}
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div className="rounded-lg border p-4 space-y-4">
          <h2 className="text-xl font-semibold">{t('feedbackTitle')}</h2>
          <InterviewRestitution feedback={feedback} />
          <p className="text-xs text-muted-foreground">{t('ephemeralNotice')}</p>
        </div>
      )}
    </div>
  )
}
