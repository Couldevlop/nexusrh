/**
 * Page /employer-brand — KPI agrégés, filtres période + filiale propagés à
 * l'API, états vides (zéro écran vide) et erreur.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'fr' } }),
}))
// ResponsiveContainer de Recharts dépend de ResizeObserver (absent de jsdom).
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>()
  return { ...actual, ResponsiveContainer: ({ children }: { children: ReactNode }) => <div data-testid="chart">{children}</div> }
})

import EmployerBrandPage, { defaultPeriod, type EmployerBrandOverview } from './EmployerBrandPage'

const LE = '11111111-1111-4111-8111-111111111111'

function overview(over: Partial<EmployerBrandOverview> = {}): EmployerBrandOverview {
  return {
    period: { from: '2025-10-31', to: '2026-10-30' },
    legalEntityId: null,
    legalEntities: [{ id: LE, name: 'SOTRA Abidjan' }],
    attractiveness: {
      totalApplications: 10, internalApplications: 2, internalRate: 20,
      bySource: [{ source: 'careers_page', count: 8 }, { source: 'internal', count: 2 }],
      byJob: [{ jobId: 'j1', title: 'Chauffeur de bus', applications: 7, internal: 2 }],
    },
    timeToFill: { filledJobs: 3, medianDays: 20, averageDays: 30 },
    pipeline: { total: 5, byStage: [{ stage: 'new', count: 4 }, { stage: 'hired', count: 1 }] },
    retention: {
      hires: 4,
      retention3m: { eligible: 4, retained: 3, rate: 75 },
      retention12m: { eligible: 2, retained: 1, rate: 50 },
      departures: 3, earlyDepartures: 1, earlyDepartureRate: 33.3,
    },
    departureTypes: [{ type: 'demission', count: 2 }, { type: 'autre', count: 0 }],
    ...over,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><EmployerBrandPage /></QueryClientProvider>)
}

beforeEach(() => { getMock.mockReset() })
afterEach(() => { cleanup() })

describe('EmployerBrandPage', () => {
  it('affiche les KPI agrégés et le classement des offres', async () => {
    getMock.mockResolvedValue({ data: { data: overview() } })
    renderPage()
    expect((await screen.findByTestId('kpi-applications')).textContent).toBe('10')
    expect(screen.getByTestId('kpi-internalRate').textContent).toBe('20 %')
    expect(screen.getByTestId('kpi-timeToFill').textContent).toBe('kpis.days')
    expect(screen.getByTestId('kpi-retention12m').textContent).toBe('50 %')
    expect(screen.getByTestId('kpi-earlyDepartures').textContent).toBe('1')
    expect(screen.getByText('Chauffeur de bus')).toBeTruthy()
    expect(screen.getAllByTestId('chart').length).toBe(4)
  })

  it('période par défaut = 12 derniers mois, filtres période et filiale transmis à l\'API', async () => {
    getMock.mockResolvedValue({ data: { data: overview() } })
    renderPage()
    const p = defaultPeriod()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(`/employer-brand/overview?from=${p.from}&to=${p.to}`))

    fireEvent.change(await screen.findByLabelText('filters.legalEntity'), { target: { value: LE } })
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(`/employer-brand/overview?from=${p.from}&to=${p.to}&legalEntityId=${LE}`))

    fireEvent.change(screen.getByLabelText('filters.from'), { target: { value: '2026-01-01' } })
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(`/employer-brand/overview?from=2026-01-01&to=${p.to}&legalEntityId=${LE}`))
  })

  it('aucune filiale : pas de sélecteur', async () => {
    getMock.mockResolvedValue({ data: { data: overview({ legalEntities: [] }) } })
    renderPage()
    await screen.findByTestId('kpi-applications')
    expect(screen.queryByLabelText('filters.legalEntity')).toBeNull()
  })

  it('période sans données : message explicite et états vides par graphique (jamais d\'écran vide)', async () => {
    getMock.mockResolvedValue({ data: { data: overview({
      attractiveness: { totalApplications: 0, internalApplications: 0, internalRate: null, bySource: [], byJob: [] },
      timeToFill: { filledJobs: 0, medianDays: null, averageDays: null },
      pipeline: { total: 0, byStage: [] },
      retention: {
        hires: 0, retention3m: { eligible: 0, retained: 0, rate: null }, retention12m: { eligible: 0, retained: 0, rate: null },
        departures: 0, earlyDepartures: 0, earlyDepartureRate: null,
      },
      departureTypes: [],
    }) } })
    renderPage()
    expect(await screen.findByText('emptyPeriod')).toBeTruthy()
    expect(screen.getByTestId('kpi-internalRate').textContent).toBe('—')
    expect(screen.getByText('charts.noPipeline')).toBeTruthy()
    expect(screen.getByText('charts.noRetention')).toBeTruthy()
    expect(screen.getByText('charts.noDepartures')).toBeTruthy()
    expect(screen.queryAllByTestId('chart').length).toBe(0)
  })

  it('erreur API : message d\'erreur', async () => {
    getMock.mockRejectedValue(new Error('500'))
    renderPage()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
