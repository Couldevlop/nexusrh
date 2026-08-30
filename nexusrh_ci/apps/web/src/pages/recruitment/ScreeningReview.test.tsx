/**
 * Écran de revue du pré-tri.
 *
 * La propriété centrale : une décision qui CONTREDIT le verdict machine exige un
 * motif, et aucun appel API ne part tant qu'il manque. C'est la contrepartie
 * concrète de la souplesse offerte au recruteur — il peut repêcher un dossier
 * signalé, mais la raison est conservée dans la piste d'audit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import ScreeningReview from './ScreeningReview'

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(), postMock: vi.fn(), patchMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock },
  formatFCFA: (n: number) => String(n),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const FLAGGED = {
  id: 'a1', first_name: 'Awa', last_name: 'Koné', email: 'awa@example.ci',
  screening_verdict: 'flagged' as const,
  screening_failed_rules: ['Années d’expérience — minimum requis : 5 (déclaré : 2)'],
  screening_answers: { q1: 2 },
  ai_score: 71, ai_summary: null, has_cv: true, created_at: '2026-08-30T10:00:00Z',
}
const QUESTIONS = [{
  id: 'q1', label: 'Années d’expérience', type: 'number' as const, required: true,
}]

const wrap = (ui: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>,
)

// Le projet n'a pas de setup global de Testing Library : sans ce nettoyage, les
// rendus s'empilent d'un test à l'autre et les requêtes trouvent des doublons.
afterEach(() => { cleanup() })

beforeEach(() => {
  vi.clearAllMocks()
  getMock.mockResolvedValue({ data: { data: { items: [FLAGGED], questions: QUESTIONS } } })
  postMock.mockResolvedValue({ data: { data: {
    total: 1, pass: 0, flagged: 1, pending: 1,
    byRule: [{ rule: 'Critère agrégé côté volet gauche', count: 1 }],
  } } })
  patchMock.mockResolvedValue({ data: { data: { id: 'a1' } } })
})

describe('ScreeningReview', () => {
  it('affiche les critères non remplis du dossier', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    expect(await screen.findByText(/minimum requis : 5/)).toBeTruthy()
  })

  it('affiche les réponses du candidat en regard des libellés', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    expect(await screen.findByText('Années d’expérience')).toBeTruthy()
    // La réponse du candidat est affichée en regard du libellé.
    const dd = screen.getAllByText('2')
    expect(dd.length).toBeGreaterThan(0)
  })

  it('recalcule les compteurs sans écrire (appel à preview)', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(postMock.mock.calls[0]![0]).toContain('/screening/preview')
  })

  it('exige un motif quand la décision contredit le verdict machine', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    // Le dossier est `flagged` : le retenir est une dérogation.
    fireEvent.click(await screen.findByRole('button', { name: /screening.keep/ }))

    // Aucun appel tant que le motif manque.
    expect(patchMock).not.toHaveBeenCalled()
    expect(await screen.findByLabelText(/screening.reason/)).toBeTruthy()
  })

  it('envoie la décision une fois le motif saisi', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /screening.keep/ }))

    const field = await screen.findByLabelText(/screening.reason/)
    fireEvent.change(field, { target: { value: 'Parcours remarquable malgré 4 ans' } })
    fireEvent.click(screen.getByRole('button', { name: /screening.keep/ }))

    await waitFor(() => expect(patchMock).toHaveBeenCalled())
    expect(patchMock.mock.calls[0]![1]).toMatchObject({
      decision: 'kept', reason: 'Parcours remarquable malgré 4 ans',
    })
  })

  it('n’exige aucun motif quand la décision SUIT le verdict', async () => {
    getMock.mockResolvedValue({ data: { data: {
      items: [{ ...FLAGGED, screening_verdict: 'pass', screening_failed_rules: [] }],
      questions: QUESTIONS,
    } } })
    wrap(<ScreeningReview jobId="job-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /screening.keep/ }))
    await waitFor(() => expect(patchMock).toHaveBeenCalled())
  })

  it('affiche l’avertissement sur les critères discriminatoires', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    expect(await screen.findByText('screening.discriminationWarning')).toBeTruthy()
  })

  it('annonce une file vide sans erreur', async () => {
    getMock.mockResolvedValue({ data: { data: { items: [], questions: [] } } })
    wrap(<ScreeningReview jobId="job-1" />)
    expect(await screen.findByText('screening.empty')).toBeTruthy()
  })
})
