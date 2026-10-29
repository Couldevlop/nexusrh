/**
 * « Mon contrat » (self-service) : liste des contrats signés, option tenant
 * désactivée, entrée de menu conditionnée par l'option.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  formatDate: (d: string) => d,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({
    user: { role: 'employee', firstName: 'Awa', lastName: 'K', email: 'employe@sotra.ci' },
    tenantConfig: { name: 'SOTRA', enabledModules: {} },
    logout: vi.fn(),
  }),
}))
vi.mock('@/components/approvals/ApprovalAlerts', () => ({ default: () => null }))
vi.mock('@/components/approvals/workflow', () => ({ usePendingApprovals: () => ({ data: undefined }) }))
vi.mock('@/components/shared/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }))

import MonContrat from './MonContrat'
import EmployeeLayout from '@/components/layout/EmployeeLayout'

const ITEM = {
  id: 'd1', source: 'upload', title: 'CDI Awa', contractId: 'c1', contractType: 'cdi', contractStartDate: '2026-01-01',
  fileName: 'cdi.pdf', sizeBytes: 100, version: 2, isCurrent: true, createdAt: '2026-10-01',
  signedElectronicallyAt: '2026-10-02', fileDocumentId: 'd1',
}
const OLD = { ...ITEM, id: 'd0', title: 'CDI Awa (ancien)', version: 1, isCurrent: false, signedElectronicallyAt: null, fileDocumentId: 'd0' }

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

beforeEach(() => { getMock.mockReset() })
afterEach(() => cleanup())

describe('MonContrat', () => {
  it('affiche la version en vigueur, l\'historique et la signature électronique', async () => {
    getMock.mockResolvedValue({ data: { data: [ITEM, OLD] } })
    wrap(<MonContrat />)
    await waitFor(() => expect(screen.getByText('CDI Awa')).toBeTruthy())
    expect(getMock).toHaveBeenCalledWith('/contracts/signed/me')
    expect(screen.getByText('contract.current')).toBeTruthy()
    expect(screen.getByText('contract.history')).toBeTruthy()
    expect(screen.getByText('CDI Awa (ancien)')).toBeTruthy()
    expect(screen.getByText('contract.signedElectronically')).toBeTruthy()
    expect(screen.getAllByText('contract.download')).toHaveLength(2)
  })

  it('option désactivée (403 featureDisabled) → message dédié, aucun document', async () => {
    getMock.mockRejectedValue({ response: { status: 403, data: { error: 'x', featureDisabled: true } } })
    wrap(<MonContrat />)
    await waitFor(() => expect(screen.getByText('contract.disabled')).toBeTruthy())
    expect(screen.queryByText('contract.download')).toBeNull()
  })

  it('aucun contrat déposé → état vide', async () => {
    getMock.mockResolvedValue({ data: { data: [] } })
    wrap(<MonContrat />)
    await waitFor(() => expect(screen.getByText('contract.empty')).toBeTruthy())
  })

  it('signature électronique sans document déposé → pas de bouton de téléchargement', async () => {
    getMock.mockResolvedValue({ data: { data: [{ ...ITEM, id: 's1', source: 'signature', version: null, fileDocumentId: null }] } })
    wrap(<MonContrat />)
    await waitFor(() => expect(screen.getByText('contract.noFile')).toBeTruthy())
    expect(screen.queryByText('contract.download')).toBeNull()
  })
})

describe('EmployeeLayout — entrée « Mon contrat »', () => {
  it('masquée quand l\'option tenant est désactivée', async () => {
    getMock.mockResolvedValue({ data: { data: { employeeContractAccess: false, managerContractUpload: false } } })
    wrap(<EmployeeLayout />)
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/contracts/signed/settings'))
    expect(screen.queryAllByText('nav.contract')).toHaveLength(0)
  })
  it('affichée quand l\'option tenant est active', async () => {
    getMock.mockResolvedValue({ data: { data: { employeeContractAccess: true, managerContractUpload: false } } })
    wrap(<EmployeeLayout />)
    await waitFor(() => expect(screen.getAllByText('nav.contract').length).toBeGreaterThan(0))
  })
  it('erreur de lecture des options → entrée masquée (fail-closed)', async () => {
    getMock.mockRejectedValue(new Error('network'))
    wrap(<EmployeeLayout />)
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(screen.queryAllByText('nav.contract')).toHaveLength(0)
  })
})
