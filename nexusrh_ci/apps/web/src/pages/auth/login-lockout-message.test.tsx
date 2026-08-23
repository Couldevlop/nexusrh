/**
 * Régression UX/sécurité : un compte verrouillé (423, OWASP A07) renvoyait le
 * message générique « identifiants invalides ». L'utilisateur croyait s'être
 * trompé de mot de passe et réessayait — chaque essai prolongeant le verrou,
 * en aveugle. Le serveur renvoie déjà un message clair avec le délai restant :
 * il doit être affiché tel quel (aucune information sensible : le verrou est
 * déclaré sans dire si le mot de passe était bon).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { getMock, postMock, navigateMock } = vi.hoisted(() => ({
  getMock: vi.fn(), postMock: vi.fn(), navigateMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'fr', changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
  initReactI18next: { type: '3rdParty', init: () => {} },
}))

import LoginPage from './LoginPage'
import { useAuthStore } from '@/stores/authStore'

const LOCKED = 'Compte temporairement verrouille suite a trop de tentatives. Reessayez dans 8 min.'

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { data: null } })
  postMock.mockReset()
  navigateMock.mockReset()
  useAuthStore.getState().logout()
})
afterEach(() => cleanup())

async function submitLogin() {
  fireEvent.change(screen.getByPlaceholderText('login.emailPlaceholder'), {
    target: { value: 'employe@sotra.ci' },
  })
  fireEvent.change(screen.getByPlaceholderText('login.passwordPlaceholder'), {
    target: { value: 'MotDePasse123!' },
  })
  fireEvent.click(screen.getByText('login.submit'))
}

describe('LoginPage — compte verrouille (423)', () => {
  it('affiche le message du serveur avec le delai restant', async () => {
    postMock.mockRejectedValue({ response: { status: 423, data: { error: LOCKED } } })
    render(<LoginPage />)
    await submitLogin()
    await waitFor(() => expect(screen.getByText(LOCKED)).toBeTruthy())
  })

  it('un vrai echec d identifiants reste generique (anti-enumeration)', async () => {
    postMock.mockRejectedValue({ response: { status: 401, data: { error: 'Email ou mot de passe incorrect' } } })
    render(<LoginPage />)
    await submitLogin()
    await waitFor(() => expect(screen.getByText('errors.invalidCredentials')).toBeTruthy())
  })
})
