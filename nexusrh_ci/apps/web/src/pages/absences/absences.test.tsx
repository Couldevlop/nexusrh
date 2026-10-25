/**
 * Tests de AbsencesPage — file RH/manager des absences (circuit N+1 … → RH).
 *
 * Invariants : les boutons Approuver/Refuser n'apparaissent qu'à l'étape de
 * l'utilisateur (workflow.canAct, calculé par l'API) ; une erreur de décision
 * est affichée (jamais un silence) ; la saisie pour un collaborateur poste bien
 * son employeeId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: patchMock, delete: vi.fn() },
  formatDate: (d: string) => d,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: 'hr_manager' } }),
}))

import AbsencesPage from './AbsencesPage'

const WORKFLOW = {
  totalSteps: 2, doneSteps: 1, next: { kind: 'hr' }, dueAt: '2099-01-01T08:00:00Z',
  overdue: false, designated: true,
}
const row = (id: string, name: string, canAct: boolean) => ({
  id, employee_id: `e-${id}`, first_name: name, last_name: 'Test',
  type_label: 'Congés payés', type_color: '#f97316',
  start_date: '2026-11-03', end_date: '2026-11-05', days: 3,
  half_day: false, reason: null, status: 'submitted', validation_level: 1,
  created_at: '2026-10-20T08:00:00Z',
  workflow: { ...WORKFLOW, canAct },
})

function defaultGetImpl(url: string) {
  if (url.startsWith('/absences?status=')) {
    return Promise.resolve({ data: { data: [row('a1', 'Actionnable', true), row('a2', 'Bloquee', false)] } })
  }
  if (url.startsWith('/employees')) {
    return Promise.resolve({ data: { data: [
      { id: 'e2', first_name: 'Zoé', last_name: 'Yao' },
      { id: 'e1', first_name: 'Awa', last_name: 'Koné' },
    ] } })
  }
  if (url === '/absences/types') {
    return Promise.resolve({ data: { data: [{ id: 't1', label: 'Congés payés', code: 'CP', color: '#f97316' }] } })
  }
  return Promise.resolve({ data: { data: [] } })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AbsencesPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset().mockImplementation(defaultGetImpl)
  postMock.mockReset()
  patchMock.mockReset()
})
afterEach(() => cleanup())

describe('AbsencesPage — circuit de validation', () => {
  it('n’affiche les actions que pour les demandes à l’étape de l’utilisateur', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/Actionnable/)).toBeTruthy())
    expect(screen.getByText(/Bloquee/)).toBeTruthy()
    expect(screen.getAllByText('actions.approve')).toHaveLength(1)
    expect(screen.getAllByText('actions.reject')).toHaveLength(1)
    expect(screen.getByText('waitingOther')).toBeTruthy()
    // Colonne « Étape » : validation RH
    expect(screen.getAllByText('step.hr')).toHaveLength(2)
  })

  it('affiche l’erreur de l’API quand l’approbation est refusée', async () => {
    patchMock.mockRejectedValue({ response: { status: 403, data: { error: 'Ce n’est pas votre étape' } } })
    renderPage()
    await waitFor(() => expect(screen.getByText('actions.approve')).toBeTruthy())
    fireEvent.click(screen.getByText('actions.approve'))
    await waitFor(() => expect(screen.getByText('Ce n’est pas votre étape')).toBeTruthy())
    expect(patchMock).toHaveBeenCalledWith('/absences/a1/approve')
  })

  it('affiche le message d’étape renvoyé par l’API après approbation', async () => {
    patchMock.mockResolvedValue({ data: { message: 'Étape 1/2 validée — suite : validation RH', fullyApproved: false } })
    renderPage()
    await waitFor(() => expect(screen.getByText('actions.approve')).toBeTruthy())
    fireEvent.click(screen.getByText('actions.approve'))
    await waitFor(() => expect(screen.getByText('Étape 1/2 validée — suite : validation RH')).toBeTruthy())
  })

  it('la saisie pour un collaborateur poste son employeeId', async () => {
    postMock.mockResolvedValue({ data: { data: { id: 'new' } } })
    renderPage()
    fireEvent.click(await screen.findByText('entry.open'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Yao Zoé' })).toBeTruthy())
    // Liste triée par nom
    const options = screen.getAllByRole('option').map(o => o.textContent)
    expect(options.indexOf('Koné Awa')).toBeLessThan(options.indexOf('Yao Zoé'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Congés payés' })).toBeTruthy())

    fireEvent.change(screen.getByLabelText('entry.employee'), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText('entry.type'), { target: { value: 't1' } })
    fireEvent.change(screen.getByLabelText('entry.startDate'), { target: { value: '2026-12-01' } })
    fireEvent.change(screen.getByLabelText('entry.endDate'), { target: { value: '2026-12-03' } })
    fireEvent.click(screen.getByText('entry.submit'))

    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(postMock).toHaveBeenCalledWith('/absences', expect.objectContaining({
      employeeId: 'e2', absenceTypeId: 't1', startDate: '2026-12-01', endDate: '2026-12-03', halfDay: false,
    }))
    await waitFor(() => expect(screen.getByText('entry.created')).toBeTruthy())
  })

  it('affiche l’erreur de prévenance renvoyée par l’API (422)', async () => {
    postMock.mockRejectedValue({ response: { status: 422, data: { error: 'Délai de prévenance insuffisant', code: 'NOTICE_TOO_SHORT' } } })
    renderPage()
    fireEvent.click(await screen.findByText('entry.open'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Yao Zoé' })).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('option', { name: 'Congés payés' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('entry.employee'), { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText('entry.type'), { target: { value: 't1' } })
    fireEvent.change(screen.getByLabelText('entry.startDate'), { target: { value: '2026-10-27' } })
    fireEvent.change(screen.getByLabelText('entry.endDate'), { target: { value: '2026-10-29' } })
    fireEvent.click(screen.getByText('entry.submit'))
    await waitFor(() => expect(screen.getByText('Délai de prévenance insuffisant')).toBeTruthy())
  })
})
