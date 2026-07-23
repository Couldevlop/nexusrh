import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { useSpeech } from '@/hooks/useSpeech'
import { InterviewRestitution, type InterviewFeedback } from '@/components/interview-sim/InterviewRestitution'

interface StartData {
  jobId: string; jobTitle: string; langue: 'fr' | 'en'
  roleKey: string; nbQuestions: number; questions: string[]; categories: string[]
}
type Answer = { index: number; question: string; transcript: string }

/**
 * Déroulé d'entretien calibré sur une OFFRE INTERNE, joué en place dans la fiche
 * offre (MesOffresInternes). Éphémère : rien n'est stocké — la restitution
 * s'affiche puis disparaît à la fermeture. Miroir authentifié du flux public.
 */
export function OfferInterviewRunner({ jobId, jobTitle, onBack }: { jobId: string; jobTitle: string; onBack: () => void }) {
  const { t } = useTranslation('interviewSim')
  const { t: tOffers } = useTranslation('monEspace')
  const speech = useSpeech()

  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>([])
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null)

  const start = useQuery<StartData>({
    queryKey: ['interview-sim', 'internal-job', jobId],
    queryFn: async () => {
      const data = (await api.get(`/interview-sim/internal-jobs/${jobId}/start`)).data.data as StartData
      if (speech.supported && data.questions[0]) speech.speak(data.questions[0], data.langue === 'en' ? 'en-US' : 'fr-FR')
      return data
    },
    refetchOnWindowFocus: false,
  })

  const submit = useMutation({
    mutationFn: async (payload: { langue: string; questions: string[]; categories: string[]; answers: Answer[] }) =>
      (await api.post(`/interview-sim/internal-jobs/${jobId}/submit`, payload)).data.data as { retour: InterviewFeedback },
    onSuccess: (data) => setFeedback(data.retour),
  })

  const session = start.data

  function nextQuestion() {
    if (!session) return
    const item: Answer = { index: current, question: session.questions[current]!, transcript: draft.trim() }
    const nextAnswers = [...answers, item]
    setAnswers(nextAnswers); setDraft('')
    if (current + 1 < session.questions.length) {
      const n = current + 1; setCurrent(n)
      if (speech.supported) speech.speak(session.questions[n]!, session.langue === 'en' ? 'en-US' : 'fr-FR')
    } else {
      submit.mutate({ langue: session.langue, questions: session.questions, categories: session.categories ?? [], answers: nextAnswers })
    }
  }

  const backBtn = (
    <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> {tOffers('offers.backToOffer')}
    </button>
  )

  if (start.isLoading || !session) {
    return (
      <div className="space-y-4">
        {backBtn}
        <div className="flex justify-center py-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>
      </div>
    )
  }

  if (feedback) {
    return (
      <div className="space-y-4">
        {backBtn}
        <h3 className="text-lg font-semibold">{t('feedbackTitle')}</h3>
        <InterviewRestitution feedback={feedback} />
        <p className="text-xs text-muted-foreground">{t('ephemeralNotice')}</p>
      </div>
    )
  }

  const currentCategory = session.categories?.[current]
  return (
    <div className="space-y-4">
      {backBtn}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{t('questionProgress', { current: current + 1, total: session.questions.length })}</span>
        {currentCategory && currentCategory !== 'Général' && (
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{currentCategory}</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(current / session.questions.length) * 100}%` }} />
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
      {!speech.supported && <p className="text-sm text-amber-600">{t('voiceUnsupported')}</p>}
    </div>
  )
}
