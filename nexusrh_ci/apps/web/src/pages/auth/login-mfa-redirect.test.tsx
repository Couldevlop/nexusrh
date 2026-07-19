/**
 * Régression incident PROD (MFA obligatoire) :
 *
 * Quand `POST /auth/login` répond 200 `{ mfaSetupRequired: true, token, user }`,
 * le token remis est RESTREINT (mfaPending) : il est refusé (403) sur toutes les
 * routes métier. LoginPage redirigeait vers `/settings?tab=mfa`, une route
 * TENANT réservée au rôle admin :
 *   - un super_admin était renvoyé par RootRedirect vers /platform/dashboard →
 *     écran vide (tous les /platform/* en 403) ;
 *   - un employee (aucun accès à /settings) subissait le même sort.
 *
 * Invariant : la redirection doit se faire vers /mfa-setup — page d'enrôlement
 * plein écran hors layouts gardés — pour TOUS les rôles.
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
// i18n : t() renvoie la clé — assertions stables quelle que soit la langue.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'fr', changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
  // LanguageSwitcher → src/i18n/index.ts appelle i18n.use(initReactI18next)
  initReactI18next: { type: '3rdParty', init: () => {} },
}))

import LoginPage from './LoginPage'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

function makeUser(role: AuthUser['role'], email: string): AuthUser {
  return {
    sub: 'u1',
    tenantId: role === 'super_admin' ? null : 't1',
    schemaName: role === 'super_admin' ? 'platform' : 'tenant_sotra',
    role,
    email,
    firstName: 'Test',
    lastName: 'User',
    employeeId: null,
  }
}

async function submitLogin(email: string) {
  fireEvent.change(screen.getByPlaceholderText('login.emailPlaceholder'), {
    target: { value: email },
  })
  fireEvent.change(screen.getByPlaceholderText('login.passwordPlaceholder'), {
    target: { value: 'MotDePasse123!' },
  })
  fireEvent.click(screen.getByText('login.submit'))
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { data: null } })
  postMock.mockReset()
  navigateMock.mockReset()
  useAuthStore.getState().logout()
})
afterEach(() => cleanup())

describe('LoginPage — MFA obligatoire non encore enrôlée', () => {
  it('redirige un super_admin vers /mfa-setup (jamais /settings)', async () => {
    postMock.mockResolvedValue({
      status: 200,
      data: {
        mfaSetupRequired: true,
        token: 'restricted-mfa-pending-token',
        user: makeUser('super_admin', 'superadmin@nexusrh-ci.com'),
        redirectTo: '/platform/dashboard',
      },
    })

    render(<LoginPage />)
    await submitLogin('superadmin@nexusrh-ci.com')

    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    expect(navigateMock).toHaveBeenCalledWith('/mfa-setup', { replace: true })
    // Aucune redirection vers la route tenant /settings ni vers un dashboard.
    const targets = navigateMock.mock.calls.map((c) => String(c[0]))
    expect(targets.some((p) => p.startsWith('/settings'))).toBe(false)
    expect(targets.some((p) => p.includes('dashboard'))).toBe(false)
  })

  it('redirige un employee vers /mfa-setup (jamais /settings)', async () => {
    postMock.mockResolvedValue({
      status: 200,
      data: {
        mfaSetupRequired: true,
        token: 'restricted-mfa-pending-token',
        user: makeUser('employee', 'employe@sotra.ci'),
        redirectTo: '/mon-espace',
      },
    })

    render(<LoginPage />)
    await submitLogin('employe@sotra.ci')

    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    expect(navigateMock).toHaveBeenCalledWith('/mfa-setup', { replace: true })
    const targets = navigateMock.mock.calls.map((c) => String(c[0]))
    expect(targets.some((p) => p.startsWith('/settings'))).toBe(false)
  })

  it('mémorise la session restreinte avant de rediriger (le token sert au setup MFA)', async () => {
    postMock.mockResolvedValue({
      status: 200,
      data: {
        mfaSetupRequired: true,
        token: 'restricted-mfa-pending-token',
        user: makeUser('employee', 'employe@sotra.ci'),
      },
    })

    render(<LoginPage />)
    await submitLogin('employe@sotra.ci')

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/mfa-setup', { replace: true }))
    expect(useAuthStore.getState().token).toBe('restricted-mfa-pending-token')
  })

  it("laisse intact le parcours 202 (MFA déjà configurée) : challenge affiché, aucune navigation", async () => {
    postMock.mockResolvedValue({
      status: 202,
      data: { mfaRequired: true, challenge: 'chal-123' },
    })

    render(<LoginPage />)
    await submitLogin('mfa@sotra.ci')

    await waitFor(() => expect(screen.getByPlaceholderText('mfa.codePlaceholder')).toBeTruthy())
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
