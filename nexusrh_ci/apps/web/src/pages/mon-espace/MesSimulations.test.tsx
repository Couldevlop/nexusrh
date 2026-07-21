/**
 * Test minimal de la page self-service « Mes simulations » (entraînement aux
 * entretiens) — Task 9. Vérifie le rendu de l'historique via
 * GET /interview-sim/my-attempts (aucune donnée vocale ne sort du navigateur ;
 * seul le rendu HTTP est testé ici, useSpeech est testé isolément).
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(), postMock: vi.fn(), deleteMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock, delete: deleteMock } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import MesSimulations from './MesSimulations'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MesSimulations /></QueryClientProvider>)
}

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset(); deleteMock.mockReset()
  getMock.mockImplementation((url: string) => {
    if (url === '/interview-sim/my-attempts') return Promise.resolve({ data: { data: [{ id: 'a1', role_key: 'comptable', langue: 'fr', created_at: '2026-07-20T10:00:00Z' }] } })
    return Promise.resolve({ data: { data: [] } })
  })
})
afterEach(() => cleanup())

describe('MesSimulations', () => {
  it('affiche l’historique « Mes simulations »', async () => {
    renderPage()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/interview-sim/my-attempts'))
    expect(await screen.findByText('comptable')).toBeTruthy()
  })

  it('supprime une simulation de l’historique', async () => {
    deleteMock.mockResolvedValue({ data: { data: { deleted: true } } })
    renderPage()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/interview-sim/my-attempts'))
    const deleteButton = await screen.findByText('delete')
    deleteButton.click()
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/interview-sim/my-attempts/a1'))
  })
})
