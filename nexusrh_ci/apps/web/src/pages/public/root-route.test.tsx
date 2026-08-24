/**
 * Racine du domaine : elle sert désormais la page d'accueil publique au lieu
 * de renvoyer un visiteur vers le formulaire de connexion.
 *
 * Le point délicat est la NON-régression : un utilisateur déjà connecté doit
 * continuer d'être aiguillé vers son espace, exactement comme avant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Suspense } from 'react'

// La page d'accueil est doublée : ce test vérifie l'aiguillage de la racine,
// son contenu est couvert par home-page.test.tsx.
vi.mock('@/pages/public/HomePage', () => ({
  default: () => <div data-testid="accueil" />,
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('react-router-dom', () => ({
  // Rend la destination visible dans le DOM au lieu de naviguer.
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

vi.mock('react-i18next', async () => {
  // t() résout réellement les clés dans le fichier FR : les assertions portent
  // donc sur le texte publié, et une clé manquante fait échouer le test.
  const fr = (await import('@/i18n/locales/fr/home.json')).default as Record<string, unknown>
  const resolve = (key: string): string => {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], fr)
    return typeof v === 'string' ? v : key
  }
  return {
    useTranslation: () => ({ t: resolve, i18n: { language: 'fr', changeLanguage: vi.fn() } }),
    Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
    initReactI18next: { type: '3rdParty', init: () => {} },
  }
})

import { RootRedirect } from '@/App'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

const USER = (role: AuthUser['role']): AuthUser => ({
  sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role,
  email: `${role}@sotra.ci`, firstName: 'Awa', lastName: 'Kone', employeeId: null,
})

beforeEach(() => { useAuthStore.getState().logout() })
afterEach(() => cleanup())

describe('Racine du domaine', () => {
  it("visiteur non connecté → page d'accueil, pas de redirection", async () => {
    // La page d'accueil est chargée en différé comme les autres pages : on
    // reproduit ici le Suspense que fournit App autour des routes.
    render(<Suspense fallback={null}><RootRedirect /></Suspense>)
    expect(await screen.findByTestId('accueil')).toBeTruthy()
    expect(screen.queryByTestId('redirect')).toBeNull()
  })

  it('salarié connecté → toujours redirigé vers son espace (non-régression)', () => {
    useAuthStore.setState({ user: USER('employee'), token: 'jwt' })
    render(<RootRedirect />)
    expect(screen.getByTestId('redirect').textContent).toBe('/mon-espace')
  })

  it('administrateur connecté → toujours redirigé vers son tableau de bord', () => {
    useAuthStore.setState({ user: USER('admin'), token: 'jwt' })
    render(<RootRedirect />)
    expect(screen.getByTestId('redirect').textContent).toBe('/dashboard')
  })
})
