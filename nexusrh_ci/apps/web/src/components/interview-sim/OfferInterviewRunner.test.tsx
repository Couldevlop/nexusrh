import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/useSpeech', () => ({
  useSpeech: () => ({ supported: false, listening: false, speak: vi.fn(), startListening: vi.fn() }),
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

beforeEach(() => { getMock.mockReset(); postMock.mockReset() })
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
})
