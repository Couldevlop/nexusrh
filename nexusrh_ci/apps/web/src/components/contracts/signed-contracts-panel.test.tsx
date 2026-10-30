/**
 * Panneau « Contrat signé » (fiche employé / détail du contrat) : RBAC front,
 * option « dépôt par le manager », validation PDF côté client, envoi multipart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  authState: { role: 'hr_manager' },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  formatDate: (d: string) => d,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: { user: { role: string }; tenantConfig: { enabledModules: Record<string, boolean> } }) => unknown) =>
    sel({ user: { role: authState.role }, tenantConfig: { enabledModules: {} } }),
}))

import { SignedContractsPanel } from './SignedContractsPanel'

const EMP = '22222222-2222-4222-8222-222222222222'
let options = { employeeContractAccess: true, managerContractUpload: false }

function routeGet(url: string) {
  if (url === '/contracts/signed/settings') return Promise.resolve({ data: { data: options } })
  if (url.startsWith('/contracts/signed/employee/')) {
    return Promise.resolve({ data: { data: [{
      id: 'd1', source: 'upload', title: 'CDI', contractId: null, contractType: null, contractStartDate: null,
      fileName: 'cdi.pdf', sizeBytes: 10, version: 1, isCurrent: true, createdAt: '2026-10-01',
      signedElectronicallyAt: null, fileDocumentId: 'd1',
    }] } })
  }
  if (url.startsWith('/contracts/employee/')) return Promise.resolve({ data: { data: [] } })
  return Promise.reject(new Error('unexpected ' + url))
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SignedContractsPanel employeeId={EMP} /></QueryClientProvider>)
}

beforeEach(() => {
  authState.role = 'hr_manager'
  options = { employeeContractAccess: true, managerContractUpload: false }
  getMock.mockReset().mockImplementation(routeGet)
  postMock.mockReset()
})
afterEach(() => cleanup())

describe('SignedContractsPanel', () => {
  it('RH : liste + téléchargement + formulaire de dépôt', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText('CDI')).toBeTruthy())
    expect(screen.getByText('signed.download')).toBeTruthy()
    expect(screen.getByText('signed.upload')).toBeTruthy()
  })

  it('RH : dépôt d\'un PDF en multipart puis confirmation', async () => {
    postMock.mockResolvedValue({ data: { data: { version: 2 } } })
    renderPanel()
    await waitFor(() => expect(screen.getByText('signed.upload')).toBeTruthy())
    const input = screen.getByLabelText('signed.file') as HTMLInputElement
    const pdf = new File(['%PDF-1.4'], 'cdi.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [pdf] } })
    fireEvent.click(screen.getByText('signed.upload'))
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    const [url, body] = postMock.mock.calls[0] as [string, FormData]
    expect(url).toBe(`/contracts/signed/employee/${EMP}`)
    expect(body.get('file')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('signed.uploaded')).toBeTruthy())
  })

  it('refuse côté client un fichier non PDF (aucun envoi)', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText('signed.upload')).toBeTruthy())
    const input = screen.getByLabelText('signed.file') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'photo.png', { type: 'image/png' })] } })
    expect(screen.getByText('signed.pdfOnly')).toBeTruthy()
    expect((screen.getByText('signed.upload').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(postMock).not.toHaveBeenCalled()
  })

  it('manager sans option → panneau masqué, aucun appel à la liste', async () => {
    authState.role = 'manager'
    renderPanel()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/contracts/signed/settings'))
    expect(screen.queryByText('signed.title')).toBeNull()
    expect(getMock.mock.calls.some((c) => String(c[0]).startsWith('/contracts/signed/employee/'))).toBe(false)
  })

  it('manager avec option → dépôt possible mais pas de téléchargement', async () => {
    authState.role = 'manager'
    options = { employeeContractAccess: true, managerContractUpload: true }
    renderPanel()
    await waitFor(() => expect(screen.getByText('CDI')).toBeTruthy())
    expect(screen.getByText('signed.upload')).toBeTruthy()
    expect(screen.queryByText('signed.download')).toBeNull()
    expect(getMock.mock.calls.some((c) => String(c[0]).startsWith('/contracts/employee/'))).toBe(false)
  })

  it('employé → rien n\'est affiché', async () => {
    authState.role = 'employee'
    renderPanel()
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(screen.queryByText('signed.title')).toBeNull()
  })
})
