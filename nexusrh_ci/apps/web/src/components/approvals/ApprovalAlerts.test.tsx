/**
 * Tests de ApprovalAlerts — bannière + fenêtre de rappel des échéances de validation.
 *
 * Invariants : la bannière apparaît dès qu'une validation est en retard (ou
 * proche de l'échéance) ; rien n'est rendu sans demande urgente ; le rappel
 * « Me le rappeler plus tard » est mémorisé pour la session (report d'1 h).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
// i18n : t() renvoie la clé — les assertions ciblent les clés.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import ApprovalAlerts from './ApprovalAlerts'

const OVERDUE_ITEM = {
  module: 'absences',
  id: 'a1',
  employeeId: 'e1',
  employeeName: 'Awa Koné',
  label: 'Congés payés',
  detail: '2026-11-03 → 2026-11-05 (3 j)',
  submittedAt: '2026-10-20T08:00:00Z',
  workflow: {
    totalSteps: 2, doneSteps: 0, next: { kind: 'manager', level: 1, approverEmployeeId: 'm1' },
    dueAt: '2026-10-21T08:00:00Z', overdue: true, canAct: true, designated: true,
  },
  dueSoon: false,
}

function pending(data: unknown[], summary: Record<string, number>) {
  return Promise.resolve({ data: { data, summary } })
}

function renderAlerts() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApprovalAlerts href="/approvals" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset()
  sessionStorage.clear()
})
afterEach(() => cleanup())

describe('ApprovalAlerts', () => {
  it('affiche la bannière et le rappel quand une validation est en retard', async () => {
    getMock.mockImplementation(() => pending([OVERDUE_ITEM], { actionable: 1, overdue: 1, dueSoon: 0, readOnly: 0 }))
    renderAlerts()
    await waitFor(() => expect(screen.getByTestId('approval-alerts-banner')).toBeTruthy())
    expect(getMock).toHaveBeenCalledWith('/approvals/pending')
    expect(screen.getByText('banner.overdue')).toBeTruthy()
    expect(screen.getByText('banner.view').closest('a')?.getAttribute('href')).toBe('/approvals')
    // Fenêtre de rappel listant la demande en retard
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Awa Koné')).toBeTruthy()
  })

  it('« Me le rappeler plus tard » ferme le rappel et le reporte pour la session', async () => {
    getMock.mockImplementation(() => pending([OVERDUE_ITEM], { actionable: 1, overdue: 1, dueSoon: 0, readOnly: 0 }))
    renderAlerts()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByText('actions.remindLater'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(Number(sessionStorage.getItem('nexusrh:approvals-reminder-snooze'))).toBeGreaterThan(Date.now())
    // La bannière reste affichée tant que la demande n'est pas traitée
    expect(screen.getByTestId('approval-alerts-banner')).toBeTruthy()
  })

  it('n’affiche pas le rappel déjà vu pour le même ensemble de demandes', async () => {
    sessionStorage.setItem('nexusrh:approvals-reminder-seen', 'absences:a1')
    getMock.mockImplementation(() => pending([OVERDUE_ITEM], { actionable: 1, overdue: 1, dueSoon: 0, readOnly: 0 }))
    renderAlerts()
    await waitFor(() => expect(screen.getByTestId('approval-alerts-banner')).toBeTruthy())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ne rend rien sans validation en retard ni proche de l’échéance', async () => {
    getMock.mockImplementation(() => pending([], { actionable: 0, overdue: 0, dueSoon: 0, readOnly: 0 }))
    const { container } = renderAlerts()
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
