/**
 * Bulletin transparent — libellés du pays du bulletin.
 *
 * Recette multi-filiales (CI + Burkina + Bénin) : l'en-tête, les tuiles et le
 * texte d'introduction affichaient « CNPS » / « ITS » / « référence légale CI »
 * quel que soit le pays, alors que les lignes suivaient le pack de la filiale.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import fr from '@/i18n/locales/fr/payroll.json'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatMonth: (m: string) => m,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const raw = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], fr)
      const s = typeof raw === 'string' ? raw : key
      return s.replace(/\{\{(\w+)\}\}/g, (_, v: string) => String(vars?.[v] ?? ''))
    },
  }),
}))

import PaySlipTransparentModal from './PaySlipTransparentModal'

function renderWith(labels: Record<string, string> | undefined) {
  getMock.mockResolvedValue({ data: {
    slip: {
      id: 's1', month: '2026-09', baseSalary: 300000, grossSalary: 300000, netPayable: 260000,
      totalCnpsSal: 16500, totalCnpsPat: 0, its: 23500, employerCost: 0, totalDeductions: 40000,
      generatedAt: null, viewedAt: null, paymentStatus: 'pending', paymentMethod: 'wave',
      paymentReference: null, paidAt: null,
    },
    employee: { id: 'e1', firstName: 'Awa', lastName: 'Ouédraogo', cnpsNumber: 'BF-7700100', nni: null, jobTitle: null },
    period: { id: 'p1', status: 'closed', initiatedAt: null, closedAt: null },
    ...(labels ? { labels } : {}),
    lines: [],
    totals: { earnings: 300000, employeeContributions: 40000, employerContributions: 0 },
    comparison: [], audit: [],
  } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><PaySlipTransparentModal slipId="s1" onClose={() => undefined} /></QueryClientProvider>)
}

afterEach(() => { cleanup(); getMock.mockReset() })

describe('PaySlipTransparentModal — libellés pays', () => {
  it('bulletin Burkina : CNSS / IUTS / Burkina Faso, plus aucune mention CNPS / ITS / CI', async () => {
    renderWith({
      packCode: 'BFA-2024', countryCode: 'BFA', countryName: 'Burkina Faso',
      caisse: 'CNSS', caisseShort: 'CNSS', impot: 'IUTS — Impôt Unique sur Traitements et Salaires', impotShort: 'IUTS',
    })
    expect(await screen.findByText('CNSS sal.')).toBeTruthy()
    expect(screen.getByText('IUTS')).toBeTruthy()
    expect(screen.getByText(/N° CNSS BF-7700100/)).toBeTruthy()
    expect(screen.getByText(/référence légale \(Burkina Faso\)/)).toBeTruthy()
    expect(screen.queryByText(/CNPS/)).toBeNull()
    expect(screen.queryByText(/légale CI/)).toBeNull()
  })

  it('bulletin Bénin : CNSS / ITS / Bénin', async () => {
    renderWith({
      packCode: 'BEN-2024', countryCode: 'BEN', countryName: 'Bénin',
      caisse: 'CNSS', caisseShort: 'CNSS', impot: 'ITS — Impôt sur Traitements et Salaires', impotShort: 'ITS',
    })
    expect(await screen.findByText('CNSS sal.')).toBeTruthy()
    expect(screen.getByText(/référence légale \(Bénin\)/)).toBeTruthy()
  })

  it('réponse sans libellés (API antérieure) : libellés CI', async () => {
    renderWith(undefined)
    expect(await screen.findByText('CNPS sal.')).toBeTruthy()
    expect(screen.getByText('ITS')).toBeTruthy()
    expect(screen.getByText(/N° CNPS BF-7700100/)).toBeTruthy()
    expect(screen.getByText(/référence légale \(Côte d'Ivoire\)/)).toBeTruthy()
  })
})