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

function renderRunner(onBack = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OfferInterviewRunner jobId="job-1" jobTitle="Développeur" onBack={onBack} />
    </QueryClientProvider>,
  )
}

beforeEach(() => { getMock.mockReset(); postMock.mockReset(); stopSpeakingMock.mockReset() })
afterEach(() => cleanup())

describe('OfferInterviewRunner', () => {
  it('charge les questions de l’offre au montage (start)', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    renderRunner()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/start'))
    expect(await screen.findByText('Q1')).toBeTruthy()
  })

  it('soumet à la fin et affiche la restitution', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    postMock.mockResolvedValue({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: ['ok'], axesProgres: [], reponsesReperes: [] } } } })
    renderRunner()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/submit', expect.objectContaining({ langue: 'fr', questions: ['Q1'] })))
    expect(await screen.findByText('feedbackTitle')).toBeTruthy()
  })

  it('le bouton retour appelle onBack', async () => {
    const onBack = vi.fn()
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    renderRunner(onBack)
    fireEvent.click(await screen.findByText('offers.backToOffer'))
    expect(onBack).toHaveBeenCalled()
  })

  it('affiche une erreur (et pas un spinner infini) si le start échoue', async () => {
    const onBack = vi.fn()
    getMock.mockRejectedValue(new Error('404'))
    renderRunner(onBack)
    expect(await screen.findByText('startError')).toBeTruthy()
    expect(screen.queryByText('answerPlaceholder')).toBeNull()
    fireEvent.click(screen.getByText('offers.backToOffer'))
    expect(onBack).toHaveBeenCalled()
  })

  it('coupe la synthèse vocale au démontage (fermeture / retour)', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    const { unmount } = renderRunner()
    await screen.findByText('Q1')
    expect(stopSpeakingMock).not.toHaveBeenCalled()
    unmount()
    expect(stopSpeakingMock).toHaveBeenCalled()
  })

  it('un échec d’envoi n’est pas perdu : la relance renvoie EXACTEMENT une réponse par question (pas de doublon)', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    postMock.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: [], axesProgres: [], reponsesReperes: [] } } } })
    renderRunner()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1))
    await screen.findByText('submitError')
    // Retry : re-clique « Terminer » sans re-taper — le payload ne doit PAS dupliquer la réponse.
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2))
    const lastPayload = postMock.mock.calls[1]![1] as { answers: Array<{ index: number }> }
    expect(lastPayload.answers).toHaveLength(1)
    expect(lastPayload.answers[0]!.index).toBe(0)
    expect(await screen.findByText('feedbackTitle')).toBeTruthy()
  })

  it('« Recommencer » depuis la restitution réinitialise et relance le questionnaire', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    postMock.mockResolvedValue({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: ['ok'], axesProgres: [], reponsesReperes: [] } } } })
    renderRunner()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await screen.findByText('feedbackTitle')
    expect(getMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('restart'))
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Q1')).toBeTruthy()
    expect(screen.queryByText('feedbackTitle')).toBeNull()
  })
})
