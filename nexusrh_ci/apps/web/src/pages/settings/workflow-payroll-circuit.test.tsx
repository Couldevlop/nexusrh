/**
 * Paramètres → Workflow : circuit NOMINATIF de la clôture de paie.
 * Pour chaque niveau : valideur (équipe RH), fonction, échéance (jours).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, patchMock, authStoreMock } = vi.hoisted(() => ({
  getMock: vi.fn(), patchMock: vi.fn(), authStoreMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), patch: patchMock, delete: vi.fn(), put: vi.fn() },
}))
vi.mock('@/stores/authStore', () => ({ useAuthStore: authStoreMock }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && 'level' in o ? `${k} ${String(o.level)}` : k) }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import SettingsPage from './SettingsPage'

const HR_TEAM = [
  { id: 'u-paie', first_name: 'Yao', last_name: 'Brou', email: 'paie@sotra.ci', role: 'hr_officer' },
  { id: 'u-drh', first_name: 'Fanta', last_name: 'Traoré', email: 'drh@sotra.ci', role: 'hr_manager' },
]

function renderWorkflowTab() {
  window.history.replaceState({}, '', '/settings?tab=workflow')
  authStoreMock.mockImplementation((sel?: (s: unknown) => unknown) => {
    const state = { tenantConfig: { name: 'SOTRA', enabledModules: {} }, updateTenantConfig: vi.fn() }
    return sel ? sel(state) : state
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SettingsPage /></QueryClientProvider>)
}

beforeEach(() => {
  patchMock.mockReset().mockResolvedValue({ data: { data: [] } })
  getMock.mockReset().mockImplementation((url: string) => {
    if (url === '/settings/workflow') {
      return Promise.resolve({ data: { data: [{ id: 'w', module: 'payroll', levels_count: 2, config: {
        validators: [{ userId: 'u-paie', functionLabel: 'Chef de service paie', slaDays: 3 }],
      } }] } })
    }
    if (url === '/settings/workflow/hr-team') return Promise.resolve({ data: { data: HR_TEAM } })
    return Promise.resolve({ data: { data: [] } })
  })
})
afterEach(() => cleanup())

describe('WorkflowTab — valideurs nominatifs de la paie', () => {
  it('affiche un valideur + fonction + échéance par niveau, et enregistre le circuit', async () => {
    renderWorkflowTab()
    const fn1 = await screen.findByDisplayValue('Chef de service paie')
    expect(fn1).toBeTruthy()
    expect((screen.getByLabelText('workflow.payrollCircuit.sla — workflow.payrollCircuit.level 1') as HTMLInputElement).value).toBe('3')
    // Niveau 2 : désigner la DRH
    fireEvent.change(screen.getByLabelText('workflow.payrollCircuit.validator — workflow.payrollCircuit.level 2'), { target: { value: 'u-drh' } })
    fireEvent.change(screen.getByLabelText('workflow.payrollCircuit.functionLabel — workflow.payrollCircuit.level 2'), { target: { value: ' DRH ' } })
    fireEvent.click(screen.getByText('workflow.save'))
    await waitFor(() => expect(patchMock).toHaveBeenCalled())
    const body = patchMock.mock.calls[0]![1] as Array<{ module: string; levels_count: number; config?: { validators?: unknown[] } }>
    const payroll = body.find(c => c.module === 'payroll')!
    expect(payroll.levels_count).toBe(2)
    expect(payroll.config?.validators).toEqual([
      { userId: 'u-paie', functionLabel: 'Chef de service paie', slaDays: 3 },
      { userId: 'u-drh', functionLabel: 'DRH', slaDays: 2 },
    ])
  })

  it('refuse la même personne à deux niveaux (message + enregistrement bloqué)', async () => {
    renderWorkflowTab()
    await screen.findByDisplayValue('Chef de service paie')
    fireEvent.change(screen.getByLabelText('workflow.payrollCircuit.validator — workflow.payrollCircuit.level 2'), { target: { value: 'u-paie' } })
    expect(screen.getByText('workflow.payrollCircuit.duplicate')).toBeTruthy()
    expect(screen.getByText('workflow.save').closest('button')!.hasAttribute('disabled')).toBe(true)
  })
})
