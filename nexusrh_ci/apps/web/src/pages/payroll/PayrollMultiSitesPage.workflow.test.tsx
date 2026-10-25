/**
 * Paie multi-filiales — circuit de validation nominatif (mêmes règles que la
 * paie mono-entité). La consolidation initie le circuit ; la paie consolidée
 * nomme son valideur attendu et son échéance ; la modale du circuit (historique
 * des niveaux, Valider / Rejeter / Annuler) est pilotée par l'objet `viewer`
 * renvoyé par l'API ; « Mes validations » l'ouvre via ?validate=<id parente>.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, postMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  authState: { user: { sub: 'u-paie', role: 'hr_officer' }, tenantConfig: { hasSubsidiaries: true } },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatMonth: (m: string) => m,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import PayrollMultiSitesPage from './PayrollMultiSitesPage'

const PARENT = '11111111-1111-4111-8111-111111111111'
const PENDING_WITH = {
  level: 1, requiredLevels: 2, userId: 'u-paie', name: 'Yao Brou', functionLabel: 'Chef de service paie',
  role: 'hr_officer', dueAt: '2026-10-27T10:00:00.000Z', overdue: false, teamCanAct: false,
}

function periodRow(over: Record<string, unknown>) {
  return {
    id: PARENT, month: '2026-10', status: 'validated_central', parent_period_id: null, legal_entity_id: null,
    legal_entity_name: null, legislation_pack_code: null, raf_user_id: null,
    total_gross: '500000', total_net: '450000', total_cnps: null, total_its: null,
    sent_to_sites_at: null, completed_by_site_at: null, validated_central_at: null, closed_at: null,
    rejection_reason: null, pending_with: PENDING_WITH, ...over,
  }
}
const child = (id: string, status: string) => periodRow({
  id, parent_period_id: PARENT, legal_entity_name: `Filiale ${id}`, status, pending_with: undefined, raf_user_id: 'u-raf',
})

function workflowState(viewer: Record<string, unknown>) {
  return {
    period: { id: PARENT, month: '2026-10', status: 'validated_central', initiatedBy: 'u-init', initiatedAt: '2026-10-25T10:00:00Z', initiatorName: 'Awa Koné' },
    requiredLevels: 2, currentLevel: 0, isComplete: false, approvals: [],
    levels: [
      { level: 1, status: 'current', validator: { userId: 'u-paie', name: 'Yao Brou', role: 'hr_officer', available: true }, functionLabel: 'Chef de service paie', slaDays: 2, dueAt: PENDING_WITH.dueAt, overdue: false, teamCanAct: false, approval: null },
      { level: 2, status: 'upcoming', validator: { userId: 'u-drh', name: 'Fanta Traoré', role: 'hr_manager', available: true }, functionLabel: 'DRH', slaDays: 2, dueAt: null, overdue: false, teamCanAct: false, approval: null },
    ],
    pendingWith: PENDING_WITH,
    viewer: { canApprove: false, canReject: false, canCancel: false, escalated: false, deniedReason: null, deniedMessage: null, ...viewer },
  }
}

function setup(opts: { viewer?: Record<string, unknown>; user?: { sub: string; role: string }; periods?: unknown[]; url?: string } = {}) {
  authState.user = opts.user ?? { sub: 'u-paie', role: 'hr_officer' }
  getMock.mockImplementation((url: string) => {
    if (url === '/payroll-workflow/periods') {
      return Promise.resolve({ data: { data: opts.periods ?? [periodRow({}), child('c1', 'validated_central'), child('c2', 'validated_central')] } })
    }
    if (url === `/payroll-workflow/periods/${PARENT}/workflow`) return Promise.resolve({ data: workflowState(opts.viewer ?? {}) })
    return Promise.resolve({ data: { data: { period: { month: '2026-10', status: 'x' }, totalSites: 0, events: [] } } })
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.url ?? '/payroll/multi-filiales']}>
        <PayrollMultiSitesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset()
  postMock.mockReset().mockResolvedValue({ data: { data: { status: 'sent_to_sites' } } })
})
afterEach(() => cleanup())

describe('PayrollMultiSitesPage — circuit de validation nominatif', () => {
  it('paie consolidée : valideur attendu, niveau et échéance affichés sur la période parente', async () => {
    setup()
    expect(await screen.findByText(/history\.pendingWith.*Yao Brou.*Chef de service paie/)).toBeTruthy()
    expect(screen.getByText(/history\.levelProgress.*"level":1.*"total":2/)).toBeTruthy()
    expect(screen.getByText(/history\.dueAt/)).toBeTruthy()
    // L'ancien bouton « Clôturer la paie » (sans circuit) a disparu au profit du circuit
    expect(screen.queryByText('multiSites.closePayroll')).toBeNull()
    expect(screen.getByText('multiSites.openCircuit')).toBeTruthy()
  })

  it('?validate=<id parente> ouvre la modale : valideur attendu, niveaux nommés, échéance', async () => {
    setup({ viewer: { canApprove: true, canReject: true }, url: `/payroll/multi-filiales?validate=${PARENT}` })
    expect(await screen.findByText(/workflow\.expectedValidator.*Yao Brou/)).toBeTruthy()
    expect(screen.getByText(/workflow\.levelDesignated.*DRH.*Fanta Traoré/)).toBeTruthy()
    expect(screen.getByText(/workflow\.dueAt/)).toBeTruthy()
    expect(screen.getByText('multiSites.workflow.initiated')).toBeTruthy()
  })

  it('valideur : approbation du niveau sur la période parente', async () => {
    setup({ viewer: { canApprove: true, canReject: true }, url: `/payroll/multi-filiales?validate=${PARENT}` })
    fireEvent.click(await screen.findByText(/workflow\.approveLevel/))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/payroll-workflow/periods/${PARENT}/approve`, {}))
  })

  it('valideur : renvoi en préparation avec commentaire obligatoire (≥ 10 caractères)', async () => {
    setup({ viewer: { canApprove: true, canReject: true }, url: `/payroll/multi-filiales?validate=${PARENT}` })
    fireEvent.click(await screen.findByText('workflow.reject'))
    expect(screen.getByText('multiSites.workflow.rejectHint')).toBeTruthy()
    const confirm = screen.getByText('workflow.confirmReject').closest('button')!
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('workflow.rejectReasonLabel'), { target: { value: 'court' } })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('workflow.rejectReasonLabel'), { target: { value: 'Écart CNPS sur la filiale 2' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/payroll-workflow/periods/${PARENT}/reject`, { reason: 'Écart CNPS sur la filiale 2' }))
    expect(await screen.findByText('multiSites.workflow.rejectedNotice')).toBeTruthy()
  })

  it('initiateur : « Annuler l’initiation » seulement (SoD), sur la période parente', async () => {
    setup({ viewer: { canCancel: true, deniedReason: 'initiator' }, user: { sub: 'u-init', role: 'hr_manager' }, url: `/payroll/multi-filiales?validate=${PARENT}` })
    expect(await screen.findByText('workflow.sodInitiator')).toBeTruthy()
    expect(screen.queryByText('workflow.reject')).toBeNull()
    expect(screen.queryByText(/workflow\.approveLevel/)).toBeNull()
    fireEvent.click(screen.getByText('workflow.cancelInitiation'))
    fireEvent.click(screen.getByText('workflow.confirmCancel'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/payroll-workflow/periods/${PARENT}/cancel`, {}))
  })

  it('membre RH non désigné : attente du valideur, aucune action', async () => {
    setup({ viewer: { deniedReason: 'awaiting_designated' }, user: { sub: 'u-admin', role: 'admin' }, url: `/payroll/multi-filiales?validate=${PARENT}` })
    expect(await screen.findByText(/workflow\.sodAwaitingDesignated.*Yao Brou/)).toBeTruthy()
    expect(screen.queryByText('workflow.reject')).toBeNull()
    expect(screen.queryByText('workflow.cancelInitiation')).toBeNull()
  })

  it('hr_officer (valideur) : consultation, aucune action de pilotage central', async () => {
    setup()
    await screen.findByText('multiSites.openCircuit')
    expect(screen.queryByText('multiSites.initDraft')).toBeNull()
  })

  it('consolidation par la RH centrale : message nommant le valideur attendu', async () => {
    postMock.mockResolvedValueOnce({ data: { data: { id: PARENT, status: 'validated_central' }, pendingWith: PENDING_WITH } })
    setup({
      user: { sub: 'u-init', role: 'hr_manager' },
      periods: [periodRow({ status: 'sent_to_sites', pending_with: undefined }), child('c1', 'completed_by_site'), child('c2', 'completed_by_site')],
    })
    fireEvent.click(await screen.findByText('multiSites.consolidate'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/payroll-workflow/periods/${PARENT}/validate-central`))
    const msg = await screen.findByText(/close\.pendingWithNamed.*Yao Brou.*Chef de service paie/)
    expect(msg.textContent).not.toMatch(/POST|\/payroll/)
  })

  it('paie renvoyée en préparation : motif affiché sur la période parente', async () => {
    setup({
      user: { sub: 'u-init', role: 'hr_manager' },
      periods: [periodRow({ status: 'sent_to_sites', pending_with: undefined, rejection_reason: 'Écart CNPS sur la filiale 2' }), child('c1', 'sent_to_sites')],
    })
    expect(await screen.findByText(/multiSites\.rejected.*Écart CNPS sur la filiale 2/)).toBeTruthy()
  })
})
