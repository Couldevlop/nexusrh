/**
 * Bulletin transparent — signe des lignes.
 *
 * Recette paie oct. 2026 (Yao) : les retenues d'absence (1010) et de retards
 * (1020) sont des lignes de gain NÉGATIVES ; la vue les affichait en vert et
 * sans signe, comme des gains.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatMonth: (m: string) => m,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import PaySlipTransparentModal from './PaySlipTransparentModal'

const line = (code: string, label: string, type: string, amount: number, category: string) =>
  ({ code, label, type, base: 250000, amount, formulaHuman: '', category })

function renderModal() {
  getMock.mockResolvedValue({ data: {
    slip: {
      id: 's1', month: '2026-10', baseSalary: 250000, grossSalary: 238217, netPayable: 223209,
      totalCnpsSal: 15008, totalCnpsPat: 0, its: 0, employerCost: 0, totalDeductions: 15008,
      generatedAt: null, viewedAt: null, paymentStatus: 'pending', paymentMethod: 'orange',
      paymentReference: null, paidAt: null,
    },
    employee: { id: 'e1', firstName: 'Yao', lastName: 'Koffi', cnpsNumber: null, nni: null, jobTitle: null },
    period: { id: 'p1', status: 'closed', initiatedAt: null, closedAt: null },
    lines: [
      line('1000', 'Salaire de base', 'earning', 250000, 'salary'),
      line('1010', 'Retenue absences injustifiées (1 j)', 'earning', -9259, 'salary'),
      line('1020', 'Retenue retards (105 min)', 'earning', -2524, 'salary'),
      line('2000', 'CNPS Retraite salarié (6.3%)', 'employee_contribution', 15008, 'cnps'),
    ],
    totals: { earnings: 238217, employeeContributions: 15008, employerContributions: 0 },
    comparison: [], audit: [],
  } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><PaySlipTransparentModal slipId="s1" onClose={() => undefined} /></QueryClientProvider>)
}

afterEach(() => { cleanup(); getMock.mockReset() })

describe('PaySlipTransparentModal — signe des montants', () => {
  it('une retenue portée en gain négatif est affichée en négatif (rouge)', async () => {
    renderModal()
    const absence = await screen.findByText('−9259 FCFA')
    expect(absence.className).toContain('text-rose-700')
    expect(screen.getByText('−2524 FCFA').className).toContain('text-rose-700')
  })

  it('un gain positif reste affiché sans signe, en vert ; une cotisation reste négative', async () => {
    renderModal()
    await screen.findAllByText('250000 FCFA')
    const has = (text: string, cls: string) => screen.getAllByText(text).some((e) => e.className.includes(cls))
    expect(has('250000 FCFA', 'text-green-700')).toBe(true)
    expect(has('−15008 FCFA', 'text-rose-700')).toBe(true)
  })
})
