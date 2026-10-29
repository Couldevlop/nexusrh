/**
 * Page RAF « Paie de ma filiale » — soumission CONTRÔLÉE :
 *   - liste limitée aux périodes-filles du RAF (?scope=raf), jamais la mère ;
 *   - feuille de variables par période, dossiers incomplets listés ;
 *   - Soumettre désactivé tant que readiness.ready=false ;
 *   - erreurs API affichées (message serveur).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, postMock, putMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  authState: { user: { sub: 'u-admin', role: 'admin' } },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: putMock, patch: vi.fn(), delete: vi.fn() },
  formatFCFA: (n: number) => `${n} FCFA`,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('@/components/shared/ConfirmDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && !('defaultValue' in o) ? `${k} ${JSON.stringify(o)}` : k) }),
  Trans: ({ i18nKey, count }: { i18nKey?: string; count?: number }) => `${i18nKey ?? ''}:${count ?? ''}`,
}))

import RafPeriodsPage from './RafPeriodsPage'

const PARENT = '11111111-1111-4111-8111-111111111111'
const CHILD  = '22222222-2222-4222-8222-222222222222'
const EMP    = '44444444-4444-4444-8444-444444444444'

const periods = [
  { id: PARENT, month: '2026-10', status: 'sent_to_sites', legal_entity_id: null, legislation_pack_code: null, parent_period_id: null, total_gross: null, total_net: null, completed_by_site_at: null },
  { id: CHILD, month: '2026-10', status: 'sent_to_sites', legal_entity_id: 'le-1', legislation_pack_code: 'BFA-2024', parent_period_id: PARENT, total_gross: null, total_net: null, completed_by_site_at: null },
]

function sheet(over: { ready?: boolean; missing?: string[]; validated?: boolean } = {}) {
  const validated = over.validated ?? false
  return {
    period: { id: CHILD, month: '2026-10', status: 'sent_to_sites', legislationPackCode: 'BFA-2024' },
    codes: [{ code: 'PRIME_PANIER', label: 'Prime de panier', unit: 'fcfa' }, { code: 'ABSENCE_INJ', label: 'Absences', unit: 'days' }],
    editable: true,
    rows: [{
      id: EMP, name: 'Issa Ouédraogo', missing: over.missing ?? [], values: {},
      validation: validated ? { mode: 'none', validatedAt: null, valid: true } : null, variablesValidated: validated,
    }],
    readiness: {
      smig: 45000, totalEmployees: 1, validatedCount: validated ? 1 : 0, incompleteCount: (over.missing ?? []).length ? 1 : 0,
      dataComplete: !(over.missing ?? []).length, variablesValidated: validated, ready: over.ready ?? false,
    },
  }
}

function setup(sheetData: ReturnType<typeof sheet>, role = 'admin') {
  authState.user = { sub: 'u-admin', role }
  getMock.mockImplementation((url: string) => {
    if (url === '/payroll-workflow/periods') return Promise.resolve({ data: { data: periods } })
    if (url === '/settings/legal-entities') return Promise.resolve({ data: { data: [{ id: 'le-1', name: 'Filiale Ouaga' }] } })
    if (url === `/payroll-workflow/periods/${CHILD}/variables`) return Promise.resolve({ data: { data: sheetData } })
    return Promise.resolve({ data: { data: [] } })
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><RafPeriodsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => { getMock.mockReset(); postMock.mockReset(); putMock.mockReset() })
afterEach(() => cleanup())

describe('RafPeriodsPage', () => {
  it('demande ?scope=raf et n\'affiche jamais la période mère (compteur cohérent)', async () => {
    setup(sheet())
    await screen.findByText('Filiale Ouaga')
    expect(getMock).toHaveBeenCalledWith('/payroll-workflow/periods', { params: { scope: 'raf' } })
    expect(screen.getAllByText('2026-10')).toHaveLength(1)
    expect(screen.getByText('pendingBanner:1')).toBeTruthy()
  })

  it('Soumettre désactivé tant que la readiness n\'est pas verte ; manques listés avec lien fiche (admin)', async () => {
    setup(sheet({ missing: ['cnps_number', 'below_smig'] }))
    fireEvent.click(await screen.findByText('prepare'))
    const submit = await screen.findByRole('button', { name: 'submit' }, { timeout: 4000 })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    const link = screen.getByRole('link', { name: 'Issa Ouédraogo' })
    expect(link.getAttribute('href')).toBe(`/employees/${EMP}`)
    expect(screen.getByText(/missing\.cnps_number/)).toBeTruthy()
    expect(screen.getByText(/sheet\.validatedCounter/).textContent).toContain('"validated":0,"total":1')
  })

  it('RAF site : pas de lien vers la fiche salarié (route non autorisée)', async () => {
    setup(sheet({ missing: ['iban'] }), 'raf_site')
    fireEvent.click(await screen.findByText('prepare'))
    await screen.findByText('sheet.incompleteRafHint')
    expect(screen.queryByRole('link', { name: 'Issa Ouédraogo' })).toBeNull()
  })

  it('validation « aucune variable » d\'une ligne → POST validate', async () => {
    postMock.mockResolvedValue({ data: { data: { valid: true } } })
    setup(sheet())
    fireEvent.click(await screen.findByText('prepare'))
    fireEvent.click(await screen.findByRole('button', { name: 'sheet.validateNone' }))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/payroll-workflow/periods/${CHILD}/variables/${EMP}/validate`, { mode: 'none' }))
  })

  it('saisie d\'une variable → PUT (Enregistrer remplace la validation)', async () => {
    putMock.mockResolvedValue({ data: { data: {} } })
    setup(sheet())
    fireEvent.click(await screen.findByText('prepare'))
    const input = await screen.findByLabelText('Issa Ouédraogo — codes.PRIME_PANIER')
    fireEvent.change(input, { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: 'sheet.save' }))
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(
      `/payroll-workflow/periods/${CHILD}/variables/${EMP}`, { values: { PRIME_PANIER: 5000, ABSENCE_INJ: 0 } },
    ))
  })

  it('prête → Soumettre actif ; erreur API affichée proprement', async () => {
    postMock.mockRejectedValue({ response: { data: { error: 'Soumission impossible : 1 salarié(s) …' } } })
    setup(sheet({ ready: true, validated: true }))
    fireEvent.click(await screen.findByText('prepare'))
    const submit = await screen.findByRole('button', { name: 'submit' }, { timeout: 4000 })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Soumission impossible')
    expect(postMock).toHaveBeenCalledWith(`/payroll-workflow/periods/${CHILD}/submit-by-raf`)
  })
})
