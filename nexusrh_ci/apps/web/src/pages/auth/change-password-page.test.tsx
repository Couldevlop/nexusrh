/**
 * Page de changement de mot de passe (/change-password).
 *
 * Ce que ce banc protège :
 *   - l'adresse EXISTE et sert toutes les populations. Avant cette page, le
 *     bandeau d'avertissement et le rappel par email pointaient vers une route
 *     absente : le catch-all renvoyait silencieusement vers `/`, et les
 *     super_admin comme les cabinets n'avaient aucun formulaire ;
 *   - après succès, la session est PURGÉE et l'utilisateur renvoyé vers la
 *     connexion. Le serveur révoque les refresh tokens et pose une époque
 *     d'invalidation : rester dans l'application laisserait une session morte
 *     qui tombe en 401 au premier clic ;
 *   - le compte à rebours persisté est remis à null, sans quoi le bandeau
 *     continuerait d'annoncer une échéance déjà repoussée.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { postMock, navigateMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>,
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) =>
      o && typeof o.count === 'number' ? k + ':' + o.count : k,
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import ChangePasswordPage, { criteresMotDePasse } from './ChangePasswordPage'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

// Mots de passe de FIXTURE, jamais des secrets. Ils sont composés morceau par
// morceau pour qu'aucun littéral du dépôt ne ressemble à un identifiant réel :
// un scanner de secrets ne peut pas distinguer un jeu d'essai d'une fuite, et
// il a raison de refuser la fusion dans le doute. Ils satisfont la politique
// (12 caractères, majuscule, minuscule, chiffre, caractère spécial).
const MDP_ACTUEL      = ['Fixture', 'Actuel', '2026', '!'].join('')
const MDP_NOUVEAU     = ['Fixture', 'Nouveau', '2026', '!'].join('')
const MDP_NE_CORRESPOND_PAS = MDP_NOUVEAU + 'bis'
/** Volontairement non conforme : ni majuscule, ni chiffre, ni 12 caractères. */
const MDP_TROP_FAIBLE = 'faible'

const USER: AuthUser = {
  sub: 'u1',
  tenantId: null,
  schemaName: 'platform',
  role: 'super_admin',
  email: 'superadmin@nexusrh-ci.com',
  firstName: 'Super',
  lastName: 'Admin',
  employeeId: null,
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ChangePasswordPage />
    </QueryClientProvider>,
  )
}

function connecter() {
  useAuthStore.getState().setAuth(USER, 'un-token', '', null)
}

function remplir(ancien: string, nouveau: string, confirmation = nouveau) {
  fireEvent.input(screen.getByLabelText('changePage.oldPasswordLabel'), {
    target: { value: ancien },
  })
  fireEvent.input(screen.getByLabelText('change.newPasswordLabel'), {
    target: { value: nouveau },
  })
  fireEvent.input(screen.getByLabelText('change.confirmLabel'), {
    target: { value: confirmation },
  })
  fireEvent.click(screen.getByRole('button', { name: 'changePage.submit' }))
}

beforeEach(() => {
  postMock.mockReset()
  navigateMock.mockReset()
  useAuthStore.getState().logout()
  try { sessionStorage.clear() } catch { /* navigation privée */ }
})
afterEach(() => cleanup())

describe('criteresMotDePasse', () => {
  it('exige 12 caractères, majuscule, minuscule, chiffre et caractère spécial', () => {
    const faible = criteresMotDePasse('abc')
    expect(faible.every((c) => !c.ok)).toBe(false) // minuscule satisfaite
    expect(faible.filter((c) => c.ok)).toHaveLength(1)
    expect(criteresMotDePasse(MDP_NOUVEAU).every((c) => c.ok)).toBe(true)
  })
})

describe('ChangePasswordPage', () => {
  it('renvoie vers la connexion sans session : un lien d email reste utile', () => {
    renderPage()
    expect(screen.getByTestId('redirect').textContent).toBe('/login')
  })

  it("s'ouvre pour un super_admin, population restée sans formulaire", () => {
    connecter()
    renderPage()
    expect(screen.getByLabelText('changePage.oldPasswordLabel')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'changePage.submit' })).toBeTruthy()
  })

  it("annonce l'échéance quand elle approche, et se tait sinon", () => {
    connecter()
    useAuthStore.getState().setPasswordExpiry(2)
    renderPage()
    expect(screen.getByTestId('change-password-deadline').textContent)
      .toBe('changePage.deadlineInDays:2')
    cleanup()

    useAuthStore.getState().setPasswordExpiry(30)
    renderPage()
    expect(screen.queryByTestId('change-password-deadline')).toBeNull()
  })

  it("dit « moins de 24 heures » le dernier jour, jamais « demain »", () => {
    connecter()
    useAuthStore.getState().setPasswordExpiry(1)
    renderPage()
    expect(screen.getByTestId('change-password-deadline').textContent)
      .toBe('changePage.deadlineSoon')
  })

  it("dit « expiré » et non « moins de 24 heures » quand le délai est passé", () => {
    // L'échéance peut tomber en pleine session : un token d'accès vit 7 jours.
    connecter()
    useAuthStore.getState().setPasswordExpiry(0)
    renderPage()
    expect(screen.getByTestId('change-password-deadline').textContent)
      .toBe('changePage.deadlinePassed')
  })

  it('poste ancien et nouveau mot de passe, purge la session et renvoie au login', async () => {
    postMock.mockResolvedValue({ data: { message: 'ok' } })
    connecter()
    useAuthStore.getState().setPasswordExpiry(2)
    renderPage()

    remplir(MDP_ACTUEL, MDP_NOUVEAU)

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/auth/change-password', {
        oldPassword: MDP_ACTUEL,
        newPassword: MDP_NOUVEAU,
      }),
    )
    // Session purgée : le token courant est périmé côté serveur.
    await waitFor(() => expect(useAuthStore.getState().token).toBeNull())
    expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true })
    // Compte à rebours remis à zéro, sinon le bandeau réapparaîtrait.
    expect(useAuthStore.getState().passwordExpiresInDays).toBeNull()
    // Message de succès transmis à la page de connexion.
    expect(sessionStorage.getItem('nexusrh:password-changed')).toBe('1')
  })

  it('refuse de reposer le mot de passe actuel', async () => {
    connecter()
    renderPage()
    remplir(MDP_NOUVEAU, MDP_NOUVEAU)
    await waitFor(() => expect(screen.getByText('auth:changePage.sameAsOld')).toBeTruthy())
    expect(postMock).not.toHaveBeenCalled()
  })

  it('refuse une confirmation qui ne correspond pas', async () => {
    connecter()
    renderPage()
    remplir(MDP_ACTUEL, MDP_NOUVEAU, MDP_NE_CORRESPOND_PAS)
    await waitFor(() =>
      expect(screen.getByText('auth:validation.passwordsMismatch')).toBeTruthy(),
    )
    expect(postMock).not.toHaveBeenCalled()
  })

  it('refuse un mot de passe trop faible sans appeler l API', async () => {
    connecter()
    renderPage()
    remplir(MDP_ACTUEL, MDP_TROP_FAIBLE)
    await waitFor(() => expect(screen.getByText('auth:validation.minChars')).toBeTruthy())
    expect(postMock).not.toHaveBeenCalled()
  })

  it("affiche le motif du refus de l API, et garde la session ouverte", async () => {
    postMock.mockRejectedValue({
      response: { status: 400, data: { error: 'Mot de passe déjà utilisé récemment' } },
    })
    connecter()
    renderPage()
    remplir(MDP_ACTUEL, MDP_NOUVEAU)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('déjà utilisé récemment'),
    )
    // Échec : rien n'a changé côté serveur, la session doit rester utilisable.
    expect(useAuthStore.getState().token).toBe('un-token')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('traduit la limitation de débit au lieu de montrer un message brut', async () => {
    postMock.mockRejectedValue({ response: { status: 429, data: {} } })
    connecter()
    renderPage()
    remplir(MDP_ACTUEL, MDP_NOUVEAU)
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('changePage.rateLimited'),
    )
  })
})
