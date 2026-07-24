import { useEffect, useState } from 'react'
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
export function OfferInterviewRunner({ jobId, jobTitle, onBack }: {
  jobId: string
  /** Non consommé directement ici : conservé pour parité d'interface avec la modale appelante (Task 4). */
  jobTitle: string
  onBack: () => void
}) {
  const { t } = useTranslation('interviewSim')
  const { t: tOffers } = useTranslation('monEspace')
  const speech = useSpeech()

  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>([])
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null)
  // Consentement RGPD (art. 7-1) OBLIGATOIRE avant toute génération de
  // questions : tant que sessionId est vide, `start` reste désactivée — voir
  // `enabled` ci-dessous. Réutilisé tel quel par « Recommencer » (le
  // consentement porte sur l'offre/la session, pas sur chaque tentative).
  const [sessionId, setSessionId] = useState<string | null>(null)

  const consentText = useQuery<string>({
    queryKey: ['interview-sim', 'consent-text'],
    queryFn: async () => (await api.get('/interview-sim/consent-text')).data.data.consentText as string,
    refetchOnWindowFocus: false,
  })

  const consent = useMutation({
    mutationFn: async () =>
      (await api.post(`/interview-sim/internal-jobs/${jobId}/consent`, { consentAccepted: true })).data.data as { consentId: string; sessionId: string },
    onSuccess: (data) => setSessionId(data.sessionId),
  })

  const start = useQuery<StartData>({
    queryKey: ['interview-sim', 'internal-job', jobId, sessionId],
    queryFn: async () => (await api.get(`/interview-sim/internal-jobs/${jobId}/start?sessionId=${sessionId}`)).data.data as StartData,
    enabled: !!sessionId,
    refetchOnWindowFocus: false,
  })

  const submit = useMutation({
    mutationFn: async (payload: { langue: string; questions: string[]; categories: string[]; answers: Answer[]; sessionId: string }) =>
      (await api.post(`/interview-sim/internal-jobs/${jobId}/submit`, payload)).data.data as { retour: InterviewFeedback },
    onSuccess: (data) => setFeedback(data.retour),
  })

  const session = start.data
  const currentQuestion = session?.questions[current]

  // Prononce la question courante dès qu'elle apparaît/change (montage + navigation),
  // qu'elle vienne du premier chargement ou d'un passage à la question suivante.
  useEffect(() => {
    if (speech.supported && currentQuestion) speech.speak(currentQuestion, session?.langue === 'en' ? 'en-US' : 'fr-FR')
  }, [currentQuestion, session?.langue, speech.supported, speech.speak])

  // Coupe toute lecture vocale en cours au démontage (fermeture de la modale
  // ou clic « Retour à l'offre », qui démonte ce composant dans le parent).
  useEffect(() => () => { speech.stopSpeaking() }, [speech.stopSpeaking])

  function nextQuestion() {
    if (!session || !sessionId) return
    if (current + 1 < session.questions.length) {
      const item: Answer = { index: current, question: session.questions[current]!, transcript: draft.trim() }
      setAnswers([...answers, item]); setDraft('')
      setCurrent(current + 1)
      return
    }
    // Dernière question : on ne construit/ajoute la réponse finale qu'UNE
    // SEULE FOIS. En cas d'échec d'envoi (submit.isError), un nouveau clic
    // sur « Terminer » ne doit ni perdre la réponse tapée ni la dupliquer :
    // on renvoie simplement le payload déjà construit et mémorisé.
    const finalAnswers = submit.isError ? answers : [...answers, { index: current, question: session.questions[current]!, transcript: draft.trim() }]
    if (!submit.isError) { setAnswers(finalAnswers); setDraft('') }
    submit.mutate({ langue: session.langue, questions: session.questions, categories: session.categories ?? [], answers: finalAnswers, sessionId })
  }

  // Réutilise le sessionId déjà obtenu (le consentement porte sur cette
  // offre/session, pas sur chaque tentative) : pas de second POST /consent.
  function restart() {
    setFeedback(null)
    setAnswers([])
    setDraft('')
    setCurrent(0)
    start.refetch()
  }

  const backBtn = (
    <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> {tOffers('offers.backToOffer')}
    </button>
  )

  // Étape de consentement RGPD — affichée AVANT toute question, tant qu'aucun
  // sessionId n'a été obtenu via POST .../consent. `start` reste désactivée
  // (enabled: !!sessionId) : aucune génération de questions avant acceptation.
  if (!sessionId) {
    return (
      <div className="space-y-4">
        {backBtn}
        {consentText.isLoading && (
          <div className="flex justify-center py-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>
        )}
        {consentText.isError && <p className="text-sm text-red-600">{t('startError')}</p>}
        {consentText.data !== undefined && (
          <div className="space-y-3 rounded-lg border p-4">
            <h3 className="text-lg font-semibold">{t('consentTitle')}</h3>
            <p className="text-sm text-muted-foreground">{consentText.data}</p>
            <button
              className="rounded bg-primary px-4 py-2 text-white disabled:opacity-60"
              onClick={() => consent.mutate()}
              disabled={consent.isPending}
            >
              {t('consentAccept')}
            </button>
            {consent.isError && <p className="text-sm text-red-600">{t('consentError')}</p>}
          </div>
        )}
      </div>
    )
  }

  if (start.isError) {
    return (
      <div className="space-y-4">
        {backBtn}
        <p className="text-sm text-red-600">{t('startError')}</p>
      </div>
    )
  }

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
        <div className="flex items-center justify-between">
          {backBtn}
          <button onClick={restart} className="rounded-lg border border-primary px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5">
            {t('restart')}
          </button>
        </div>
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
      {submit.isError && <p className="text-sm text-red-600">{t('submitError')}</p>}
      {!speech.supported && <p className="text-sm text-amber-600">{t('voiceUnsupported')}</p>}
    </div>
  )
}
