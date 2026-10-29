/**
 * Matricule dans la page Employés : affiché dans la liste, saisissable à la
 * création (vide = généré par le serveur), erreur d'unicité lisible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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
  employee_number: 'MAT00007',
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><EmployeesPage /></MemoryRouter></QueryClientProvider>,
  )
}

async function openCreateAndFill(employeeNumber: string) {
  fireEvent.click(await screen.findByText('newEmployee'))
  const input = await screen.findByLabelText('form.fields.employeeNumber')
  expect((input as HTMLInputElement).placeholder).toBe('form.placeholders.employeeNumber')
  const form = input.closest('form')!
  const required = form.querySelectorAll('input[required]')
  fireEvent.change(required[0]!, { target: { value: 'Jean' } })
  fireEvent.change(required[1]!, { target: { value: 'Kouassi' } })
  fireEvent.change(screen.getByPlaceholderText('form.placeholders.baseSalary'), { target: { value: '250000' } })
  if (employeeNumber) fireEvent.change(input, { target: { value: employeeNumber } })
  fireEvent.submit(form)
}

beforeEach(() => {
  getMock.mockReset().mockImplementation((url: string) =>
    Promise.resolve({ data: url.startsWith('/employees?') ? { data: [EMP], total: 1 } : { data: [] } }))
  postMock.mockReset()
})
afterEach(() => cleanup())

describe('EmployeesPage — matricule', () => {
  it('affiche le matricule dans la liste', async () => {
    renderPage()
    expect(await screen.findByText('MAT00007')).toBeTruthy()
  })

  it('création avec matricule saisi : envoyé (espaces retirés)', async () => {
    postMock.mockResolvedValue({ data: { data: { id: 'e2' } } })
    renderPage()
    await openCreateAndFill('  RH-0042 ')
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(postMock.mock.calls[0]?.[1]).toMatchObject({ employeeNumber: 'RH-0042', firstName: 'Jean' })
  })

  it('création sans matricule : champ non envoyé (généré par le serveur)', async () => {
    postMock.mockResolvedValue({ data: { data: { id: 'e2' } } })
    renderPage()
    await openCreateAndFill('')
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(postMock.mock.calls[0]?.[1]).not.toHaveProperty('employeeNumber')
  })

  it('matricule déjà attribué (409) : message de l\'API affiché', async () => {
    postMock.mockRejectedValue({ response: { status: 409, data: { error: 'Ce matricule est déjà attribué à un autre employé.' } } })
    renderPage()
    await openCreateAndFill('MAT00007')
    expect(await screen.findByText('Ce matricule est déjà attribué à un autre employé.')).toBeTruthy()
  })
})