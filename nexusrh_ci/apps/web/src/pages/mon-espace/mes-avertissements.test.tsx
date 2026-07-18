/**
 * Test minimal du flux self-service « Répondre » à un avertissement de
 * présence (POST /attendance/me/warnings/:id/respond) — Task 20.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import MesAvertissements from './MesAvertissements'

const WARNING_ROW = {
  id: 'w1',
  employee_id: 'e1',
  tier: 'demande_explication',
  trigger_reason: 'Retards répétés',
  occurrence_dates: ['2026-07-01'],
  status: 'active',
  employee_response: null,
  responded_at: null,
  disciplinary_action_id: null,
  created_at: '2026-07-10T08:00:00Z',
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MesAvertissements />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { data: [WARNING_ROW] } })
  postMock.mockReset()
})
afterEach(() => cleanup())

describe('MesAvertissements — répondre à une demande d\'explication', () => {
  it('POST /attendance/me/warnings/:id/respond puis confirmation affichée', async () => {
    postMock.mockResolvedValue({ data: { data: { id: 'w1', employee_response: 'Ma réponse', responded_at: '2026-07-16T00:00:00Z' } } })
    renderPage()

    await waitFor(() => expect(screen.getByText('Retards répétés')).toBeTruthy())
    fireEvent.click(screen.getByText('me.warnings.respond'))

    const textarea = screen.getByPlaceholderText('me.warnings.responsePlaceholder')
    fireEvent.change(textarea, { target: { value: 'Ma réponse' } })
    fireEvent.click(screen.getByText('me.warnings.respondSubmit'))

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/attendance/me/warnings/w1/respond', { response: 'Ma réponse' }),
    )
    await waitFor(() => expect(screen.getByText('me.warnings.respondSuccess')).toBeTruthy())
  })

  it('échec du POST → message d\'erreur affiché', async () => {
    postMock.mockRejectedValue({ response: { data: { error: 'Échec de test.' } } })
    renderPage()

    await waitFor(() => expect(screen.getByText('Retards répétés')).toBeTruthy())
    fireEvent.click(screen.getByText('me.warnings.respond'))
    fireEvent.change(screen.getByPlaceholderText('me.warnings.responsePlaceholder'), { target: { value: 'Ma réponse' } })
    fireEvent.click(screen.getByText('me.warnings.respondSubmit'))

    await waitFor(() => expect(screen.getByText('Échec de test.')).toBeTruthy())
  })
})
