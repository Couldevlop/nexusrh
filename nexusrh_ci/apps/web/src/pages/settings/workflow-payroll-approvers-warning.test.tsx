/**
 * Paramètres → Workflow : avertissement quand le tenant n'a pas assez
 * d'approbateurs distincts pour le circuit de paie (N niveaux + initiateur).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { payrollApproverCapacity } from './payroll-approver-capacity'

const { getMock, authStoreMock } = vi.hoisted(() => ({ getMock: vi.fn(), authStoreMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}))
vi.mock('@/stores/authStore', () => ({ useAuthStore: authStoreMock }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && 'level' in o ? `${k} ${String(o.level)}` : k) }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import SettingsPage from './SettingsPage'

const member = (id: string, role: string) => ({ id, first_name: id, last_name: 'X', email: `${id}@sotra.ci`, role })

function renderWorkflowTab(hrTeam: ReturnType<typeof member>[], levels = 2) {
  getMock.mockReset().mockImplementation((url: string) => {
    if (url === '/settings/workflow') {
      return Promise.resolve({ data: { data: [{ id: 'w', module: 'payroll', levels_count: levels, config: { validators: [] } }] } })
    }
    if (url === '/settings/workflow/hr-team') return Promise.resolve({ data: { data: hrTeam } })
    return Promise.resolve({ data: { data: [] } })
  })
  window.history.replaceState({}, '', '/settings?tab=workflow')
  authStoreMock.mockImplementation((sel?: (s: unknown) => unknown) => {
    const state = { tenantConfig: { name: 'SOTRA', enabledModules: {} }, updateTenantConfig: vi.fn() }
    return sel ? sel(state) : state
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SettingsPage /></QueryClientProvider>)
}

beforeEach(() => { getMock.mockReset() })
afterEach(() => cleanup())

describe('payrollApproverCapacity', () => {
  it('N niveaux exigent N + 1 personnes de l’équipe RH', () => {
    expect(payrollApproverCapacity(2, [member('a', 'admin'), member('b', 'hr_manager')], []))
      .toEqual({ required: 3, available: 2, sufficient: false })
    expect(payrollApproverCapacity(2, [member('a', 'admin'), member('b', 'hr_manager'), member('c', 'admin')], []).sufficient).toBe(true)
  })

  it('un gestionnaire RH ne compte que s’il est valideur désigné', () => {
    const team = [member('a', 'admin'), member('b', 'hr_manager'), member('o', 'hr_officer')]
    expect(payrollApproverCapacity(2, team, []).available).toBe(2)
    expect(payrollApproverCapacity(2, team, ['o'])).toEqual({ required: 3, available: 3, sufficient: true })
  })

  it('aucun administrateur / responsable RH : personne ne peut initier', () => {
    expect(payrollApproverCapacity(1, [member('o1', 'hr_officer'), member('o2', 'hr_officer')], ['o1', 'o2']).sufficient).toBe(false)
  })
})

describe('WorkflowTab — avertissement approbateurs insuffisants', () => {
  it('affiche l’avertissement quand l’équipe RH est trop petite pour le circuit', async () => {
    renderWorkflowTab([member('a', 'admin'), member('b', 'hr_manager')], 2)
    expect(await screen.findByTestId('payroll-approvers-warning')).toBeTruthy()
    expect(screen.getByText('workflow.payrollCircuit.notEnoughApproversTitle')).toBeTruthy()
  })

  it('pas d’avertissement quand l’équipe suffit', async () => {
    renderWorkflowTab([member('a', 'admin'), member('b', 'hr_manager'), member('c', 'admin')], 2)
    await screen.findByText('workflow.payrollCircuit.sodHint')
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/settings/workflow/hr-team'))
    expect(screen.queryByTestId('payroll-approvers-warning')).toBeNull()
  })

  it('l’avertissement suit le nombre de niveaux choisi', async () => {
    renderWorkflowTab([member('a', 'admin'), member('b', 'hr_manager'), member('c', 'admin')], 2)
    await screen.findByText('workflow.payrollCircuit.sodHint')
    expect(screen.queryByTestId('payroll-approvers-warning')).toBeNull()
    // Passer la paie à 3 niveaux → 4 personnes requises
    const payrollButtons = screen.getAllByRole('button', { name: '3' })
    fireEvent.click(payrollButtons[payrollButtons.length - 1]!)
    expect(await screen.findByTestId('payroll-approvers-warning')).toBeTruthy()
  })
})
