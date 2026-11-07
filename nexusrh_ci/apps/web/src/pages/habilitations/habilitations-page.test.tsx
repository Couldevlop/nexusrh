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

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn(), patchMock: vi.fn(), deleteMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock, put: vi.fn() },
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

interface AuditRow {
  id: string; created_at: string; action: string; entity: string; entity_id: string | null
  changes: Record<string, unknown>; email: string; role: string
  subgroup_name: string | null; employee_number: string | null
}
interface Delegation {
  id: string; delegator_id: string; delegate_id: string; subgroup_id: string | null
  starts_at: string; ends_at: string; revoked_at: string | null; active: boolean
}
interface State {
  enforced: boolean
  ficheStatus: string
  sodAlerts: Array<{ ruleId: string; label: string }>
  delegations: Delegation[]
  auditRows: AuditRow[]
}
let state: State
let lastAuditParams: Record<string, string> = {}

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
  lastAuditParams = {}
  state = {
    enforced: true, ficheStatus: 'n1', sodAlerts: [],
    delegations: [{
      id: 'd-1', delegator_id: 'u-admin', delegate_id: 'u-rh', subgroup_id: SIEGE,
      starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z',
      revoked_at: null, active: true,
    }],
    auditRows: [{
      id: 'a-1', created_at: '2026-11-04T09:00:00.000Z', action: 'hr.employees.view',
      entity: 'employees', entity_id: null,
      changes: { result: 'denied_scope', route: '/employees' },
      email: 'rh@sotra.ci', role: 'hr_officer', subgroup_name: 'Filiale Nord', employee_number: 'MAT00084',
    }],
  }
  getMock.mockReset()
  postMock.mockReset().mockResolvedValue({ data: { data: {} } })
  patchMock.mockReset().mockResolvedValue({ data: { data: {} } })
  deleteMock.mockReset().mockResolvedValue({ data: { data: {} } })
  getMock.mockImplementation(async (url: string, opts?: { params?: Record<string, unknown> }) => {
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
    if (url.startsWith('/habilitations/delegations')) {
      return { data: { data: state.delegations } }
    }
    if (url.startsWith('/habilitations/audit')) {
      lastAuditParams = (opts?.params ?? {}) as Record<string, string>
      return { data: { data: state.auditRows, page: 1, pageSize: 100 } }
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
  it('liste les délégations et permet de les révoquer', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.delegations'))
    // L'adresse figure aussi dans le choix du délégataire du formulaire :
    // la ligne de la LISTE est ciblée par son bouton de révocation.
    const revoke = await screen.findByText('delegations.revoke')
    expect(revoke.closest('li')?.textContent).toMatch(/rh@sotra\.ci|u-rh/)
    fireEvent.click(revoke)
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/habilitations/delegations/d-1'))
  })

  it('le dit quand aucune délégation n\'est en cours', async () => {
    state.delegations = []
    renderPage()
    fireEvent.click(await screen.findByText('tabs.delegations'))
    expect(await screen.findByText('delegations.empty')).toBeTruthy()
  })
})

describe('Onglet Piste d\'audit', () => {
  it('montre l\'action, la personne, le sous-groupe, le matricule et le résultat', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.audit'))
    expect(await screen.findByText('hr.employees.view')).toBeTruthy()
    expect(screen.getByText('rh@sotra.ci')).toBeTruthy()
    expect(screen.getByText('Filiale Nord')).toBeTruthy()
    expect(screen.getByText('MAT00084')).toBeTruthy()
    // Le libellé figure aussi dans le filtre : la CELLULE du tableau est ciblée.
    expect(screen.getByRole('cell', { name: /audit.results.denied_scope/ })).toBeTruthy()
  })

  it('le filtre « Accès refusés » interroge le serveur avec result=denied', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.audit'))
    await screen.findByText('hr.employees.view')
    fireEvent.change(screen.getByLabelText('audit.filters.result'), { target: { value: 'denied' } })
    await waitFor(() => expect(lastAuditParams.result).toBe('denied'))
  })

  it('le filtre matricule est transmis au serveur', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.audit'))
    await screen.findByText('hr.employees.view')
    fireEvent.change(screen.getByLabelText('audit.filters.matricule'), { target: { value: 'MAT00084' } })
    await waitFor(() => expect(lastAuditParams.matricule).toBe('MAT00084'))
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

describe('Rédiger une fiche (circuit inatteignable sans cet écran)', () => {
  it('crée la fiche pour le collaborateur choisi, dans le sous-groupe choisi', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('fiche.new'))
    fireEvent.change(await screen.findByLabelText('fiche.form.subgroup'), { target: { value: SIEGE } })
    fireEvent.change(screen.getByLabelText('fiche.form.target'), { target: { value: 'u-rh' } })
    fireEvent.change(screen.getByLabelText('fiche.form.motive'), { target: { value: 'Prise de poste' } })
    fireEvent.click(screen.getByLabelText('employees:view'))
    fireEvent.click(screen.getByText('fiche.form.submit'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/habilitations/fiches', {
      targetUserId: 'u-rh', subgroupId: SIEGE, permissions: ['employees:view'],
      motive: 'Prise de poste', kind: 'grant',
    }))
  })

  it('la grille du formulaire est bornée au plafond du sous-groupe', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('fiche.new'))
    fireEvent.change(await screen.findByLabelText('fiche.form.subgroup'), { target: { value: SIEGE } })
    // Hors plafond du sous-groupe « RH Siège » : la case existe mais reste fermée.
    expect((screen.getByLabelText('payroll:close') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('employees:view') as HTMLInputElement).disabled).toBe(false)
  })

  it('refuse d\'envoyer sans collaborateur ni sous-groupe', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.fiches'))
    fireEvent.click(await screen.findByText('fiche.new'))
    fireEvent.click(await screen.findByText('fiche.form.submit'))
    expect(postMock).not.toHaveBeenCalledWith('/habilitations/fiches', expect.anything())
  })
})

describe('Donner une délégation (sinon on ne peut que révoquer)', () => {
  it('crée la procuration avec le délégataire et la date de fin', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.delegations'))
    fireEvent.change(await screen.findByLabelText('delegations.form.delegate'), { target: { value: 'u-rh' } })
    fireEvent.change(screen.getByLabelText('delegations.form.endsAt'), { target: { value: '2026-12-01' } })
    fireEvent.click(screen.getByText('delegations.form.submit'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/habilitations/delegations', {
      delegateId: 'u-rh', endsAt: '2026-12-01',
    }))
  })

  it('borne la date de fin à 90 jours, comme le serveur', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('tabs.delegations'))
    const input = await screen.findByLabelText('delegations.form.endsAt') as HTMLInputElement
    const max = new Date(input.max).getTime() - Date.now()
    expect(Math.round(max / 86_400_000)).toBeLessThanOrEqual(90)
    expect(Math.round(max / 86_400_000)).toBeGreaterThan(88)
  })
})
