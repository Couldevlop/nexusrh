/**
 * Page /sage — sélecteur Filiale (tenant multi-filiales uniquement) et
 * propagation du filtre ?legalEntityId= aux téléchargements CSV.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import SagePage from './SagePage'

const CFG = { enabled: true, separator: 'semicolon', include_header: true, matricule_source: 'employee_number' }
const LE_A = '11111111-1111-4111-8111-111111111111'

function mockApi(scope: { multiEntity: boolean; entities: Array<{ id: string; name: string; cnps_number: string | null }> }) {
  getMock.mockImplementation((url: string) => {
    if (url === '/sage/config') return Promise.resolve({ data: { data: CFG } })
    if (url === '/sage/legal-entities') return Promise.resolve({ data: { data: scope } })
    return Promise.resolve({ data: new Blob(['x']) })
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SagePage /></QueryClientProvider>)
}

beforeEach(() => {
  getMock.mockReset()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  // jsdom ne gère pas la navigation déclenchée par le lien de téléchargement.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SagePage — filtre filiale', () => {
  it('tenant multi-filiales : sélecteur affiché, filtre transmis à l\'export', async () => {
    mockApi({ multiEntity: true, entities: [{ id: LE_A, name: 'Groupe Abidjan', cnps_number: '1234567' }] })
    renderPage()
    const select = await screen.findByLabelText('exports.legalEntity')
    expect(screen.getByText('Groupe Abidjan (1234567)')).toBeTruthy()
    expect(screen.getByText('exports.entityColumnsNote')).toBeTruthy()
    fireEvent.change(select, { target: { value: LE_A } })
    fireEvent.click(screen.getAllByText('exports.download')[0]!)
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(
      `/sage/export/employees.csv?legalEntityId=${LE_A}`, { responseType: 'blob' }))
  })

  it('période + filiale combinées pour la paie', async () => {
    mockApi({ multiEntity: true, entities: [{ id: LE_A, name: 'Groupe Abidjan', cnps_number: null }] })
    const { container } = renderPage()
    fireEvent.change(await screen.findByLabelText('exports.legalEntity'), { target: { value: LE_A } })
    fireEvent.change(container.querySelector('input[type="month"]')!, { target: { value: '2026-09' } })
    fireEvent.click(screen.getAllByText('exports.download')[2]!)
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(
      `/sage/export/payroll.csv?period=2026-09&legalEntityId=${LE_A}`, { responseType: 'blob' }))
  })

  it('tenant mono-entité : aucun sélecteur, URL d\'export inchangée', async () => {
    mockApi({ multiEntity: false, entities: [] })
    renderPage()
    await screen.findByText('config.title')
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/sage/legal-entities'))
    expect(screen.queryByLabelText('exports.legalEntity')).toBeNull()
    fireEvent.click(screen.getAllByText('exports.download')[0]!)
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/sage/export/employees.csv', { responseType: 'blob' }))
  })
})