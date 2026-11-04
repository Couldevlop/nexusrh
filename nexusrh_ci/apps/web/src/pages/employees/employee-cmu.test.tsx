/**
 * Bénéficiaires CMU (loi n° 2014-131) dans la modale d'édition d'un employé :
 * conjoint sans emploi couvert et enfants couverts (vide = enfants à charge).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, postMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn(), patchMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: patchMock, delete: vi.fn() },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatDate: (d: string) => d,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))
vi.mock('@/stores/authStore', () => {
  const state = { user: { role: 'hr_manager' }, tenantConfig: { hasSubsidiaries: false } }
  return { useAuthStore: (sel: (s: typeof state) => unknown) => sel(state) }
})
vi.mock('@/lib/payment', () => ({
  canonicalMmProvider: (v: string | null) => v ?? '',
  paymentMethodLabel: (v: string) => v,
}))
vi.mock('@/components/employees/CustomFields', () => ({
  useEmployeeFieldDefinitions: () => [],
  CustomFieldsFieldset: () => null,
}))

import EmployeesPage from './EmployeesPage'

const EMP = {
  id: 'e1', first_name: 'Awa', last_name: 'Koné', email: 'awa@sotra.ci', job_title: 'Comptable',
  department_name: 'Finance', base_salary: '300000', mobile_money_provider: null, mobile_money_phone: null,
  contract_type: 'cdi', hire_date: '2020-01-01', is_active: true, cnps_number: null, nni: null,
  employee_number: 'MAT00007', marital_status: 'married', children_count: 3,
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><EmployeesPage /></MemoryRouter></QueryClientProvider>,
  )
}

function mockDetail(extra: Record<string, unknown>) {
  getMock.mockReset().mockImplementation((url: string) => {
    if (url.startsWith('/employees?')) return Promise.resolve({ data: { data: [EMP], total: 1 } })
    if (url === '/employees/e1') return Promise.resolve({ data: { data: { ...EMP, ...extra } } })
    return Promise.resolve({ data: { data: [] } })
  })
}

async function openEdit() {
  renderPage()
  fireEvent.click(await screen.findByTitle('edit.title'))
  return screen.findByLabelText('form.cmu.spouseCovered')
}

beforeEach(() => { patchMock.mockReset().mockResolvedValue({ data: { data: {} } }); postMock.mockReset() })
afterEach(() => cleanup())

describe('EmployeesPage — édition des bénéficiaires CMU', () => {
  it('valeurs par défaut : conjoint non couvert, enfants couverts vides (enfants à charge)', async () => {
    mockDetail({ cmu_spouse_covered: false, cmu_children_covered: null })
    const spouse = await openEdit() as HTMLSelectElement
    const children = screen.getByLabelText('form.cmu.childrenCovered') as HTMLInputElement
    expect(spouse.value).toBe('false')
    expect(children.value).toBe('')
    expect(children.placeholder).toBe('form.cmu.childrenCoveredPlaceholder')
  })

  it('conjoint couvert + 2 enfants : envoyés en booléen / nombre', async () => {
    mockDetail({ cmu_spouse_covered: false, cmu_children_covered: null })
    const spouse = await openEdit()
    fireEvent.change(spouse, { target: { value: 'true' } })
    fireEvent.change(screen.getByLabelText('form.cmu.childrenCovered'), { target: { value: '2' } })
    fireEvent.submit(spouse.closest('form')!)
    await waitFor(() => expect(patchMock).toHaveBeenCalled())
    expect(patchMock.mock.calls[0]?.[0]).toBe('/employees/e1')
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ cmuSpouseCovered: true, cmuChildrenCovered: 2 })
  })

  it('enfants couverts vidés : null (retour aux enfants à charge)', async () => {
    mockDetail({ cmu_spouse_covered: true, cmu_children_covered: 1 })
    const spouse = await openEdit()
    fireEvent.change(screen.getByLabelText('form.cmu.childrenCovered'), { target: { value: '' } })
    fireEvent.submit(spouse.closest('form')!)
    await waitFor(() => expect(patchMock).toHaveBeenCalled())
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ cmuChildrenCovered: null })
  })
})
