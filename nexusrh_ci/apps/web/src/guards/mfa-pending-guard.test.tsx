/**
 * Régression incident PROD (MFA obligatoire) — volet NAVIGATION.
 *
 * Le correctif précédent ne couvrait que le MOMENT du login : rien n'empêchait
 * l'utilisateur de taper directement `/dashboard`, `/platform/dashboard`,
 * `/mon-espace` ou `/agency/dashboard` après coup. Il atterrissait alors sur une
 * coquille d'application dont TOUS les appels partent en 403 (« MFA obligatoire »),
 * soit un écran cassé sans explication — et un enrôlement obligatoire contournable
 * côté navigation.
 *
 * Invariant : tant que le JWT du store porte le claim `mfaPending: true`, TOUS les
 * gardes renvoient vers `/mfa-setup`.
 *
 * Ordre critique : le contrôle MFA doit passer APRÈS `!user → /login` mais AVANT
 * les contrôles de rôle. Sinon un super_admin en mfaPending est renvoyé vers
 * /platform/dashboard par PlatformGuard avant même d'atteindre le garde MFA —
 * c'est exactement le rebond qui a causé l'incident.
 *
 * La source de vérité est le CLAIM JWT, jamais un booléen stocké à part : un flag
 * de store se désynchronise et se trafique trivialement depuis la console.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Suspense } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

import {
  RoleGuard,
  AuthGuard,
  RhDashboardGuard,
  PlatformGuard,
  EmployeeGuard,
  AgencyGuard,
} from './RoleGuard'
import { useAuthStore, isMfaPendingToken, type AuthUser } from '@/stores/authStore'
import { RootRedirect } from '@/App'

// ── Fabrique de JWT (header.payload.signature, payload base64url) ──────────────
function b64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(payload)
  )}.sig`
}

function makeUser(role: AuthUser['role'], extra: Partial<AuthUser> = {}): AuthUser {
  return {
    sub: 'u1',
    tenantId: role === 'super_admin' ? null : 't1',
    schemaName: role === 'super_admin' ? 'platform' : 'tenant_sotra',
    role,
    email: 'test@sotra.ci',
    firstName: 'Test',
    lastName: 'User',
    employeeId: null,
    ...extra,
  }
}

const PENDING_TOKEN = makeToken({ sub: 'u1', mfaPending: true })
const NORMAL_TOKEN = makeToken({ sub: 'u1' })

function signIn(user: AuthUser, token: string) {
  useAuthStore.setState({ user, token, refreshToken: null, activeTenant: null })
}

/**
 * Rend le garde sur la route `/protegee` et expose des sentinelles pour CHAQUE
 * cible de redirection possible — on vérifie ainsi non seulement qu'on arrive
 * sur /mfa-setup, mais aussi qu'on n'a pas rebondi ailleurs.
 */
// La page d'accueil publique est doublée ici : ce fichier vérifie
// l'aiguillage, son contenu est couvert par home-page.test.tsx.
vi.mock('@/pages/public/HomePage', () => ({ default: () => <div>ECRAN_ACCUEIL</div> }))

function renderGuard(guard: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/protegee']}>
      <Routes>
        <Route path="/protegee" element={guard} />
        <Route path="/mfa-setup" element={<div>ECRAN_MFA_SETUP</div>} />
        <Route path="/login" element={<div>ECRAN_LOGIN</div>} />
        <Route path="/dashboard" element={<div>ECRAN_DASHBOARD</div>} />
        <Route path="/platform/dashboard" element={<div>ECRAN_PLATFORM</div>} />
        <Route path="/mon-espace" element={<div>ECRAN_MON_ESPACE</div>} />
        <Route path="/agency/dashboard" element={<div>ECRAN_AGENCY</div>} />
      </Routes>
    </MemoryRouter>
  )
}

const PROTECTED = <div>CONTENU_PROTEGE</div>

function expectRedirectedToMfaSetup() {
  expect(screen.getByText('ECRAN_MFA_SETUP')).toBeTruthy()
  expect(screen.queryByText('CONTENU_PROTEGE')).toBeNull()
  // Aucun rebond vers un dashboard : c'est le bug d'ordre des contrôles.
  expect(screen.queryByText('ECRAN_PLATFORM')).toBeNull()
  expect(screen.queryByText('ECRAN_DASHBOARD')).toBeNull()
  expect(screen.queryByText('ECRAN_MON_ESPACE')).toBeNull()
  expect(screen.queryByText('ECRAN_AGENCY')).toBeNull()
}

beforeEach(() => {
  useAuthStore.getState().logout()
})
afterEach(() => cleanup())

// ── Helper de décodage ────────────────────────────────────────────────────────
describe('isMfaPendingToken — lecture du claim JWT', () => {
  it('renvoie true quand le payload porte mfaPending: true', () => {
    expect(isMfaPendingToken(PENDING_TOKEN)).toBe(true)
  })

  it('renvoie false pour un token normal (sans le claim)', () => {
    expect(isMfaPendingToken(NORMAL_TOKEN)).toBe(false)
  })

  it('renvoie false quand mfaPending est falsy ou non booléen (pas de coercition)', () => {
    expect(isMfaPendingToken(makeToken({ mfaPending: false }))).toBe(false)
    expect(isMfaPendingToken(makeToken({ mfaPending: 'true' }))).toBe(false)
    expect(isMfaPendingToken(makeToken({ mfaPending: 1 }))).toBe(false)
  })

  it('renvoie false sans planter quand le token est absent ou illisible', () => {
    expect(isMfaPendingToken(null)).toBe(false)
    expect(isMfaPendingToken(undefined)).toBe(false)
    expect(isMfaPendingToken('')).toBe(false)
    expect(isMfaPendingToken('pas-un-jwt')).toBe(false)
    expect(isMfaPendingToken('a.b')).toBe(false)
    expect(isMfaPendingToken('aaa.!!!invalide!!!.sig')).toBe(false)
    expect(isMfaPendingToken(`aaa.${b64url('pas du json')}.sig`)).toBe(false)
    // Payload JSON valide mais pas un objet → pas d'accès propriété sur un scalaire.
    expect(isMfaPendingToken(`aaa.${b64url('"chaine"')}.sig`)).toBe(false)
    expect(isMfaPendingToken(`aaa.${b64url('null')}.sig`)).toBe(false)
  })

  it('décode un payload base64url sans padding (caractères - et _)', () => {
    // Payload gonflé pour forcer les caractères base64url spécifiques et une
    // longueur non multiple de 4 (padding absent).
    const token = makeToken({ mfaPending: true, sub: 'u1', jti: '??>>~~ùéè', tenantId: null })
    expect(token.split('.')[1]).not.toContain('=')
    expect(isMfaPendingToken(token)).toBe(true)
  })
})

// ── Gardes ────────────────────────────────────────────────────────────────────
describe('Gardes — session mfaPending → /mfa-setup', () => {
  it('PlatformGuard : un super_admin en mfaPending va sur /mfa-setup, PAS /platform/dashboard', () => {
    signIn(makeUser('super_admin'), PENDING_TOKEN)
    renderGuard(<PlatformGuard>{PROTECTED}</PlatformGuard>)
    expectRedirectedToMfaSetup()
  })

  it('RhDashboardGuard : un admin en mfaPending va sur /mfa-setup', () => {
    signIn(makeUser('admin'), PENDING_TOKEN)
    renderGuard(<RhDashboardGuard>{PROTECTED}</RhDashboardGuard>)
    expectRedirectedToMfaSetup()
  })

  it('RhDashboardGuard : un super_admin en mfaPending ne rebondit pas vers /platform/dashboard', () => {
    signIn(makeUser('super_admin'), PENDING_TOKEN)
    renderGuard(<RhDashboardGuard>{PROTECTED}</RhDashboardGuard>)
    expectRedirectedToMfaSetup()
  })

  it('EmployeeGuard : un employee en mfaPending va sur /mfa-setup, PAS /mon-espace', () => {
    signIn(makeUser('employee'), PENDING_TOKEN)
    renderGuard(<EmployeeGuard>{PROTECTED}</EmployeeGuard>)
    expectRedirectedToMfaSetup()
  })

  it('AgencyGuard : un acteur cabinet en mfaPending va sur /mfa-setup', () => {
    signIn(makeUser('agency_owner', { actorType: 'agency', agencyId: 'a1' }), PENDING_TOKEN)
    renderGuard(<AgencyGuard>{PROTECTED}</AgencyGuard>)
    expectRedirectedToMfaSetup()
  })

  it('AuthGuard : une session mfaPending va sur /mfa-setup', () => {
    signIn(makeUser('hr_manager'), PENDING_TOKEN)
    renderGuard(<AuthGuard>{PROTECTED}</AuthGuard>)
    expectRedirectedToMfaSetup()
  })

  it('RoleGuard : un rôle AUTORISÉ en mfaPending va quand même sur /mfa-setup', () => {
    signIn(makeUser('admin'), PENDING_TOKEN)
    renderGuard(<RoleGuard allowedRoles={['admin']}>{PROTECTED}</RoleGuard>)
    expectRedirectedToMfaSetup()
  })

  it('RoleGuard : un rôle NON autorisé en mfaPending va sur /mfa-setup (pas sur redirectTo)', () => {
    signIn(makeUser('employee'), PENDING_TOKEN)
    renderGuard(<RoleGuard allowedRoles={['admin']}>{PROTECTED}</RoleGuard>)
    expectRedirectedToMfaSetup()
  })
})

// ── Non-régression : le cas nominal ne doit surtout pas casser ────────────────
describe('Gardes — token normal : aucun changement de comportement', () => {
  it('PlatformGuard laisse passer un super_admin', () => {
    signIn(makeUser('super_admin'), NORMAL_TOKEN)
    renderGuard(<PlatformGuard>{PROTECTED}</PlatformGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
    expect(screen.queryByText('ECRAN_MFA_SETUP')).toBeNull()
  })

  it('RhDashboardGuard laisse passer un admin', () => {
    signIn(makeUser('admin'), NORMAL_TOKEN)
    renderGuard(<RhDashboardGuard>{PROTECTED}</RhDashboardGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })

  it('EmployeeGuard laisse passer un employee', () => {
    signIn(makeUser('employee'), NORMAL_TOKEN)
    renderGuard(<EmployeeGuard>{PROTECTED}</EmployeeGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })

  it('AgencyGuard laisse passer un acteur cabinet hors session scopée', () => {
    signIn(makeUser('agency_owner', { actorType: 'agency', agencyId: 'a1' }), NORMAL_TOKEN)
    renderGuard(<AgencyGuard>{PROTECTED}</AgencyGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })

  it('AuthGuard laisse passer une session authentifiée', () => {
    signIn(makeUser('hr_manager'), NORMAL_TOKEN)
    renderGuard(<AuthGuard>{PROTECTED}</AuthGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })

  it('RoleGuard laisse passer un rôle autorisé', () => {
    signIn(makeUser('admin'), NORMAL_TOKEN)
    renderGuard(<RoleGuard allowedRoles={['admin']}>{PROTECTED}</RoleGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })

  it("RoleGuard redirige toujours un rôle non autorisé vers redirectTo (règle RBAC intacte)", () => {
    signIn(makeUser('employee'), NORMAL_TOKEN)
    renderGuard(<RoleGuard allowedRoles={['admin']}>{PROTECTED}</RoleGuard>)
    expect(screen.getByText('ECRAN_DASHBOARD')).toBeTruthy()
  })

  it('RhDashboardGuard renvoie toujours un super_admin vers /platform/dashboard', () => {
    signIn(makeUser('super_admin'), NORMAL_TOKEN)
    renderGuard(<RhDashboardGuard>{PROTECTED}</RhDashboardGuard>)
    expect(screen.getByText('ECRAN_PLATFORM')).toBeTruthy()
  })

  it('PlatformGuard renvoie toujours un non-super_admin vers /dashboard', () => {
    signIn(makeUser('admin'), NORMAL_TOKEN)
    renderGuard(<PlatformGuard>{PROTECTED}</PlatformGuard>)
    expect(screen.getByText('ECRAN_DASHBOARD')).toBeTruthy()
  })
})

// ── Session absente / token corrompu ──────────────────────────────────────────
describe('Gardes — session absente ou token corrompu', () => {
  it('renvoie vers /login quand il n’y a pas d’utilisateur (comportement préservé)', () => {
    renderGuard(<PlatformGuard>{PROTECTED}</PlatformGuard>)
    expect(screen.getByText('ECRAN_LOGIN')).toBeTruthy()
  })

  it('AuthGuard renvoie vers /login sans token', () => {
    renderGuard(<AuthGuard>{PROTECTED}</AuthGuard>)
    expect(screen.getByText('ECRAN_LOGIN')).toBeTruthy()
  })

  it('un token illisible ne provoque ni crash ni écran blanc (le garde de rôle reprend la main)', () => {
    signIn(makeUser('super_admin'), 'token-corrompu-!!!')
    renderGuard(<PlatformGuard>{PROTECTED}</PlatformGuard>)
    // Pas d'exception, et pas de redirection MFA sur un token indéchiffrable.
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })

  it('un utilisateur présent SANS token reste traité par les règles existantes', () => {
    useAuthStore.setState({ user: makeUser('admin'), token: null })
    renderGuard(<RhDashboardGuard>{PROTECTED}</RhDashboardGuard>)
    expect(screen.getByText('CONTENU_PROTEGE')).toBeTruthy()
  })
})

// ── RootRedirect ──────────────────────────────────────────────────────────────
describe('RootRedirect — aiguillage racine', () => {
  it('envoie une session mfaPending sur /mfa-setup avant tout aiguillage par rôle', () => {
    signIn(makeUser('super_admin'), PENDING_TOKEN)
    renderGuard(<RootRedirect />)
    expect(screen.getByText('ECRAN_MFA_SETUP')).toBeTruthy()
    expect(screen.queryByText('ECRAN_PLATFORM')).toBeNull()
  })

  it('envoie un employee en mfaPending sur /mfa-setup, pas /mon-espace', () => {
    signIn(makeUser('employee'), PENDING_TOKEN)
    renderGuard(<RootRedirect />)
    expect(screen.getByText('ECRAN_MFA_SETUP')).toBeTruthy()
    expect(screen.queryByText('ECRAN_MON_ESPACE')).toBeNull()
  })

  it('envoie un acteur cabinet en mfaPending sur /mfa-setup, pas /agency/dashboard', () => {
    signIn(makeUser('agency_owner', { actorType: 'agency', agencyId: 'a1' }), PENDING_TOKEN)
    renderGuard(<RootRedirect />)
    expect(screen.getByText('ECRAN_MFA_SETUP')).toBeTruthy()
    expect(screen.queryByText('ECRAN_AGENCY')).toBeNull()
  })

  it('aiguille normalement un super_admin avec un token sain', () => {
    signIn(makeUser('super_admin'), NORMAL_TOKEN)
    renderGuard(<RootRedirect />)
    expect(screen.getByText('ECRAN_PLATFORM')).toBeTruthy()
  })

  it('aiguille normalement un employee avec un token sain', () => {
    signIn(makeUser('employee'), NORMAL_TOKEN)
    renderGuard(<RootRedirect />)
    expect(screen.getByText('ECRAN_MON_ESPACE')).toBeTruthy()
  })

  // La racine du domaine sert désormais la page de présentation publique :
  // un visiteur n'est plus jeté sur le formulaire de connexion, il découvre
  // le produit et choisit d'entrer. L'accès reste sur /login.
  it("sans session, sert la page d'accueil publique (plus de renvoi vers /login)", async () => {
    renderGuard(<Suspense fallback={null}><RootRedirect /></Suspense>)
    expect(await screen.findByText('ECRAN_ACCUEIL')).toBeTruthy()
    expect(screen.queryByText('ECRAN_LOGIN')).toBeNull()
  })
})

// ── Absence de boucle de redirection ──────────────────────────────────────────
describe('/mfa-setup n’est PAS gardé — pas de boucle de redirection', () => {
  it('la page d’enrôlement se rend normalement en session mfaPending', () => {
    signIn(makeUser('super_admin'), PENDING_TOKEN)
    render(
      <MemoryRouter initialEntries={['/mfa-setup']}>
        <Routes>
          {/* Reproduit App.tsx : /mfa-setup est hors de tout garde. */}
          <Route path="/mfa-setup" element={<div>PAGE_ENROLEMENT</div>} />
          <Route path="/login" element={<div>ECRAN_LOGIN</div>} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByText('PAGE_ENROLEMENT')).toBeTruthy()
  })

  it('la redirection converge en un seul saut : /protegee → /mfa-setup et s’arrête là', () => {
    signIn(makeUser('super_admin'), PENDING_TOKEN)
    render(
      <MemoryRouter initialEntries={['/protegee']}>
        <Routes>
          <Route path="/protegee" element={<PlatformGuard>{PROTECTED}</PlatformGuard>} />
          {/* /mfa-setup non gardé → point fixe, la navigation s'arrête. */}
          <Route path="/mfa-setup" element={<div>PAGE_ENROLEMENT</div>} />
          <Route path="/platform/dashboard" element={<div>ECRAN_PLATFORM</div>} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByText('PAGE_ENROLEMENT')).toBeTruthy()
    expect(screen.queryByText('ECRAN_PLATFORM')).toBeNull()
  })

  it('les routes publiques (login, mot de passe oublié, carrières) restent libres', () => {
    signIn(makeUser('employee'), PENDING_TOKEN)
    render(
      <MemoryRouter initialEntries={['/careers/sotra']}>
        <Routes>
          <Route path="/login" element={<div>ECRAN_LOGIN</div>} />
          <Route path="/forgot-password" element={<div>ECRAN_FORGOT</div>} />
          <Route path="/reset-password" element={<div>ECRAN_RESET</div>} />
          <Route path="/careers/:tenantSlug" element={<div>ECRAN_CARRIERES</div>} />
          <Route path="/mfa-setup" element={<div>PAGE_ENROLEMENT</div>} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByText('ECRAN_CARRIERES')).toBeTruthy()
    expect(screen.queryByText('PAGE_ENROLEMENT')).toBeNull()
  })
})
