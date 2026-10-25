/**
 * Circuit de validation nominatif de la paie — écran Paie.
 *
 * Recette paie oct. 2026 : la période « En validation » doit nommer son
 * valideur attendu (historique + modale), et pouvoir être renvoyée en
 * préparation (valideur, commentaire obligatoire) ou annulée (initiateur,
 * avant toute validation). Les droits viennent de l'API (`viewer`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, postMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  authState: { user: { sub: 'u-paie', role: 'hr_officer' }, tenantConfig: { hasSubsidiaries: false } },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatMonth: (m: string) => m,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import PayrollPage from './PayrollPage'

const PENDING_WITH = {
  level: 1, requiredLevels: 2, userId: 'u-paie', name: 'Yao Brou', functionLabel: 'Chef de service paie',
  role: 'hr_officer', dueAt: '2026-10-27T10:00:00.000Z', overdue: false, teamCanAct: false,
}

function workflowState(viewer: Record<string, unknown>) {
  return {
    period: { id: 'p1', month: '2026-10', status: 'pending_validation', initiatedBy: 'u-init', initiatedAt: '2026-10-25T10:00:00Z', initiatorName: 'Awa Koné' },
    requiredLevels: 2, currentLevel: 0, isComplete: false, approvals: [],
    levels: [
      { level: 1, status: 'current', validator: { userId: 'u-paie', name: 'Yao Brou', role: 'hr_officer', available: true }, functionLabel: 'Chef de service paie', slaDays: 2, dueAt: PENDING_WITH.dueAt, overdue: false, teamCanAct: false, approval: null },
      { level: 2, status: 'upcoming', validator: { userId: 'u-drh', name: 'Fanta Traoré', role: 'hr_manager', available: true }, functionLabel: 'DRH', slaDays: 2, dueAt: null, overdue: false, teamCanAct: false, approval: null },
    ],
    pendingWith: PENDING_WITH,
    viewer: { canApprove: false, canReject: false, canCancel: false, escalated: false, deniedReason: null, deniedMessage: null, ...viewer },
  }
}

function setup(viewer: Record<string, unknown>, user = { sub: 'u-paie', role: 'hr_officer' }) {
  authState.user = user
  getMock.mockImplementation((url: string) => {
    if (url === '/payroll/periods') {
      return Promise.resolve({ data: { data: [{
        id: 'p1', month: '2026-10', status: 'pending_validation', total_gross: '0', total_net: '0', total_cnps: '0', total_its: '0',
        employees_count: '2', closed_at: null, initiated_at: '2026-10-25T10:00:00Z', initiated_by: 'u-init', rejection_reason: null,
        pending_with: PENDING_WITH,
      }] } })
    }
    if (url.endsWith('/workflow')) return Promise.resolve({ data: workflowState(viewer) })
    return Promise.resolve({ data: { data: [] } })
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/payroll?validate=2026-10']}>
        <PayrollPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset()
  postMock.mockReset().mockResolvedValue({ data: { data: { status: 'open' } } })
})
afterEach(() => cleanup())

describe('PayrollPage — circuit de validation nominatif', () => {
  it('historique : la période en validation nomme son valideur attendu', async () => {
    setup({ canApprove: true, canReject: true })
    expect(await screen.findByText(/history\.pendingWith.*Yao Brou.*Chef de service paie/)).toBeTruthy()
  })

  it('?validate=AAAA-MM ouvre la modale : valideur attendu, fonction, échéance des niveaux', async () => {
    setup({ canApprove: true, canReject: true })
    expect(await screen.findByText(/workflow\.expectedValidator.*Yao Brou/)).toBeTruthy()
    expect(screen.getByText(/workflow\.levelDesignated.*DRH.*Fanta Traoré/)).toBeTruthy()
    expect(screen.getByText(/workflow\.dueAt/)).toBeTruthy()
  })

  it('valideur : renvoi en préparation avec commentaire obligatoire (≥ 10 caractères)', async () => {
    setup({ canApprove: true, canReject: true })
    fireEvent.click(await screen.findByText('workflow.reject'))
    const confirm = screen.getByText('workflow.confirmReject').closest('button')!
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('workflow.rejectReasonLabel'), { target: { value: 'court' } })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('workflow.rejectReasonLabel'), { target: { value: 'Prime de transport erronée' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/payroll/periods/2026-10/reject', { reason: 'Prime de transport erronée' }))
    expect(await screen.findByText('workflow.rejectedNotice')).toBeTruthy()
  })

  it('initiateur : « Annuler l’initiation » (aucune action de validation proposée)', async () => {
    setup({ canCancel: true, deniedReason: 'initiator' }, { sub: 'u-init', role: 'hr_manager' })
    expect(await screen.findByText('workflow.sodInitiator')).toBeTruthy()
    expect(screen.queryByText('workflow.reject')).toBeNull()
    fireEvent.click(screen.getByText('workflow.cancelInitiation'))
    fireEvent.click(screen.getByText('workflow.confirmCancel'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/payroll/periods/2026-10/cancel', {}))
  })

  it('membre RH non désigné : attente du valideur, aucune action', async () => {
    setup({ deniedReason: 'awaiting_designated' }, { sub: 'u-admin', role: 'admin' })
    expect(await screen.findByText(/workflow\.sodAwaitingDesignated.*Yao Brou/)).toBeTruthy()
    expect(screen.queryByText('workflow.reject')).toBeNull()
    expect(screen.queryByText('workflow.cancelInitiation')).toBeNull()
  })

  it('message de clôture : valideur nommé, sans chemin d’API', async () => {
    setup({})
    postMock.mockResolvedValueOnce({ data: { status: 'pending_validation', employeesCount: 2, pendingWith: PENDING_WITH, message: 'x' } })
    fireEvent.click(await screen.findByLabelText('workflow.cancel'))
    const monthSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    fireEvent.change(monthSelect, { target: { value: monthSelect.options[3]!.value } })
    fireEvent.click(screen.getByText('close.submit'))
    const msg = await screen.findByText(/close\.pendingWithNamed.*Yao Brou.*Chef de service paie/)
    expect(msg.textContent).not.toMatch(/POST|\/payroll/)
  })
})
