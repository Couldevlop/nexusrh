/**
 * Éditeur de proposition de contrat (recrutement) : chargement du texte
 * courant, aperçu PDF en blob:, enregistrement = nouvelle version,
 * historique téléchargeable, état « aucune proposition ».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: putMock, patch: vi.fn(), delete: vi.fn() },
  formatDate: (d: string) => d,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.version ? `${k}:${String(o.version)}` : k) }),
}))

import { ContractProposalEditor } from './ContractProposalEditor'

const APP = '22222222-2222-4222-8222-222222222222'
let state: unknown

function routeGet(url: string) {
  if (url === `/recruitment/applications/${APP}/contract-proposal`) return Promise.resolve({ data: { data: state } })
  if (url.startsWith(`/recruitment/applications/${APP}/contract-proposal/pdf`)) {
    return Promise.resolve({ data: new Blob(['%PDF-1.7'], { type: 'application/pdf' }) })
  }
  return Promise.reject(new Error('unexpected ' + url))
}

function renderEditor(onRegenerate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ContractProposalEditor applicationId={APP} candidate="Awa Traoré" onClose={vi.fn()} onRegenerate={onRegenerate} />
    </QueryClientProvider>,
  )
  return { onRegenerate }
}

beforeEach(() => {
  state = {
    enabled: true,
    current: { id: 'v2', version: 2, markdown: '# Contrat\n## Article 1', contractType: 'cdi_ci', createdAt: '2026-10-30' },
    versions: [
      { id: 'v2', version: 2, isCurrent: true, createdAt: '2026-10-30', contractType: 'cdi_ci', sizeBytes: 10 },
      { id: 'v1', version: 1, isCurrent: false, createdAt: '2026-10-29', contractType: 'cdi_ci', sizeBytes: 9 },
    ],
  }
  getMock.mockReset().mockImplementation(routeGet)
  putMock.mockReset()
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
})
afterEach(() => cleanup())

describe('ContractProposalEditor', () => {
  it('charge le texte courant, l’aperçu PDF et l’historique', async () => {
    renderEditor()
    const area = await screen.findByLabelText('contract.editorLabel') as HTMLTextAreaElement
    expect(area.value).toBe('# Contrat\n## Article 1')
    await waitFor(() => expect(screen.getByTitle('contract.preview').getAttribute('src')).toBe('blob:preview'))
    expect(screen.getAllByText(/contract\.version:/).length).toBeGreaterThanOrEqual(2)
  })

  it('enregistre le texte modifié (nouvelle version)', async () => {
    putMock.mockResolvedValue({ data: { data: { version: 3 } } })
    renderEditor()
    const area = await screen.findByLabelText('contract.editorLabel')
    const save = screen.getByText('contract.save').closest('button') as HTMLButtonElement
    expect(save.disabled).toBe(true) // rien de modifié
    fireEvent.change(area, { target: { value: '# Contrat\n## Article 1\nClause ajoutée.' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(
      `/recruitment/applications/${APP}/contract-proposal`, { markdown: '# Contrat\n## Article 1\nClause ajoutée.' },
    ))
    await waitFor(() => expect(screen.getByText('contract.saved:3')).toBeTruthy())
  })

  it('affiche le message de l’API en cas de refus (option désactivée)', async () => {
    putMock.mockRejectedValue({ response: { data: { error: 'Option désactivée' } } })
    renderEditor()
    const area = await screen.findByLabelText('contract.editorLabel')
    fireEvent.change(area, { target: { value: 'Nouveau texte' } })
    fireEvent.click(screen.getByText('contract.save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Option désactivée'))
  })

  it('télécharge une version de l’historique', async () => {
    renderEditor()
    await screen.findByLabelText('contract.editorLabel')
    const buttons = screen.getAllByText('contract.download')
    fireEvent.click(buttons[1]!)
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(
      `/recruitment/applications/${APP}/contract-proposal/pdf?version=1`, { responseType: 'blob' },
    ))
  })

  it('aucune proposition : invite à générer', async () => {
    state = { enabled: true, current: null, versions: [] }
    const { onRegenerate } = renderEditor()
    fireEvent.click(await screen.findByText('contract.generateProposal'))
    expect(onRegenerate).toHaveBeenCalled()
  })
})
