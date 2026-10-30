/**
 * Audit de conformité — multi-filiales :
 *  - sélecteur de filiale (multi-filiales seulement) → ?legalEntityId ;
 *  - ventilation par filiale + bouton « Auditer » ;
 *  - filiale hors CI : mention « contrôles CNPS non applicables » ;
 *  - SMIG des paramètres issu de l'API (pack), plus de 75 000 / 60 000 en dur.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  authState: { tenantConfig: { hasSubsidiaries: true } as { hasSubsidiaries: boolean } },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: unknown) => {
      if (typeof o === 'string') return o
      if (o && typeof o === 'object' && 'defaultValue' in o) return `${k} ${JSON.stringify(o)}`
      return o ? `${k} ${JSON.stringify(o)}` : k
    },
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import CnpsAuditPage from './CnpsAuditPage'

const ABJ = '11111111-1111-4111-8111-111111111111'
const BFA = '22222222-2222-4222-8222-222222222222'
const ENTITIES = [
  { id: ABJ, name: 'SOTRA Abidjan', country_code: 'CIV', legislation_pack_code: 'CIV-2024' },
  { id: BFA, name: 'SOTRA Burkina', country_code: 'BFA', legislation_pack_code: 'BFA-2024' },
]

function audit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    year: 2026, scoreConformite: 70, statut: 'non_conforme',
    resume: { bloquants: 2, avertissements: 0, totalEmployes: 2, nbSansNni: 0, nbSansCnps: 1, nbSousSmig: 1, nbSansMobile: 0 },
    smigReference: 75000, currency: 'XOF', anomalies: [], recommandations: [],
    generatedAt: new Date().toISOString(), cnpsApplicable: true, legislationPackCode: 'CIV-2024',
    ...over,
  }
}

const FILIALES = [
  { legalEntityId: ABJ, name: 'SOTRA Abidjan', countryCode: 'CIV', legislationPackCode: 'CIV-2024', currency: 'XOF',
    cnpsApplicable: true, smigReference: 75000, totalEmployes: 1, nbSansNni: 0, nbSansCnps: 1, nbSousSmig: 1,
    masseSalariale: 600000, bloquants: 2, avertissements: 0 },
  { legalEntityId: BFA, name: 'SOTRA Burkina', countryCode: 'BFA', legislationPackCode: 'BFA-2024', currency: 'XOF',
    cnpsApplicable: false, smigReference: 45000, totalEmployes: 1, nbSansNni: 0, nbSansCnps: 0, nbSousSmig: 0,
    masseSalariale: 600000, bloquants: 0, avertissements: 0 },
]

function setup(hasSubsidiaries = true) {
  authState.tenantConfig = { hasSubsidiaries }
  getMock.mockImplementation((url: string, opts?: { params?: { legalEntityId?: string } }) => {
    if (url === '/settings/legal-entities') return Promise.resolve({ data: { data: ENTITIES } })
    if (url === '/cnps/audit-conformite') {
      const le = opts?.params?.legalEntityId
      if (le === BFA) {
        return Promise.resolve({ data: audit({
          legalEntityId: BFA, legalEntityName: 'SOTRA Burkina', cnpsApplicable: false,
          legislationPackCode: 'BFA-2024', smigReference: 45000, plafonds: null,
        }) })
      }
      return Promise.resolve({ data: audit(hasSubsidiaries ? { filiales: FILIALES } : {}) })
    }
    return Promise.resolve({ data: {} })
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CnpsAuditPage />
    </QueryClientProvider>,
  )
}

function auditCalls() {
  return getMock.mock.calls.filter(([url]) => url === '/cnps/audit-conformite')
}

beforeEach(() => getMock.mockReset())
afterEach(() => cleanup())

describe('CnpsAuditPage — multi-filiales', () => {
  it('vue tenant : ventilation par filiale, puis « Auditer » une filiale → ?legalEntityId', async () => {
    setup()
    expect(await screen.findByText('Ventilation par filiale')).toBeTruthy()
    expect(auditCalls()[0]![1]).toEqual({ params: expect.not.objectContaining({ legalEntityId: expect.anything() }) })
    expect(screen.getAllByText('SOTRA Burkina').length).toBeGreaterThan(0)

    await screen.findByRole('option', { name: 'SOTRA Burkina' })
    const buttons = screen.getAllByRole('button', { name: 'Auditer' })
    fireEvent.click(buttons[1]!)

    await waitFor(() => {
      expect(auditCalls().some(([, o]) => (o as { params: { legalEntityId?: string } }).params.legalEntityId === BFA)).toBe(true)
    })
    // Filiale hors CI : contrôles CNPS signalés non applicables
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('audit.scope.nonCiv')
    expect(note.textContent).toContain('BFA-2024')
  })

  it('le sélecteur de filiale transmet legalEntityId', async () => {
    setup()
    await screen.findByRole('option', { name: 'SOTRA Abidjan' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filiale' }), { target: { value: ABJ } })
    await waitFor(() => {
      expect(auditCalls().some(([, o]) => (o as { params: { legalEntityId?: string } }).params.legalEntityId === ABJ)).toBe(true)
    })
  })

  it('paramètres : SMIG du pack renvoyé par l’API (pas de 75 000 / 60 000 en dur)', async () => {
    setup()
    await screen.findByRole('option', { name: 'SOTRA Burkina' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filiale' }), { target: { value: BFA } })
    await screen.findByRole('note')
    fireEvent.click(screen.getByRole('button', { name: 'audit.tabs.params' }))
    expect(await screen.findByText(/audit\.params\.checkSmigDesc .*45.000 FCFA/)).toBeTruthy()
  })
})

describe('CnpsAuditPage — mono-entité', () => {
  it('ni sélecteur ni chargement des filiales ; pas de ventilation', async () => {
    setup(false)
    await waitFor(() => expect(auditCalls()).toHaveLength(1))
    expect(getMock.mock.calls.some(([url]) => url === '/settings/legal-entities')).toBe(false)
    expect(screen.queryByRole('combobox', { name: 'Filiale' })).toBeNull()
    expect(screen.queryByText('Ventilation par filiale')).toBeNull()
  })
})
