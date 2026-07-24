import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
const stopSpeakingMock = vi.fn()
vi.mock('@/hooks/useSpeech', () => ({
  useSpeech: () => ({ supported: false, listening: false, speak: vi.fn(), startListening: vi.fn(), stopSpeaking: stopSpeakingMock }),
}))

import { OfferInterviewRunner } from './OfferInterviewRunner'

const CONSENT_TEXT = 'Texte de consentement du tenant.'
const SESSION_ID = 'sess-1'
const START_URL = `/interview-sim/internal-jobs/job-1/start?sessionId=${SESSION_ID}`

function renderRunner(onBack = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OfferInterviewRunner jobId="job-1" jobTitle="Développeur" onBack={onBack} />
    </QueryClientProvider>,
  )
}

/** Consentement (GET texte + POST accepté) + start OK — configuration standard. */
function mockConsentThenStart(questions: string[] = ['Q1'], categories: string[] = ['Java']) {
  getMock.mockImplementation((url: string) => {
    if (url === '/interview-sim/consent-text') return Promise.resolve({ data: { data: { consentText: CONSENT_TEXT } } })
    if (url === START_URL) {
      return Promise.resolve({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: questions.length, questions, categories } } })
    }
    return Promise.resolve({ data: { data: {} } })
  })
  postMock.mockImplementation((url: string) => {
    if (url === '/interview-sim/internal-jobs/job-1/consent') return Promise.resolve({ data: { data: { consentId: 'c-1', sessionId: SESSION_ID } } })
    return Promise.resolve({ data: { data: {} } })
  })
}

async function acceptConsent() {
  await screen.findByText(CONSENT_TEXT)
  fireEvent.click(screen.getByText('consentAccept'))
}

beforeEach(() => { getMock.mockReset(); postMock.mockReset(); stopSpeakingMock.mockReset() })
afterEach(() => cleanup())

describe('OfferInterviewRunner — consentement RGPD', () => {
  it('affiche le consentement au montage et n’appelle PAS start avant acceptation', async () => {
    mockConsentThenStart()
    renderRunner()
    await screen.findByText(CONSENT_TEXT)
    expect(getMock).toHaveBeenCalledWith('/interview-sim/consent-text')
    expect(getMock).not.toHaveBeenCalledWith(START_URL)
    expect(screen.queryByText('Q1')).toBeNull()
  })

  it('à l’acceptation : POST consent PUIS GET start avec le sessionId reçu', async () => {
    mockConsentThenStart()
    renderRunner()
    await acceptConsent()
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/consent', { consentAccepted: true }))
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(START_URL))
    expect(await screen.findByText('Q1')).toBeTruthy()
    // Ordre : consent avant start.
    const consentCallOrder = postMock.mock.invocationCallOrder[0]!
    const startCallIndex = getMock.mock.calls.findIndex((c) => c[0] === START_URL)
    const startCallOrder = getMock.mock.invocationCallOrder[startCallIndex]!
    expect(consentCallOrder).toBeLessThan(startCallOrder)
  })

  it('un échec d’enregistrement du consentement affiche une erreur et NE démarre PAS', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/interview-sim/consent-text') return Promise.resolve({ data: { data: { consentText: CONSENT_TEXT } } })
      return Promise.resolve({ data: { data: {} } })
    })
    postMock.mockRejectedValue(new Error('500'))
    renderRunner()
    await acceptConsent()
    expect(await screen.findByText('consentError')).toBeTruthy()
    expect(getMock).not.toHaveBeenCalledWith(START_URL)
    expect(screen.queryByText('Q1')).toBeNull()
  })

  it('le bouton retour (étape consentement) appelle onBack', async () => {
    const onBack = vi.fn()
    mockConsentThenStart()
    renderRunner(onBack)
    await screen.findByText(CONSENT_TEXT)
    fireEvent.click(screen.getByText('offers.backToOffer'))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('OfferInterviewRunner', () => {
  it('charge les questions de l’offre après consentement (start)', async () => {
    mockConsentThenStart()
    renderRunner()
    await acceptConsent()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(START_URL))
    expect(await screen.findByText('Q1')).toBeTruthy()
  })

  it('soumet à la fin avec le sessionId et affiche la restitution', async () => {
    mockConsentThenStart()
    postMock.mockImplementation((url: string) => {
      if (url === '/interview-sim/internal-jobs/job-1/consent') return Promise.resolve({ data: { data: { consentId: 'c-1', sessionId: SESSION_ID } } })
      if (url === '/interview-sim/internal-jobs/job-1/submit') {
        return Promise.resolve({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: ['ok'], axesProgres: [], reponsesReperes: [] } } } })
      }
      return Promise.resolve({ data: { data: {} } })
    })
    renderRunner()
    await acceptConsent()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/submit', expect.objectContaining({ langue: 'fr', questions: ['Q1'], sessionId: SESSION_ID })))
    expect(await screen.findByText('feedbackTitle')).toBeTruthy()
  })

  it('le bouton retour (pendant l’entretien) appelle onBack', async () => {
    const onBack = vi.fn()
    mockConsentThenStart()
    renderRunner(onBack)
    await acceptConsent()
    await screen.findByText('Q1')
    fireEvent.click(screen.getByText('offers.backToOffer'))
    expect(onBack).toHaveBeenCalled()
  })

  it('affiche une erreur (et pas un spinner infini) si le start échoue après consentement', async () => {
    const onBack = vi.fn()
    getMock.mockImplementation((url: string) => {
      if (url === '/interview-sim/consent-text') return Promise.resolve({ data: { data: { consentText: CONSENT_TEXT } } })
      if (url === START_URL) return Promise.reject(new Error('404'))
      return Promise.resolve({ data: { data: {} } })
    })
    postMock.mockImplementation((url: string) => {
      if (url === '/interview-sim/internal-jobs/job-1/consent') return Promise.resolve({ data: { data: { consentId: 'c-1', sessionId: SESSION_ID } } })
      return Promise.resolve({ data: { data: {} } })
    })
    renderRunner(onBack)
    await acceptConsent()
    expect(await screen.findByText('startError')).toBeTruthy()
    expect(screen.queryByText('answerPlaceholder')).toBeNull()
    fireEvent.click(screen.getByText('offers.backToOffer'))
    expect(onBack).toHaveBeenCalled()
  })

  it('coupe la synthèse vocale au démontage (fermeture / retour)', async () => {
    mockConsentThenStart()
    const { unmount } = renderRunner()
    await acceptConsent()
    await screen.findByText('Q1')
    expect(stopSpeakingMock).not.toHaveBeenCalled()
    unmount()
    expect(stopSpeakingMock).toHaveBeenCalled()
  })

  it('un échec d’envoi n’est pas perdu : la relance renvoie EXACTEMENT une réponse par question (pas de doublon)', async () => {
    mockConsentThenStart()
    let submitCalls = 0
    postMock.mockImplementation((url: string) => {
      if (url === '/interview-sim/internal-jobs/job-1/consent') return Promise.resolve({ data: { data: { consentId: 'c-1', sessionId: SESSION_ID } } })
      if (url === '/interview-sim/internal-jobs/job-1/submit') {
        submitCalls += 1
        if (submitCalls === 1) return Promise.reject(new Error('500'))
        return Promise.resolve({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: [], axesProgres: [], reponsesReperes: [] } } } })
      }
      return Promise.resolve({ data: { data: {} } })
    })
    renderRunner()
    await acceptConsent()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(submitCalls).toBe(1))
    await screen.findByText('submitError')
    // Retry : re-clique « Terminer » sans re-taper — le payload ne doit PAS dupliquer la réponse.
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(submitCalls).toBe(2))
    const submitCall = postMock.mock.calls.filter((c) => c[0] === '/interview-sim/internal-jobs/job-1/submit')[1]!
    const lastPayload = submitCall[1] as { answers: Array<{ index: number }>; sessionId: string }
    expect(lastPayload.answers).toHaveLength(1)
    expect(lastPayload.answers[0]!.index).toBe(0)
    expect(lastPayload.sessionId).toBe(SESSION_ID)
    expect(await screen.findByText('feedbackTitle')).toBeTruthy()
  })

  it('« Recommencer » depuis la restitution réutilise le MÊME sessionId (pas de second consentement)', async () => {
    mockConsentThenStart()
    postMock.mockImplementation((url: string) => {
      if (url === '/interview-sim/internal-jobs/job-1/consent') return Promise.resolve({ data: { data: { consentId: 'c-1', sessionId: SESSION_ID } } })
      if (url === '/interview-sim/internal-jobs/job-1/submit') {
        return Promise.resolve({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: ['ok'], axesProgres: [], reponsesReperes: [] } } } })
      }
      return Promise.resolve({ data: { data: {} } })
    })
    renderRunner()
    await acceptConsent()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await screen.findByText('feedbackTitle')
    const startCallsBefore = getMock.mock.calls.filter((c) => c[0] === START_URL).length
    expect(startCallsBefore).toBe(1)
    const consentCallsBefore = postMock.mock.calls.filter((c) => c[0] === '/interview-sim/internal-jobs/job-1/consent').length
    expect(consentCallsBefore).toBe(1)
    fireEvent.click(screen.getByText('restart'))
    await waitFor(() => expect(getMock.mock.calls.filter((c) => c[0] === START_URL).length).toBe(2))
    // Pas de second appel consent : le sessionId est réutilisé.
    expect(postMock.mock.calls.filter((c) => c[0] === '/interview-sim/internal-jobs/job-1/consent').length).toBe(1)
    expect(await screen.findByText('Q1')).toBeTruthy()
    expect(screen.queryByText('feedbackTitle')).toBeNull()
  })
})
