import { Navigate } from 'react-router-dom'
import { useAuthStore, useMfaPending, type AuthUser } from '@/stores/authStore'

type Role = AuthUser['role']

/**
 * MFA obligatoire — verrou de NAVIGATION.
 *
 * Tant que le JWT porte le claim `mfaPending: true`, la session est restreinte à
 * l'enrôlement : l'API refuse toute route métier en 403. Chaque garde applique
 * donc ce contrôle APRÈS `!user → /login` mais AVANT les contrôles de rôle.
 *
 * L'ORDRE est critique : placé après le contrôle de rôle, un super_admin en
 * mfaPending serait d'abord renvoyé par PlatformGuard vers /platform/dashboard
 * (puis rebondirait de garde en garde) sans jamais atteindre l'enrôlement —
 * c'est précisément le rebond à l'origine de l'incident de production.
 *
 * `/mfa-setup` (comme /login, /forgot-password, /reset-password et la page
 * carrières publique) est déclaré HORS de tout garde dans App.tsx : la
 * redirection converge en un saut, sans boucle possible.
 */
const MFA_SETUP_PATH = '/mfa-setup'

interface RoleGuardProps {
  children: React.ReactNode
  allowedRoles: Role[]
  redirectTo?: string
}

export function RoleGuard({ children, allowedRoles, redirectTo = '/dashboard' }: RoleGuardProps) {
  const user = useAuthStore((s) => s.user)
  const mfaPending = useMfaPending()
  if (!user) return <Navigate to="/login" replace />
  if (mfaPending) return <Navigate to={MFA_SETUP_PATH} replace />
  if (!allowedRoles.includes(user.role)) return <Navigate to={redirectTo} replace />
  return <>{children}</>
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated())
  const user = useAuthStore((s) => s.user)
  const activeTenant = useAuthStore((s) => s.activeTenant)
  const mfaPending = useMfaPending()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (mfaPending) return <Navigate to={MFA_SETUP_PATH} replace />
  // Compte cabinet sans entreprise cliente active : l'app RH n'aurait aucun
  // tenant à afficher (tableau de bord vide) → retour au portail cabinet.
  if (user?.actorType === 'agency' && !activeTenant) return <Navigate to="/agency/dashboard" replace />
  return <>{children}</>
}

// Tableau de bord RH (/dashboard) : réservé aux rôles tenant. Le super_admin
// (espace plateforme) et l'employee (self-service) en sont exclus et renvoyés
// vers LEUR espace — évite qu'un super_admin accède à la coquille RH par URL
// directe (AUTH-007), sans créer de boucle de redirection.
export function RhDashboardGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const habPermissions = useAuthStore((s) => s.habPermissions)
  const habilitated = (habPermissions?.length ?? 0) > 0
  const mfaPending = useMfaPending()
  if (!user) return <Navigate to="/login" replace />
  if (mfaPending) return <Navigate to={MFA_SETUP_PATH} replace />
  if (user.role === 'super_admin') return <Navigate to="/platform/dashboard" replace />
  // Un salarié HABILITÉ par fiche travaille en RH : le renvoyer au
  // self-service lui cacherait ce qu'il a été habilité à faire. Il garde son
  // espace personnel par l'entrée épinglée « Mon espace ».
  if (user.role === 'employee' && !habilitated) return <Navigate to="/mon-espace" replace />
  return <>{children}</>
}

export function PlatformGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const mfaPending = useMfaPending()
  if (!user) return <Navigate to="/login" replace />
  if (mfaPending) return <Navigate to={MFA_SETUP_PATH} replace />
  if (user.role !== 'super_admin') return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export function EmployeeGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const mfaPending = useMfaPending()
  if (!user) return <Navigate to="/login" replace />
  if (mfaPending) return <Navigate to={MFA_SETUP_PATH} replace />
  if (user.role === 'employee') return <>{children}</>
  return <Navigate to="/dashboard" replace />
}

// Portail cabinet de recrutement : accessible aux utilisateurs cabinet en
// CONTEXTE cabinet (pas en session scopée sur un tenant — dans ce cas l'app RH
// normale prend le relais via le rôle 'admin' délégué).
export function AgencyGuard({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const activeTenant = useAuthStore((s) => s.activeTenant)
  const mfaPending = useMfaPending()
  if (!user) return <Navigate to="/login" replace />
  if (mfaPending) return <Navigate to={MFA_SETUP_PATH} replace />
  if (user.actorType !== 'agency') return <Navigate to="/dashboard" replace />
  // En session scopée → rediriger vers l'app RH du tenant client.
  if (activeTenant) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}
