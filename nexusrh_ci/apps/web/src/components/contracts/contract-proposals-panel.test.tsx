/**
 * Propositions de contrat au dossier salarié : affichées à la RH comme
 * PROPOSITIONS (distinctes du contrat signé), masquées sans donnée ou hors RH.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, authState } = vi.hoisted(() => ({ getMock: vi.fn(), authState: { role: 'hr_manager' } }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  formatDate: (d: string) => d,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: authState.role } }),
}))

import { ContractProposalsPanel } from './ContractProposalsPanel'

const EMP = '22222222-2222-4222-8222-222222222222'
const DOC = { id: 'd1', title: 'Proposition de contrat (générée au recrutement)', fileName: 'p.pdf', sizeBytes: 10, version: 1, isCurrent: true, createdAt: '2026-10-30' }

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ContractProposalsPanel employeeId={EMP} /></QueryClientProvider>)
}

beforeEach(() => {
  authState.role = 'hr_manager'
  getMock.mockReset().mockResolvedValue({ data: { data: [DOC] } })
})
afterEach(() => cleanup())

describe('ContractProposalsPanel', () => {
  it('RH : liste les propositions sous un libellé distinct du contrat signé', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText(DOC.title)).toBeTruthy())
    expect(screen.getByText('proposal.title')).toBeTruthy()
    expect(screen.getByText('proposal.current')).toBeTruthy()
    expect(getMock).toHaveBeenCalledWith(`/recruitment/contract-proposals/employee/${EMP}`)
  })

  it('aucune proposition : panneau masqué', async () => {
    getMock.mockResolvedValue({ data: { data: [] } })
    const { container } = renderPanel()
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('employé ou manager : aucun appel, rien affiché', () => {
    for (const role of ['employee', 'manager']) {
      authState.role = role
      const { container } = renderPanel()
      expect(container.textContent).toBe('')
      cleanup()
    }
    expect(getMock).not.toHaveBeenCalled()
  })
})
