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

describe('LoginPage — etape MFA : trop de tentatives (429)', () => {
  it('affiche un message clair au lieu du « Too Many Requests » de Fastify', async () => {
    postMock
      .mockResolvedValueOnce({ status: 202, data: { mfaRequired: true, challenge: 'chal.jwt.x' } })
      // Corps par defaut de @fastify/rate-limit : error = 'Too Many Requests'
      .mockRejectedValueOnce({
        response: {
          status: 429,
          data: { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 15 minutes' },
        },
      })
    render(<LoginPage />)
    await submitLogin()
    await waitFor(() => expect(screen.getByPlaceholderText('mfa.codePlaceholder')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('mfa.codePlaceholder'), { target: { value: '123456' } })
    fireEvent.click(screen.getByText('mfa.submit'))

    await waitFor(() => expect(screen.getByText('mfa.tooManyAttempts')).toBeTruthy())
    expect(screen.queryByText('Too Many Requests')).toBeNull()
  })

  it('un code MFA faux garde le message du serveur', async () => {
    postMock
      .mockResolvedValueOnce({ status: 202, data: { mfaRequired: true, challenge: 'chal.jwt.x' } })
      .mockRejectedValueOnce({ response: { status: 401, data: { error: 'Code MFA invalide' } } })
    render(<LoginPage />)
    await submitLogin()
    await waitFor(() => expect(screen.getByPlaceholderText('mfa.codePlaceholder')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('mfa.codePlaceholder'), { target: { value: '123456' } })
    fireEvent.click(screen.getByText('mfa.submit'))

    await waitFor(() => expect(screen.getByText('Code MFA invalide')).toBeTruthy())
  })
})
