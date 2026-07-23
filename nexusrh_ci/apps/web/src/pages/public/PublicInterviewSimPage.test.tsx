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
    // Acceptation du consentement → passage à la première question
    fireEvent.click(screen.getByText('consentAccept'))
    // Le champ de repli texte est présent (voix non supportée)
    expect(await screen.findByPlaceholderText('answerPlaceholder')).toBeTruthy()
  })
})
