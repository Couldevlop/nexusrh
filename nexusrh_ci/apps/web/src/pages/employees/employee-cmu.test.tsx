/**
 * Bénéficiaires CMU (loi n° 2014-131 ; CLEISS 2025) dans la modale d'édition
 * d'un employé et sur sa fiche : « Conjoint sans emploi » (oui / non / à
 * renseigner = null) et enfants de moins de 21 ans couverts (vide = enfants à
 * charge). Bloc affiché seulement pour un salarié relevant du pack CIV
 * (filiale CIV-*, sinon pays de la filiale, sinon pays du tenant).
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
const { authState } = vi.hoisted(() => ({
  authState: { user: { role: 'hr_manager' }, tenantConfig: { hasSubsidiaries: false, defaultCountryCode: 'CIV' } },
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('@/lib/payment', () => ({
  canonicalMmProvider: (v: string | null) => v ?? '',
  paymentMethodLabel: (v: string) => v,
}))
vi.mock('@/components/employees/CustomFields', () => ({
  useEmployeeFieldDefinitions: () => [],
  CustomFieldsFieldset: () => null,
}))

import EmployeesPage from './EmployeesPage'
import EmployeeDetail from './EmployeeDetail'
import { Routes, Route } from 'react-router-dom'

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

const ENTITIES = [
  { id: 'le-ci', name: 'Filiale CI', country_code: 'CIV', legislation_pack_code: 'CIV-2024' },
  { id: 'le-sn', name: 'Filiale SN', country_code: 'SEN', legislation_pack_code: null },
]

function mockDetail(extra: Record<string, unknown>) {
  getMock.mockReset().mockImplementation((url: string) => {
    if (url.startsWith('/employees?')) return Promise.resolve({ data: { data: [EMP], total: 1 } })
    if (url === '/employees/e1') return Promise.resolve({ data: { data: { ...EMP, ...extra } } })
    if (url === '/settings/legal-entities') return Promise.resolve({ data: { data: ENTITIES } })
    if (url.startsWith('/employees/e1/photo')) return Promise.reject(new Error('no photo'))
    return Promise.resolve({ data: { data: [] } })
  })
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/employees/e1']}>
        <Routes><Route path="/employees/:id" element={<EmployeeDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openEdit() {
  renderPage()
  fireEvent.click(await screen.findByTitle('edit.title'))
  return screen.findByLabelText('form.cmu.spouseCovered')
}

beforeEach(() => {
  patchMock.mockReset().mockResolvedValue({ data: { data: {} } }); postMock.mockReset()
  authState.tenantConfig = { hasSubsidiaries: false, defaultCountryCode: 'CIV' }
})
afterEach(() => cleanup())

describe('EmployeesPage — édition des bénéficiaires CMU', () => {
  it('valeurs : conjoint « non », enfants couverts vides (enfants à charge), info-bulle 21 ans', async () => {
    mockDetail({ cmu_spouse_covered: false, cmu_children_covered: null })
    const spouse = await openEdit() as HTMLSelectElement
    const children = screen.getByLabelText('form.cmu.childrenCovered') as HTMLInputElement
    expect(spouse.value).toBe('false')
    expect(children.value).toBe('')
    expect(children.placeholder).toBe('form.cmu.childrenCoveredPlaceholder')
    expect(children.title).toBe('form.cmu.childrenCoveredTooltip')
  })

  it('situation du conjoint non renseignée (null) : option « à renseigner », renvoyée en null', async () => {
    mockDetail({ cmu_spouse_covered: true, cmu_children_covered: null })
    const spouse = await openEdit() as HTMLSelectElement
    expect([...spouse.options].map(o => o.value)).toEqual(['', 'true', 'false'])
    fireEvent.change(spouse, { target: { value: '' } })
    fireEvent.submit(spouse.closest('form')!)
    await waitFor(() => expect(patchMock).toHaveBeenCalled())
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ cmuSpouseCovered: null })
  })

  it('tenant hors CIV (SEN) sans filiale : bloc CMU masqué', async () => {
    authState.tenantConfig = { hasSubsidiaries: false, defaultCountryCode: 'SEN' }
    mockDetail({ cmu_spouse_covered: false, cmu_children_covered: null })
    renderPage()
    fireEvent.click(await screen.findByTitle('edit.title'))
    await screen.findByText('edit.title', { selector: 'h2, h3' }).catch(() => undefined)
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/employees/e1'))
    expect(screen.queryByLabelText('form.cmu.spouseCovered')).toBeNull()
  })

  it('tenant SEN mais filiale CIV-2024 : bloc CMU affiché', async () => {
    authState.tenantConfig = { hasSubsidiaries: true, defaultCountryCode: 'SEN' }
    mockDetail({ legal_entity_id: 'le-ci', cmu_spouse_covered: false, cmu_children_covered: null })
    expect(await openEdit()).toBeTruthy()
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

describe('EmployeeDetail — bloc CMU', () => {
  it('marié, situation du conjoint non renseignée : avertissement « à renseigner »', async () => {
    mockDetail({ marital_status: 'married', cmu_spouse_covered: null, cmu_children_covered: null })
    renderDetail()
    expect(await screen.findByText('form.cmu.spouseToVerify')).toBeTruthy()
    expect(screen.getByText('form.cmu.beneficiaries')).toBeTruthy()
  })

  it('marié, conjoint renseigné : pas d’avertissement', async () => {
    mockDetail({ marital_status: 'married', cmu_spouse_covered: false, cmu_children_covered: null })
    renderDetail()
    expect(await screen.findByText('form.cmu.beneficiaries')).toBeTruthy()
    expect(screen.queryByText('form.cmu.spouseToVerify')).toBeNull()
  })

  it('filiale sénégalaise : bloc CMU masqué', async () => {
    authState.tenantConfig = { hasSubsidiaries: true, defaultCountryCode: 'CIV' }
    mockDetail({ legal_entity_id: 'le-sn', marital_status: 'married', cmu_spouse_covered: null })
    renderDetail()
    await screen.findByText('detail.personalInfo')
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/settings/legal-entities'))
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByText('form.cmu.beneficiaries')).toBeNull()
    expect(screen.queryByText('form.cmu.spouseToVerify')).toBeNull()
  })
})
