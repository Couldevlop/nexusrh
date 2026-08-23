/**
 * Régression : un compte MFA-enrôlé dont le mot de passe est expiré (ou
 * compromis) doit, APRÈS validation du code TOTP, tomber sur le formulaire de
 * changement de mot de passe — comme un compte sans MFA. Le token remis par
 * `/auth/mfa/login-verify` est alors RESTREINT (pwdResetRequired) : entrer dans
 * l'application avec ce token ne produirait que des 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { getMock, postMock, navigateMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'fr', changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
  initReactI18next: { type: '3rdParty', init: () => {} },
}))

import LoginPage from './LoginPage'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

const USER: AuthUser = {
  sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'hr_manager',
  email: 'rh@sotra.ci', firstName: 'Awa', lastName: 'Kone', employeeId: null,
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { data: null } })
  postMock.mockReset()
  navigateMock.mockReset()
  useAuthStore.getState().logout()
})
afterEach(() => cleanup())

/** Étape 1 : login → 202 challenge MFA. */
async function loginUntilMfaStep() {
  fireEvent.change(screen.getByPlaceholderText('login.emailPlaceholder'), {
    target: { value: 'rh@sotra.ci' },
  })
  fireEvent.change(screen.getByPlaceholderText('login.passwordPlaceholder'), {
    target: { value: 'MotDePasse123!' },
  })
  fireEvent.click(screen.getByText('login.submit'))
  await waitFor(() => expect(screen.getByPlaceholderText('mfa.codePlaceholder')).toBeTruthy())
}

/** Étape 2 : saisie du code TOTP. */
async function submitMfaCode() {
  fireEvent.change(screen.getByPlaceholderText('mfa.codePlaceholder'), {
    target: { value: '123456' },
  })
  fireEvent.click(screen.getByText('mfa.submit'))
}

describe('LoginPage — MFA validée mais mot de passe expiré', () => {
  it('affiche le changement de mot de passe au lieu d\'entrer dans l\'application', async () => {
    postMock
      .mockResolvedValueOnce({ status: 202, data: { mfaRequired: true, challenge: 'chal.jwt.x' } })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          token: 'restricted.jwt', user: USER, tenantConfig: null,
          must_change_password: true, redirectTo: '/change-password',
        },
      })

    render(<LoginPage />)
    await loginUntilMfaStep()
    await submitMfaCode()

    await waitFor(() => expect(screen.getByPlaceholderText('change.newPasswordPlaceholder')).toBeTruthy())
    // Jamais d'entrée dans l'application avec un token restreint.
    expect(navigateMock).not.toHaveBeenCalled()
    // Ni de session ouverte : le store reste vide tant que le mot de passe n'a pas changé.
    expect(useAuthStore.getState().token).toBeFalsy()
  })

  it('mot de passe valide → connexion normale (aucune régression)', async () => {
    postMock
      .mockResolvedValueOnce({ status: 202, data: { mfaRequired: true, challenge: 'chal.jwt.x' } })
      .mockResolvedValueOnce({
        status: 200,
        data: { token: 'full.jwt', user: USER, tenantConfig: null, redirectTo: '/dashboard' },
      })

    render(<LoginPage />)
    await loginUntilMfaStep()
    await submitMfaCode()

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/dashboard', { replace: true }))
    expect(useAuthStore.getState().token).toBe('full.jwt')
  })
})
