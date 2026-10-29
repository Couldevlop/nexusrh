/**
 * Page CNPS — périmètre Côte d'Ivoire en multi-filiales :
 *  - « Valider les données » envoie le mois (périodicité mensuelle) et la filiale ;
 *  - filiale obligatoire pour valider / générer en multi-filiales ;
 *  - filiales hors CI (Burkina, Bénin) proposées désactivées ;
 *  - tuiles de synthèse filtrées sur la filiale choisie ;
 *  - message d'erreur de l'API affiché (plus d'échec silencieux).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  authState: { tenantConfig: { hasSubsidiaries: true } as { hasSubsidiaries: boolean } },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
  formatFCFA: (n: number) => `${n} FCFA`,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: unknown) => (typeof o === 'string' ? o : o ? `${k} ${JSON.stringify(o)}` : k),
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import CnpsPage from './CnpsPage'

const ABJ = '11111111-1111-4111-8111-111111111111'
const BKE = '33333333-3333-4333-8333-333333333333'
const BFA = '22222222-2222-4222-8222-222222222222'
const BEN = '44444444-4444-4444-8444-444444444444'

const ENTITIES = [
  { id: ABJ, name: 'SOTRA Abidjan', cnps_number: 'CI-ABJ', country_code: 'CIV', legislation_pack_code: 'CIV-2024' },
  { id: BKE, name: 'SOTRA Bouaké', cnps_number: 'CI-BKE', country_code: 'CIV', legislation_pack_code: null },
  { id: BFA, name: 'SOTRA Burkina', cnps_number: 'BF-1', country_code: 'BFA', legislation_pack_code: 'BFA-2024' },
  { id: BEN, name: 'SOTRA Bénin', cnps_number: null, country_code: 'BEN', legislation_pack_code: 'BEN-2024' },
]

const VALID_RESULT = {
  valid: true, year: 2026, quarter: 2, employerCnps: 'CI-ABJ', totalPayslips: 12,
  errors: [], warnings: [], summary: { blocking: 0, warnings: 0, message: 'Déclaration prête' },
}

function setup(hasSubsidiaries = true) {
  authState.tenantConfig = { hasSubsidiaries }
  getMock.mockImplementation((url: string) => {
    if (url === '/settings/legal-entities') return Promise.resolve({ data: { data: ENTITIES } })
    if (url === '/cnps/summary') return Promise.resolve({ data: { data: [], totals: { gross: 1000, cnpsSal: 63, cnpsPat: 77, its: 10 }, year: 2026 } })
    if (url.startsWith('/cnps/validate/')) return Promise.resolve({ data: VALID_RESULT })
    return Promise.resolve({ data: { data: [] } })
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CnpsPage />
    </QueryClientProvider>,
  )
}

function validateCalls() {
  return getMock.mock.calls.filter(([url]) => String(url).startsWith('/cnps/validate/'))
}

beforeEach(() => {
  getMock.mockReset()
  postMock.mockReset()
})
afterEach(() => cleanup())

describe('CnpsPage — validateur pré-DSN multi-filiales', () => {
  it('filiales hors CI désactivées avec la mention « non prise en charge »', async () => {
    setup()
    await screen.findByRole('option', { name: /SOTRA Abidjan/ }, { timeout: 5000 })
    const select = screen.getByRole('combobox', { name: 'validator.subsidiary' })
    const byId = (id: string) => select.querySelector(`option[value="${id}"]`) as HTMLOptionElement
    const burkina = byId(BFA)
    const benin = byId(BEN)
    const abidjan = byId(ABJ)
    const bouake = byId(BKE)
    expect(burkina.disabled).toBe(true)
    expect(benin.disabled).toBe(true)
    expect(burkina.textContent).toContain('déclaration non prise en charge pour ce pays')
    expect(abidjan.disabled).toBe(false)
    expect(bouake.disabled).toBe(false)
  })

  it('« Valider » est bloqué tant qu’aucune filiale CI n’est choisie', async () => {
    setup()
    await screen.findByRole('option', { name: /SOTRA Abidjan/ })
    const btn = screen.getByRole('button', { name: /validator.validateData/ })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /validator.generateDeclaration/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('mensuel + filiale : envoie month=AAAA-MM et legalEntityId au validateur', async () => {
    setup()
    await screen.findByRole('option', { name: /SOTRA Abidjan/ })
    fireEvent.click(screen.getByRole('button', { name: 'Mensuelle' }))
    const year = new Date().getFullYear()
    fireEvent.change(screen.getByRole('combobox', { name: 'Mois' }), { target: { value: '5' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'validator.subsidiary' }), { target: { value: ABJ } })
    fireEvent.click(screen.getByRole('button', { name: /validator.validateData/ }))

    await waitFor(() => expect(validateCalls()).toHaveLength(1))
    const [, opts] = validateCalls()[0]!
    expect(opts).toEqual({ params: { month: `${year}-05`, legalEntityId: ABJ } })
    expect(await screen.findByText('Déclaration prête')).toBeTruthy()
  })

  it('trimestriel : pas de month, filiale transmise ; tuiles filtrées sur la filiale', async () => {
    setup()
    await screen.findByRole('option', { name: /SOTRA Bouaké/ })
    fireEvent.change(screen.getByRole('combobox', { name: 'validator.subsidiary' }), { target: { value: BKE } })
    fireEvent.click(screen.getByRole('button', { name: /validator.validateData/ }))
    await waitFor(() => expect(validateCalls()).toHaveLength(1))
    expect(validateCalls()[0]![1]).toEqual({ params: { legalEntityId: BKE } })

    await waitFor(() => {
      const summaryCalls = getMock.mock.calls.filter(([url]) => url === '/cnps/summary')
      expect(summaryCalls.some(([, o]) => (o as { params?: { legalEntityId?: string } })?.params?.legalEntityId === BKE)).toBe(true)
    })
  })

  it('erreur API du validateur affichée à l’utilisateur', async () => {
    setup()
    getMock.mockImplementation((url: string) => {
      if (url === '/settings/legal-entities') return Promise.resolve({ data: { data: ENTITIES } })
      if (url.startsWith('/cnps/validate/')) {
        return Promise.reject({ response: { data: { error: 'Filiale introuvable ou inactive' } } })
      }
      return Promise.resolve({ data: { data: [], totals: {} } })
    })
    await screen.findByRole('option', { name: /SOTRA Abidjan/ })
    fireEvent.change(screen.getByRole('combobox', { name: 'validator.subsidiary' }), { target: { value: ABJ } })
    fireEvent.click(screen.getByRole('button', { name: /validator.validateData/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Filiale introuvable ou inactive')
  })
})

describe('CnpsPage — tenant mono-entité', () => {
  it('valide sans filiale ni chargement des entités ; tuiles sans filtre filiale', async () => {
    setup(false)
    fireEvent.click(screen.getByRole('button', { name: /validator.validateData/ }))
    await waitFor(() => expect(validateCalls()).toHaveLength(1))
    expect(validateCalls()[0]![1]).toEqual({ params: {} })
    expect(getMock.mock.calls.some(([url]) => url === '/settings/legal-entities')).toBe(false)
    const summary = getMock.mock.calls.find(([url]) => url === '/cnps/summary')!
    expect(summary[1]).toEqual({ params: { year: new Date().getFullYear() } })
  })
})
