import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import PublicInterviewSimPage from './PublicInterviewSimPage'

const SESSION_ID = 'sess-pub-1'

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/entrainement-entretien/${token}`]}>
      <Routes><Route path="/entrainement-entretien/:token" element={<PublicInterviewSimPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset()
  getMock.mockResolvedValue({ data: { data: { jobTitle: 'Comptable', langue: 'fr', questions: ['Q1', 'Q2'], consentText: 'Je consens.' } } })
  postMock.mockResolvedValue({ data: { data: { consentId: 'c-pub-1', sessionId: SESSION_ID } } })
  // Web Speech API absente dans jsdom → repli saisie texte
  ;(window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = undefined
  ;(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = undefined
})
afterEach(() => cleanup())

describe('PublicInterviewSimPage', () => {
  it('affiche le consentement puis, sans reconnaissance vocale, le repli saisie texte', async () => {
    renderAt('tok-123')
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/public/interview-sim/tok-123'))
    expect(await screen.findByText('Je consens.')).toBeTruthy()
    // Aucun POST consent avant acceptation.
    expect(postMock).not.toHaveBeenCalled()
    // Acceptation du consentement → POST /consent puis passage à la première question
    fireEvent.click(screen.getByText('consentAccept'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/public/interview-sim/tok-123/consent', { consentAccepted: true }))
    // Le champ de repli texte est présent (voix non supportée)
    expect(await screen.findByPlaceholderText('answerPlaceholder')).toBeTruthy()
  })

  it('un échec d’enregistrement du consentement affiche une erreur et ne démarre pas les questions', async () => {
    postMock.mockRejectedValue(new Error('500'))
    renderAt('tok-123')
    expect(await screen.findByText('Je consens.')).toBeTruthy()
    fireEvent.click(screen.getByText('consentAccept'))
    expect(await screen.findByText('consentError')).toBeTruthy()
    expect(screen.queryByPlaceholderText('answerPlaceholder')).toBeNull()
  })

  it('transmet le sessionId reçu au submit final', async () => {
    renderAt('tok-123')
    await screen.findByText('Je consens.')
    fireEvent.click(screen.getByText('consentAccept'))
    await screen.findByPlaceholderText('answerPlaceholder')

    postMock.mockResolvedValueOnce({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 70, scoresParCategorie: [], pointsForts: [], axesProgres: [], reponsesReperes: [] } } } })
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'réponse 1' } })
    fireEvent.click(screen.getByText('nextButton'))
    await screen.findByText('questionProgress')

    postMock.mockResolvedValueOnce({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 70, scoresParCategorie: [], pointsForts: [], axesProgres: [], reponsesReperes: [] } } } })
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'réponse 2' } })
    fireEvent.click(screen.getByText('finishButton'))

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/public/interview-sim/tok-123/submit', expect.objectContaining({ sessionId: SESSION_ID })))
    expect(await screen.findByText('feedbackTitle')).toBeTruthy()
  })
})
