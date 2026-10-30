/**
 * Page /climate — restitution des résultats avec seuil d'anonymat : sous le
 * seuil, message « résultats masqués » sans aucun score ; ventilation par
 * sous-groupe avec groupes masqués signalés.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o && 'min' in o ? `${k}:${String(o['count'])}/${String(o['min'])}` : k),
  }),
}))

import ClimatePage from './ClimatePage'

const SURVEY = { id: 's1', title: 'Baromètre 2026', description: null, status: 'open', anonymous: true, response_count: '3' }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ClimatePage /></QueryClientProvider>)
}

beforeEach(() => { getMock.mockReset() })
afterEach(() => { cleanup() })

describe('ClimatePage — seuil d\'anonymat', () => {
  it('sous le seuil : résultats masqués, aucun score affiché', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/climate/surveys') return Promise.resolve({ data: { data: [SURVEY] } })
      return Promise.resolve({ data: { data: { belowThreshold: true, responses: 3, minResponses: 5 } } })
    })
    renderPage()
    fireEvent.click(await screen.findByText('actions.results'))
    expect(await screen.findByText('results.belowThreshold:3/5')).toBeTruthy()
    expect(screen.queryByText('results.average')).toBeNull()
  })

  it('au-dessus du seuil avec ventilation : groupes visibles + groupes masqués signalés', async () => {
    getMock.mockImplementation((url: string, cfg?: { params?: { groupBy?: string } }) => {
      if (url === '/climate/surveys') return Promise.resolve({ data: { data: [SURVEY] } })
      const grouped = cfg?.params?.groupBy === 'department'
      return Promise.resolve({ data: { data: {
        belowThreshold: false, minResponses: 5, responseCount: 12,
        questions: [{ type: 'scale', key: 'sat', label: 'Satisfaction', count: 12, average: 3.8, distribution: {} }],
        groupBy: grouped ? 'department' : null,
        groups: grouped ? [{ key: 'd1', label: 'Exploitation', responseCount: 8, questions: [{ type: 'scale', key: 'sat', label: 'Satisfaction', count: 8, average: 4, distribution: {} }] }] : null,
        hiddenGroups: grouped ? 2 : 0,
      } } })
    })
    renderPage()
    fireEvent.click(await screen.findByText('actions.results'))
    expect(await screen.findByText('Satisfaction')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('results.groupBy'), { target: { value: 'department' } })
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/climate/surveys/s1/results', { params: { groupBy: 'department' } }))
    expect(await screen.findByText('Exploitation', { exact: false })).toBeTruthy()
    expect(screen.getByText('results.hiddenGroups:2/5', { exact: false })).toBeTruthy()
  })
})
