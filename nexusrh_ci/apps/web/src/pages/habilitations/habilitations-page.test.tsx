/**
 * Écran Habilitations — structure, fiches, aperçu.
 *
 * Ce banc protège trois décisions qui se perdraient facilement à l'usage :
 *  - une fiche verrouillée ne se modifie plus (la signature des validateurs
 *    vaut pour ce qui a été verrouillé, pas pour une version ultérieure) ;
 *  - un cumul sensible exige une prise de connaissance explicite avant de
 *    valider — pas une simple ligne d'avertissement qu'on survole ;
 *  - tant que le contrôle par la grille n'est pas activé pour le client, la
 *    page le dit : sinon un admin croit avoir retiré un droit alors que rien
 *    n'est appliqué.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, postMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn(), patchMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, delete: vi.fn(), put: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({
    user: { sub: 'u-admin', role: 'admin', firstName: 'A', lastName: 'D' },
    habPermissions: null,
  }),
}))

import HabilitationsPage from './HabilitationsPage'

const SIEGE = '22222222-2222-4222-8222-222222222222'
const FICHE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

interface State { enforced: boolean; ficheStatus: string; sodAlerts: Array<{ ruleId: string; label: string }> }
let state: State

function structure() {
  return {
    data: {
      enforced: state.enforced,
      siegeEmployeeCount: 12,
      groups: [{
        id: 'g1', name: 'DRH Groupe',
        subgroups: [{
          id: SIEGE, name: 'RH Siège', kind: 'siege', legalEntityId: null, legalEntityName: null,
          ceiling: ['employees:view', 'employees:create', 'payroll:validate', 'payments:pay', 'sensitive_data'],
          members: [{ userId: 'u-rh', email: 'rh@sotra.ci', firstName: 'Awa', lastName: 'Koné', role: 'hr_manager', source: 'reprise', revokedAt: null, permissions: ['employees:view'] }],
        }],
      }],
    },
  }
}

function fiches() {
  return {
    data: [{
      id: FICHE, number: 'HAB-2026-0001', status: state.ficheStatus, target_user_id: 'u-rh',
      subgroup_id: SIEGE, permissions: ['employees:view', 'payroll:validate'], kind: 'grant',
      n1_user_id: 'u-admin', n2_user_id: 'u-n2', created_by: 'u-admin',
      sod_alerts: state.sodAlerts, motive: 'Prise de poste', effective_from: null, rejected_reason: null,
    }],
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><HabilitationsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state = { enforced: true, ficheStatus: 'n1', sodAlerts: [] }
  getMock.mockReset()
  postMock.mockReset().mockResolvedValue({ data: { data: {} } })
  patchMock.mockReset().mockResolvedValue({ data: { data: {} } })
  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/habilitations/structure')) return { data: structure() }
    if (url.startsWith('/habilitations/fiches/')) return { data: { data: { fiche: fiches().data[0], events: [] } } }
    if (url.startsWith('/habilitations/fiches')) return { data: fiches() }
    if (url.startsWith('/habilitations/templates')) return { data: { data: [] } }
    if (url.startsWith('/habilitations/preview/')) {
      return { data: { data: { userId: 'u-rh', enforced: true, hasAssignment: true, kind: 'siege', permissions: ['employees:view'], allEntities: false, sensitive: false, manageHabilitations: false, maskedFields: ['base_salary'], scope: { allEntities: false, includesNoEntity: true, entityIds: [], entities: [] } } } }
    }
    if (url.startsWith('/habilitations/takeover-report')) {
      return { data: { data: { enforced: state.enforced, assignments: [{ source: 'reprise', count: 4, withoutPermissions: 0 }], usersWithoutAssignment: 1, subgroupCount: 2 } } }
    }
    if (url.startsWith('/employees')) return { data: { data: [] } }
    return { data: { data: [] } }
  })
})
afterEach(() => cleanup())

describe('Onglet Structure', () => {
  it('affiche le groupe, le sous-groupe et le compteur du siège', async () => {
    renderPage()
    expect(await screen.findByText('DRH Groupe')).toBeTruthy()
    expect(screen.getByText('RH Siège')).toBeTruthy()
    expect(screen.getAllByText(/12/).length).toBeGreaterThan(0)
  })

  it('prévient quand le contrôle par la grille n\'est pas activé', async () => {
    state.enforced = false
    renderPage()
    expect(await screen.findByText(/notEnforced/)).toBeTruthy()
  })

  it('ne prévient pas quand le contrôle est activé', async () => {
    renderPage()
    await screen.findByText('DRH Groupe')
    expect(screen.queryByText(/notEnforced/)).toBeNull()
  })
})

describe('Onglet Fiches', () => {
  it('une fiche verrouillée est en lecture seule', async () => {
    state.ficheStatus = 'locked'
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('HAB-2026-0001'))
    const box = await screen.findByLabelText('employees:view') as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(screen.queryByText('actions.save')).toBeNull()
  })

  it('une fiche à l\'étape N+1 est modifiable par son validateur', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('HAB-2026-0001'))
    const box = await screen.findByLabelText('employees:view') as HTMLInputElement
    expect(box.disabled).toBe(false)
    expect(screen.getByText('actions.save')).toBeTruthy()
  })

  it('un cumul sensible exige la prise de connaissance avant de valider', async () => {
    state.sodAlerts = [{ ruleId: 'r1', label: 'Valider la paie et payer' }]
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('HAB-2026-0001'))
    expect(await screen.findByText(/Valider la paie et payer/)).toBeTruthy()
    const validate = screen.getByText('actions.validate').closest('button') as HTMLButtonElement
    expect(validate.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('fiche.acceptSod'))
    expect((screen.getByText('actions.validate').closest('button') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('actions.validate'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/habilitations/fiches/${FICHE}/validate`, { acceptSod: true }))
  })

  it('sans cumul, la validation ne demande aucune case', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('HAB-2026-0001'))
    expect(screen.queryByLabelText('fiche.acceptSod')).toBeNull()
    const validate = screen.getByText('actions.validate').closest('button') as HTMLButtonElement
    expect(validate.disabled).toBe(false)
  })

  it('le PDF se télécharge depuis la fiche (flux authentifié, pas un lien nu)', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fiche'), revokeObjectURL: vi.fn() })
    getMock.mockImplementation(async (url: string, opts?: Record<string, unknown>) => {
      if (url.endsWith('/pdf')) return { data: new Blob(['%PDF'], { type: 'application/pdf' }), config: opts }
      if (url.startsWith('/habilitations/structure')) return { data: structure() }
      if (url.startsWith('/habilitations/fiches')) return { data: fiches() }
      return { data: { data: [] } }
    })
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('HAB-2026-0001'))
    fireEvent.click(await screen.findByText('actions.pdf'))
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(
      `/habilitations/fiches/${FICHE}/pdf`, { responseType: 'blob' },
    ))
  })
})

describe('Onglet Délégations', () => {
  it('existe, même vide', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.delegations'))
    expect(await screen.findByText('delegations.empty')).toBeTruthy()
  })
})

describe('Aperçu « Ce que voit X »', () => {
  it('montre le périmètre et les champs masqués du membre', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('preview.open'))
    expect(await screen.findByText(/masked/)).toBeTruthy()
    expect(getMock).toHaveBeenCalledWith('/habilitations/preview/u-rh')
  })
})
