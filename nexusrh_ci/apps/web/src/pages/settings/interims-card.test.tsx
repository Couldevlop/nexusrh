/**
 * Carte « Intérims de validation » — l'écran part des CONGÉS.
 *
 * Ce que ce banc tient : les congés de valideurs non couverts remontent et
 * sont signalés, désigner un suppléant n'exige AUCUNE saisie de date (le
 * serveur reprend celles du congé), et la liste des suppléances dit d'où
 * viennent les bornes. C'est là que l'intérim cesse de ressembler à une
 * délégation d'habilitation, qu'on borne à la main.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InterimsCard from './InterimsCard'

const get = vi.fn()
const post = vi.fn()
const del = vi.fn()
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: (...a: unknown[]) => del(...a) } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Les libellés sont vérifiés ailleurs : ici on teste le comportement.
    t: (k: string, o?: Record<string, unknown>) =>
      (o && 'defaultValue' in o ? String(o.defaultValue) : k) + (o?.count !== undefined ? ` ${o.count}` : ''),
    i18n: { language: 'fr' },
  }),
}))

const COVERAGE = [
  { absenceId: 'a1', startDate: '2026-12-01', endDate: '2026-12-20', status: 'approved',
    userId: 'u-drh', role: 'hr_manager', name: 'Awa Koné', covered: false },
  { absenceId: 'a2', startDate: '2026-12-05', endDate: '2026-12-10', status: 'approved',
    userId: 'u-chef', role: 'manager', name: 'Bakary Touré', covered: true },
]
const USERS = [
  { id: 'u-gest', first_name: 'Mariam', last_name: 'Diallo', role: 'hr_officer', is_active: true },
  { id: 'u-drh', first_name: 'Awa', last_name: 'Koné', role: 'hr_manager', is_active: true },
  { id: 'u-off', first_name: 'Inactif', last_name: 'X', role: 'hr_officer', is_active: false },
]
const INTERIMS = [
  { id: 'i1', absentUserId: 'u-drh', interimUserId: 'u-gest', absentName: 'Awa Koné',
    interimName: 'Mariam Diallo', absentRole: 'hr_manager', interimRole: 'hr_officer',
    startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-20T23:59:59.999Z',
    reason: null, revokedAt: null, active: true, absenceId: 'a1', source: 'absence' as const },
]

function routes(over: Record<string, unknown> = {}) {
  get.mockImplementation(async (url: string) => {
    if (url.includes('coverage')) return { data: { data: over.coverage ?? COVERAGE } }
    if (url.includes('/settings/users')) return { data: { data: USERS } }
    return { data: { data: over.interims ?? [] } }
  })
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><InterimsCard /></QueryClientProvider>)
}

afterEach(() => { cleanup() })
beforeEach(() => { vi.clearAllMocks(); routes(); post.mockResolvedValue({ data: { data: {} } }); del.mockResolvedValue({ data: {} }) })

describe('Congés des valideurs', () => {
  it('signale les congés sans suppléant, et seulement ceux-là', async () => {
    mount()
    expect(await screen.findByText(/uncoveredWarning 1/)).toBeTruthy()
    expect(screen.getByText('Awa Koné')).toBeTruthy()
    // Le congé déjà couvert n'ouvre aucun bouton de désignation.
    expect(screen.getAllByRole('button', { name: 'workflow.interims.designate' })).toHaveLength(1)
    expect(screen.getByText('workflow.interims.covered')).toBeTruthy()
  })

  it('n’alerte pas quand tout est couvert', async () => {
    routes({ coverage: [{ ...COVERAGE[1] }] })
    mount()
    await screen.findByText('Bakary Touré')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('Désigner un suppléant', () => {
  it('envoie le congé, sans aucune date — et jamais la personne remplacée comme suppléant', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'workflow.interims.designate' }))

    const select = screen.getByLabelText('workflow.interims.standIn')
    const options = Array.from(select.querySelectorAll('option')).map(o => (o as HTMLOptionElement).value)
    // L'absente elle-même et le compte désactivé sont hors liste.
    expect(options).toEqual(['', 'u-gest'])

    await userEvent.selectOptions(select, 'u-gest')
    await userEvent.click(screen.getByRole('button', { name: 'workflow.interims.declare' }))

    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith('/settings/interims', {
      absentUserId: 'u-drh', interimUserId: 'u-gest', absenceId: 'a1',
    })
    // Aucune date n'est transmise : elles viennent du congé, côté serveur.
    const payload = post.mock.calls[0]![1] as Record<string, unknown>
    expect(payload).not.toHaveProperty('endsAt')
    expect(payload).not.toHaveProperty('startsAt')
  })

  it('affiche le refus du serveur tel quel', async () => {
    post.mockRejectedValue({ response: { data: { error: 'Le suppléant est lui-même remplacé en ce moment' } } })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'workflow.interims.designate' }))
    await userEvent.selectOptions(screen.getByLabelText('workflow.interims.standIn'), 'u-gest')
    await userEvent.click(screen.getByRole('button', { name: 'workflow.interims.declare' }))
    expect(await screen.findByText(/lui-même remplacé/)).toBeTruthy()
  })

  it('n’enregistre rien tant qu’aucun suppléant n’est choisi', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'workflow.interims.designate' }))
    expect((screen.getByRole('button', { name: 'workflow.interims.declare' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Suppléances enregistrées', () => {
  it('dit qui remplace qui, d’où viennent les dates, et se révoque', async () => {
    routes({ interims: INTERIMS })
    mount()
    expect(await screen.findByText('Mariam Diallo')).toBeTruthy()
    expect(screen.getByText(/workflow.interims.sourceLeave/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'workflow.interims.revokeAction' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/settings/interims/i1'))
  })

  it('un intérim révoqué ne propose plus de révocation', async () => {
    routes({ interims: [{ ...INTERIMS[0], active: false, revokedAt: '2026-12-02T00:00:00.000Z' }] })
    mount()
    await screen.findByText('workflow.interims.revoked')
    expect(screen.queryByRole('button', { name: 'workflow.interims.revokeAction' })).toBeNull()
  })
})
