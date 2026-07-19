/**
 * Page d'enrôlement MFA imposée (/mfa-setup).
 *
 * Contraintes vérifiées empiriquement en PROD :
 *   - le token courant est RESTREINT (mfaPending) : seul /auth/mfa/setup et
 *     /auth/mfa/verify l'acceptent ;
 *   - après un /verify réussi, le token RESTE restreint → il faut purger le
 *     store d'auth et renvoyer vers /login (jamais vers un dashboard, qui
 *     répondrait 403 partout).
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
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import MfaEnrollmentPage from './MfaEnrollmentPage'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

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

const BACKUP_CODES = [
  'A1B2C3D4E5', 'F6G7H8I9J0', 'K1L2M3N4O5', 'P6Q7R8S9T0', 'U1V2W3X4Y5',
  'Z6A7B8C9D0', 'E1F2G3H4I5', 'J6K7L8M9N0', 'O1P2Q3R4S5', 'T6U7V8W9X0',
]

const SETUP_DATA = {
  qrCodeDataUrl: 'data:image/png;base64,QRCODE',
  secret: 'JBSWY3DPEHPK3PXP',
  backupCodes: BACKUP_CODES,
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MfaEnrollmentPage />
    </QueryClientProvider>,
  )
}

function loginRestricted() {
  useAuthStore.getState().setAuth(USER, 'restricted-mfa-pending-token', '', null)
}

beforeEach(() => {
  postMock.mockReset()
  navigateMock.mockReset()
  useAuthStore.getState().logout()
})
afterEach(() => cleanup())

describe('MfaEnrollmentPage', () => {
  it('appelle /auth/mfa/setup au montage et affiche QR, secret et codes de secours', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/auth/mfa/setup') return Promise.resolve({ data: SETUP_DATA })
      return Promise.reject(new Error('unexpected ' + url))
    })
    loginRestricted()

    renderPage()

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/auth/mfa/setup'))
    await waitFor(() => expect(screen.getByText(SETUP_DATA.secret)).toBeTruthy())
    // QR affiché
    const img = document.querySelector('img[src^="data:image/png"]')
    expect(img).toBeTruthy()
    // Les 10 codes de secours sont visibles
    for (const code of BACKUP_CODES) {
      expect(screen.getByText(code)).toBeTruthy()
    }
    // Avertissement : les codes ne seront plus jamais réaffichés
    expect(screen.getByText('mfaEnroll.backupWarning')).toBeTruthy()
  })

  it('un /verify réussi purge le store et renvoie vers /login (jamais vers un dashboard)', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/auth/mfa/setup') return Promise.resolve({ data: SETUP_DATA })
      if (url === '/auth/mfa/verify') return Promise.resolve({ data: { success: true } })
      return Promise.reject(new Error('unexpected ' + url))
    })
    loginRestricted()

    renderPage()
    await waitFor(() => expect(screen.getByText(SETUP_DATA.secret)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('mfaEnroll.codePlaceholder'), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByText('mfaEnroll.activate'))

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/auth/mfa/verify', { code: '123456' }),
    )
    // Le token reste restreint côté serveur → session purgée, reconnexion imposée.
    await waitFor(() => expect(useAuthStore.getState().token).toBeNull())
    expect(useAuthStore.getState().user).toBeNull()
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true }))
    const targets = navigateMock.mock.calls.map((c) => String(c[0]))
    expect(targets.some((p) => p.includes('dashboard') || p.includes('mon-espace'))).toBe(false)
  })

  it("un /verify en échec affiche l'erreur API et laisse l'utilisateur sur la page", async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/auth/mfa/setup') return Promise.resolve({ data: SETUP_DATA })
      if (url === '/auth/mfa/verify') {
        return Promise.reject({ response: { status: 400, data: { error: 'Code MFA invalide' } } })
      }
      return Promise.reject(new Error('unexpected ' + url))
    })
    loginRestricted()

    renderPage()
    await waitFor(() => expect(screen.getByText(SETUP_DATA.secret)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('mfaEnroll.codePlaceholder'), {
      target: { value: '000000' },
    })
    fireEvent.click(screen.getByText('mfaEnroll.activate'))

    await waitFor(() => expect(screen.getByText('Code MFA invalide')).toBeTruthy())
    // Toujours sur la page : session intacte, aucune navigation.
    expect(useAuthStore.getState().token).toBe('restricted-mfa-pending-token')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('affiche un message dédié quand /verify est rate-limité (429)', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/auth/mfa/setup') return Promise.resolve({ data: SETUP_DATA })
      if (url === '/auth/mfa/verify') return Promise.reject({ response: { status: 429, data: {} } })
      return Promise.reject(new Error('unexpected ' + url))
    })
    loginRestricted()

    renderPage()
    await waitFor(() => expect(screen.getByText(SETUP_DATA.secret)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('mfaEnroll.codePlaceholder'), {
      target: { value: '000000' },
    })
    fireEvent.click(screen.getByText('mfaEnroll.activate'))

    await waitFor(() => expect(screen.getByText('mfaEnroll.rateLimited')).toBeTruthy())
  })

  it('affiche une erreur lisible si /auth/mfa/setup échoue', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/auth/mfa/setup') {
        return Promise.reject({ response: { status: 500, data: { error: 'Setup indisponible' } } })
      }
      return Promise.reject(new Error('unexpected ' + url))
    })
    loginRestricted()

    renderPage()

    await waitFor(() => expect(screen.getByText('Setup indisponible')).toBeTruthy())
  })

  it('renvoie vers /login si aucun token en store', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByTestId('redirect').textContent).toBe('/login'))
    expect(postMock).not.toHaveBeenCalled()
  })
})
