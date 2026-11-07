/**
 * Page signature : erreurs d'action affichées (plus d'échec silencieux) et
 * email non conforme d'un employé jamais pré-rempli.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SignaturePage from './SignaturePage'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock, delete: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: 'admin' } }),
}))
vi.mock('@/components/shared/ConfirmDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }))

const DRAFT = { id: 'r1', title: 'Contrat', document_type: 'contract', status: 'draft', signatory_count: 1, signed_count: 0, expires_at: null, created_at: '2026-10-30T00:00:00Z' }
const EMPS = [
  { id: 'e1', first_name: 'Serge', last_name: 'Dème', email: 'serge.dème@email.com' },
  { id: 'e2', first_name: 'Awa', last_name: 'Koné', email: 'awa.kone@email.com' },
]

beforeEach(() => {
  vi.clearAllMocks()
  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/employees')) return { data: { data: EMPS } }
    if (url === '/signature/requests') return { data: { data: [DRAFT] } }
    return { data: { data: [] } }
  })
})
afterEach(() => { cleanup() })

const wrap = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SignaturePage />
  </QueryClientProvider>,
)

describe('SignaturePage', () => {
  it('affiche le message de l’API quand l’envoi est refusé', async () => {
    postMock.mockRejectedValue({ response: { data: { error: 'Email du signataire invalide' } } })
    wrap()
    fireEvent.click(await screen.findByText('requests.send'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Email du signataire invalide'))
  })

  it('texte de repli quand l’API ne renvoie aucun message', async () => {
    postMock.mockRejectedValue(new Error('réseau'))
    wrap()
    fireEvent.click(await screen.findByText('requests.send'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('errors.generic'))
  })

  it('employé à email accentué : champ email laissé vide', async () => {
    wrap()
    fireEvent.click(await screen.findByText('requests.new'))
    const select = (await screen.findAllByRole('combobox')).find((el) => el.innerHTML.includes('Serge'))!
    await waitFor(() => expect(select.innerHTML).toContain('Serge'))
    fireEvent.change(select, { target: { value: 'e1' } })
    await waitFor(() => expect((screen.getAllByRole('textbox') as HTMLInputElement[]).some((i) => i.value === 'Serge Dème')).toBe(true))
    expect((screen.getAllByRole('textbox') as HTMLInputElement[]).some((i) => i.value.includes('dème'))).toBe(false)
    fireEvent.change(select, { target: { value: 'e2' } })
    await waitFor(() => expect((screen.getAllByRole('textbox') as HTMLInputElement[]).some((i) => i.value === 'awa.kone@email.com')).toBe(true))
  })
})
