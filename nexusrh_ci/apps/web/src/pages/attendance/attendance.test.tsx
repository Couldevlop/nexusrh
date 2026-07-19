/**
 * Tests du composant AttendancePage — onglet Avertissements.
 *
 * Vérifie l'invariant de la Task 19 : la liste des avertissements s'affiche,
 * le bouton « marquer justifié » déclenche bien un PATCH /attendance/warnings/:id,
 * et un échec réseau/serveur affiche TOUJOURS un message à l'écran (jamais un
 * silence) — même pattern que users-tab.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock, putMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: putMock, patch: patchMock, delete: deleteMock },
}))
// i18n : t() renvoie la clé — les assertions ciblent les clés, stables quelle
// que soit la langue.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import AttendancePage from './AttendancePage'

const WARNING_ROW = {
  id: 'w1',
  employee_id: 'e1',
  tier: 'demande_explication',
  trigger_reason: 'Retards répétés',
  occurrence_dates: ['2026-07-01', '2026-07-02'],
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
      <AttendancePage />
    </QueryClientProvider>,
  )
}

function defaultGetImpl(url: string) {
  if (url === '/employees') return Promise.resolve({ data: { data: [] } })
  if (url === '/attendance/dashboard') {
    return Promise.resolve({
      data: { data: { lateDays: 0, absentDays: 0, activeWarnings: 1, pendingExplanations: 1, sanctionDrafts: 0, from: '', to: '' } },
    })
  }
  if (url === '/attendance/warnings') return Promise.resolve({ data: { data: [WARNING_ROW] } })
  return Promise.resolve({ data: { data: [] } })
}

async function goToWarningsTab() {
  await waitFor(() => expect(screen.getByText('tabs.warnings')).toBeTruthy())
  fireEvent.click(screen.getByText('tabs.warnings'))
}

beforeEach(() => {
  getMock.mockReset().mockImplementation(defaultGetImpl)
  postMock.mockReset()
  putMock.mockReset()
  patchMock.mockReset()
  deleteMock.mockReset()
})
afterEach(() => cleanup())

describe('AttendancePage — onglet Avertissements', () => {
  it('affiche la liste des avertissements', async () => {
    renderPage()
    await goToWarningsTab()

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/attendance/warnings'))
    await waitFor(() => expect(screen.getByText('Retards répétés')).toBeTruthy())
  })

  it('« marquer justifié » appelle PATCH /attendance/warnings/:id avec status=explained', async () => {
    patchMock.mockResolvedValue({ data: { data: { id: 'w1', status: 'explained', updated: true } } })
    renderPage()
    await goToWarningsTab()

    await waitFor(() => expect(screen.getByText('Retards répétés')).toBeTruthy())
    fireEvent.click(screen.getByText('warnings.actions.explain'))

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/attendance/warnings/w1', { status: 'explained' }),
    )
  })

  it('échec du PATCH → message d\'erreur affiché, jamais un silence', async () => {
    patchMock.mockRejectedValue({
      response: { data: { error: "Échec de la mise à jour de l'avertissement (test)." } },
    })
    renderPage()
    await goToWarningsTab()

    await waitFor(() => expect(screen.getByText('Retards répétés')).toBeTruthy())
    fireEvent.click(screen.getByText('warnings.actions.explain'))

    await waitFor(() =>
      expect(screen.getByText("Échec de la mise à jour de l'avertissement (test).")).toBeTruthy(),
    )
  })
})
