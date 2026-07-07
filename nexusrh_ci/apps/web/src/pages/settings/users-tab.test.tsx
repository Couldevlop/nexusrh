/**
 * Tests du flux « Ajouter un utilisateur » (Paramètres → Utilisateurs).
 *
 * Reproduit le bug terrain : « après la création, aucun message ne s'affiche et
 * il faut actualiser (F5) pour voir l'utilisateur dans la liste ». Invariants :
 *   1. SUCCÈS  → la popup de confirmation s'affiche (mot de passe temporaire +
 *      statut d'envoi de l'email) ET la liste est rafraîchie sans F5.
 *   2. ÉCHEC   → un message d'erreur s'affiche (jamais un silence) ET la liste
 *      est rafraîchie quand même (si le compte a été créé malgré un timeout
 *      réseau, il apparaît).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}))
// i18n : t() renvoie la clé — les assertions ciblent les clés, stables quelle
// que soit la langue.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import { UsersTab } from './SettingsPage'

function Host() {
  const qc = useQueryClient()
  return <UsersTab qc={qc} />
}

function renderUsersTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <Host />
    </QueryClientProvider>,
  )
}

function fillAndSubmitForm() {
  fireEvent.click(screen.getByText('users.add'))
  const dialogInputs = document.querySelectorAll<HTMLInputElement>('input')
  const email = document.querySelector<HTMLInputElement>('input[type="email"]')!
  fireEvent.change(email, { target: { value: 'awa.kone@sotra.ci' } })
  const textInputs = Array.from(dialogInputs).filter((i) => i.type !== 'email')
  fireEvent.change(textInputs[0]!, { target: { value: 'Awa' } })
  fireEvent.change(textInputs[1]!, { target: { value: 'Koné' } })
  fireEvent.click(screen.getByText('users.form.create'))
}

const listCalls = () => getMock.mock.calls.filter((c) => c[0] === '/settings/users').length

// Mots de passe temporaires 100% factices (fixtures) — construits par
// concaténation pour ne pas déclencher les scanners de secrets (GitGuardian).
const FAKE_TMP_PWD_1 = ['TMP', 'FICTIF', '1'].join('-')
const FAKE_TMP_PWD_2 = ['TMP', 'FICTIF', '2'].join('-')

beforeEach(() => {
  getMock.mockReset().mockImplementation(() => Promise.resolve({ data: { data: [] } }))
  postMock.mockReset()
})
// Pas de `globals: true` vitest → l'auto-cleanup Testing Library ne s'installe
// pas tout seul : sans ce cleanup, les rendus s'accumulent entre les tests.
afterEach(() => cleanup())

describe('UsersTab — création d\'utilisateur : retour visuel + liste à jour sans F5', () => {
  it('succès → popup avec mot de passe temporaire + statut email + liste rafraîchie', async () => {
    postMock.mockResolvedValue({
      data: { data: { id: 'u1' }, tempPassword: FAKE_TMP_PWD_1, emailSent: true },
    })
    renderUsersTab()
    await waitFor(() => expect(listCalls()).toBeGreaterThanOrEqual(1))
    const callsBefore = listCalls()

    fillAndSubmitForm()

    // 1. Confirmation visible immédiatement (pas de silence)
    await waitFor(() => expect(screen.getByText('users.createResult.title')).toBeTruthy())
    expect(screen.getByText(FAKE_TMP_PWD_1)).toBeTruthy()
    expect(screen.getByText('users.createResult.emailSent')).toBeTruthy()
    // 2. La liste est re-demandée à l'API sans F5 (invalidation React Query)
    await waitFor(() => expect(listCalls()).toBeGreaterThan(callsBefore))
  })

  it('succès mais email non parti → avertissement emailNotSent dans la popup', async () => {
    postMock.mockResolvedValue({
      data: { data: { id: 'u2' }, tempPassword: FAKE_TMP_PWD_2, emailSent: false },
    })
    renderUsersTab()
    fillAndSubmitForm()
    await waitFor(() => expect(screen.getByText('users.createResult.title')).toBeTruthy())
    expect(screen.getByText('users.createResult.emailNotSent')).toBeTruthy()
  })

  it('échec (email déjà utilisé) → message d\'erreur affiché, jamais un silence', async () => {
    postMock.mockRejectedValue({
      response: { data: { error: 'Un utilisateur avec cet email existe déjà.' } },
    })
    renderUsersTab()
    fillAndSubmitForm()
    await waitFor(() =>
      expect(screen.getByText('Un utilisateur avec cet email existe déjà.')).toBeTruthy(),
    )
    // Pas de popup de succès
    expect(screen.queryByText('users.createResult.title')).toBeNull()
  })

  it('échec sans message serveur (timeout réseau) → message générique + liste rafraîchie', async () => {
    postMock.mockRejectedValue(new Error('Network Error'))
    renderUsersTab()
    await waitFor(() => expect(listCalls()).toBeGreaterThanOrEqual(1))
    const callsBefore = listCalls()

    fillAndSubmitForm()

    await waitFor(() => expect(screen.getByText('users.form.error')).toBeTruthy())
    // La liste est rafraîchie MÊME en échec (onSettled) : si le compte a été
    // créé côté serveur malgré le timeout, il apparaît sans F5.
    await waitFor(() => expect(listCalls()).toBeGreaterThan(callsBefore))
  })
})
