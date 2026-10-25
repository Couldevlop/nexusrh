/**
 * « Mes validations » — les clôtures de paie en validation y apparaissent pour
 * leur valideur attendu, avec l'échéance, et s'ouvrent dans l'écran Paie
 * (circuit complet : valider / renvoyer en préparation).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), patchMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), patch: patchMock, delete: vi.fn(), put: vi.fn() },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatMonth: (m: string) => `mois ${m}`,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
}))

import ApprovalsPage from './ApprovalsPage'

afterEach(() => cleanup())

describe('ApprovalsPage — clôture de paie', () => {
  it('affiche la période, son valideur attendu et un lien vers l’écran Paie', async () => {
    getMock.mockResolvedValue({ data: {
      data: [{
        module: 'payroll', id: 'per-1', month: '2026-10', employeeId: 'u-init', employeeName: 'Awa Koné',
        label: '2026-10', detail: '', submittedAt: '2026-10-25T10:00:00Z', dueSoon: false,
        workflow: {
          totalSteps: 2, doneSteps: 0, dueAt: '2026-10-27T10:00:00Z', overdue: false, canAct: true, designated: true,
          next: { kind: 'payroll', level: 1, validatorName: 'Yao Brou', functionLabel: 'Chef de service paie' },
        },
      }],
      summary: { actionable: 1, overdue: 0, dueSoon: 0, readOnly: 0 },
    } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><ApprovalsPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/payrollLabel.*mois 2026-10/)).toBeTruthy()
    expect(screen.getByText(/payrollInitiatedBy.*Awa Koné/)).toBeTruthy()
    expect(screen.getByText('Yao Brou (Chef de service paie)')).toBeTruthy()
    expect(screen.getByText(/step\.payroll/)).toBeTruthy()
    const link = screen.getByText('actions.open').closest('a')!
    expect(link.getAttribute('href')).toBe('/payroll?validate=2026-10')
    // Pas de bouton Approuver / Refuser générique (endpoints absences / frais) pour la paie
    expect(screen.queryByText('actions.approve')).toBeNull()
    expect(patchMock).not.toHaveBeenCalled()
  })

  it('paie multi-filiales : une seule ligne (période parente) ouvrant le circuit de l’écran multi-filiales', async () => {
    const PARENT = '11111111-1111-4111-8111-111111111111'
    getMock.mockResolvedValue({ data: {
      data: [{
        module: 'payroll', scope: 'multi_sites', id: PARENT, month: '2026-11', employeeId: 'u-init', employeeName: 'Awa Koné',
        label: '2026-11', detail: '', submittedAt: '2026-11-25T10:00:00Z', dueSoon: false,
        workflow: {
          totalSteps: 2, doneSteps: 1, dueAt: '2026-11-27T10:00:00Z', overdue: false, canAct: true, designated: true,
          next: { kind: 'payroll', level: 2, validatorName: 'Fanta Traoré', functionLabel: 'DRH' },
        },
      }],
      summary: { actionable: 1, overdue: 0, dueSoon: 0, readOnly: 0 },
    } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><ApprovalsPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/payrollLabel.*mois 2026-11/)).toBeTruthy()
    expect(screen.getByText('Fanta Traoré (DRH)')).toBeTruthy()
    const links = screen.getAllByText('actions.open')
    expect(links).toHaveLength(1)
    expect(links[0]!.closest('a')!.getAttribute('href')).toBe(`/payroll/multi-filiales?validate=${PARENT}`)
  })
})
