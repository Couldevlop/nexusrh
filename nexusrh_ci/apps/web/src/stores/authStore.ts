import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface TenantConfig {
  primaryColor: string
  secondaryColor: string
  logoUrl: string | null
  name: string
  slug: string
  city?: string
  // Option multi-pays (Palier 1) — désactivée par défaut
  hasSubsidiaries?: boolean
  payrollMode?: 'single_country' | 'multi_country'
  defaultCountryCode?: string
  // Modules activés pour ce tenant (résolus côté API — pilotés par le
  // super_admin). Absent = défauts (tout actif sauf la vue DG 360°).
  enabledModules?: Record<string, boolean>
}

// Branding d'un cabinet de recrutement (persistant pendant tout le parcours
// cabinet, y compris quand l'utilisateur agit AU NOM d'un tenant client).
export interface AgencyConfig {
  id: string
  name: string
  primaryColor: string | null
  logoUrl: string | null
  city: string | null
}

export interface AuthUser {
  sub: string
  tenantId: string | null
  schemaName: string
  role: 'super_admin' | 'admin' | 'hr_manager' | 'hr_officer' | 'manager' | 'employee' | 'readonly' | 'raf_site' | 'dg' | 'agency_owner' | 'agency_member'
  email: string
  firstName: string
  lastName: string
  employeeId: string | null
  // Cabinet de recrutement (acteur multi-tenant)
  actorType?: 'agency'
  agencyId?: string
}

interface AuthState {
  user: AuthUser | null
  token: string | null
  refreshToken: string | null
  tenantConfig: TenantConfig | null
  agencyConfig: AgencyConfig | null
  // Tenant client sur lequel un cabinet agit actuellement (session scopée).
  activeTenant: { id: string; name: string } | null
  // Contexte cabinet sauvegardé pendant une session scopée (pour le restaurer).
  _agencyToken: string | null
  _agencyUser: AuthUser | null

  setAuth: (user: AuthUser, token: string, refreshToken: string, tenantConfig: TenantConfig | null, agencyConfig?: AgencyConfig | null) => void
  setToken: (token: string) => void
  // Cabinet → bascule sur un tenant client (re-scoping de token).
  activateTenant: (scopedToken: string, tenantConfig: TenantConfig) => void
  // Cabinet → quitte la session tenant, revient au contexte cabinet.
  deactivateTenant: () => void
  // Met à jour la config tenant courante (ex. après changement d'apparence en
  // paramètres) et ré-applique le thème immédiatement (sans re-login).
  updateTenantConfig: (partial: Partial<TenantConfig>) => void
  logout: () => void
  isAuthenticated: () => boolean
}

/**
 * Décode le payload d'un JWT (segment 2, base64url) sans vérifier la signature —
 * le front ne fait QUE lire des claims d'affichage/routage ; l'autorité reste
 * l'API, qui valide la signature à chaque requête.
 *
 * Robustesse : base64url (`-`/`_`) et padding absent (les émetteurs JWT
 * tronquent les `=`), payload non-objet (`null`, scalaire) neutralisé. Renvoie
 * toujours un objet — jamais d'exception, jamais `null`.
 */
function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    if (!part) return {}
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
    const json = atob(padded)
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * MFA obligatoire — la session est-elle restreinte à l'enrôlement ?
 *
 * Quand un utilisateur sans MFA enrôlée se connecte, l'API délivre un token
 * RESTREINT portant le claim `mfaPending: true` : il est refusé en 403 sur
 * toutes les routes métier (seuls `/auth/me` et les endpoints d'enrôlement
 * répondent). Sans blocage côté navigation, l'utilisateur qui saisit une URL
 * directe (`/dashboard`, `/platform/dashboard`…) atterrit sur une coquille
 * d'application entièrement en erreur.
 *
 * Source de vérité = LE CLAIM JWT, jamais un booléen stocké à part : un flag de
 * store se désynchronise (refresh, re-scoping cabinet) et se modifie
 * trivialement depuis la console. Le claim, lui, est scellé par la signature
 * serveur — le trafiquer invalide le token auprès de l'API.
 *
 * Le claim doit être STRICTEMENT `true` : aucune coercition, pour qu'une valeur
 * inattendue ne verrouille pas une session saine.
 */
export function isMfaPendingToken(token: string | null | undefined): boolean {
  if (!token) return false
  try {
    return decodeJwt(token)['mfaPending'] === true
  } catch {
    // Défense en profondeur : un token illisible ne doit jamais casser le rendu.
    return false
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      tenantConfig: null,
      agencyConfig: null,
      activeTenant: null,
      _agencyToken: null,
      _agencyUser: null,

      setAuth: (user, token, refreshToken, tenantConfig, agencyConfig = null) => {
        set({ user, token, refreshToken, tenantConfig, agencyConfig,
          activeTenant: null, _agencyToken: null, _agencyUser: null })
        if (tenantConfig) applyTenantTheme(tenantConfig)
        else if (agencyConfig) applyAgencyTheme(agencyConfig)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nexusrh:csrf-refresh'))
        }
      },

      setToken: (token) => set({ token }),

      activateTenant: (scopedToken, tenantConfig) => {
        const cur = get()
        const payload = decodeJwt(scopedToken)
        const tenantId = (payload['tenantId'] as string) ?? ''
        const scopedUser: AuthUser = {
          ...(cur.user as AuthUser),
          role: 'admin',
          tenantId,
          schemaName: (payload['schemaName'] as string) ?? (cur.user?.schemaName ?? 'platform'),
          actorType: 'agency',
          agencyId: cur.user?.agencyId,
        }
        set({
          token: scopedToken,
          user: scopedUser,
          tenantConfig,
          activeTenant: { id: tenantId, name: tenantConfig.name },
          // Sauvegarde du contexte cabinet (la 1re activation seulement).
          _agencyToken: cur._agencyToken ?? cur.token,
          _agencyUser: cur._agencyUser ?? cur.user,
        })
        applyTenantTheme(tenantConfig)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nexusrh:csrf-refresh'))
        }
      },

      deactivateTenant: () => {
        const cur = get()
        set({
          token: cur._agencyToken ?? cur.token,
          user: cur._agencyUser ?? cur.user,
          tenantConfig: null,
          activeTenant: null,
          _agencyToken: null,
          _agencyUser: null,
        })
        if (cur.agencyConfig) applyAgencyTheme(cur.agencyConfig)
        else resetTheme()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nexusrh:csrf-refresh'))
        }
      },

      updateTenantConfig: (partial) => {
        const cur = get().tenantConfig
        if (!cur) return
        const next = { ...cur, ...partial }
        set({ tenantConfig: next })
        applyTenantTheme(next)
      },

      logout: () => {
        set({ user: null, token: null, refreshToken: null, tenantConfig: null,
          agencyConfig: null, activeTenant: null, _agencyToken: null, _agencyUser: null })
        resetTheme()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nexusrh:logout'))
          window.dispatchEvent(new CustomEvent('nexusrh:csrf-clear'))
          try { window.localStorage.removeItem('nexusrhci-auth') } catch { /* quota / private mode */ }
        }
      },

      isAuthenticated: () => !!get().token && !!get().user,
    }),
    {
      name: 'nexusrhci-auth',
      // OWASP A02 — ne JAMAIS persister le refresh token (longue durée, 30 j)
      // dans localStorage : illisible par une XSS. Il vit côté serveur dans un
      // cookie httpOnly (cf. /auth/refresh-token) ; le navigateur s'en sert sans
      // y accéder en JS. Tout le reste (JWT court — déjà aussi en cookie httpOnly,
      // contexte cabinet, branding) reste persisté pour survivre à un rechargement.
      partialize: ({ refreshToken: _omit, ...rest }) => rest,
      onRehydrateStorage: () => (state) => {
        if (state?.tenantConfig) applyTenantTheme(state.tenantConfig)
        else if (state?.agencyConfig) applyAgencyTheme(state.agencyConfig)
      },
    }
  )
)

/**
 * Sélecteur dérivé (aucun état supplémentaire à maintenir) : recalcule le statut
 * MFA depuis le token courant du store à chaque changement de celui-ci.
 */
export function useMfaPending(): boolean {
  return useAuthStore((s) => isMfaPendingToken(s.token))
}

function hexToHsl(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return '0 0% 50%'

  const r = parseInt(result[1]!, 16) / 255
  const g = parseInt(result[2]!, 16) / 255
  const b = parseInt(result[3]!, 16) / 255

  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}

export function applyTenantTheme(config: TenantConfig) {
  const root = document.documentElement
  if (config.primaryColor) {
    root.style.setProperty('--primary', hexToHsl(config.primaryColor))
    root.style.setProperty('--ring', hexToHsl(config.primaryColor))
  }
  if (config.secondaryColor) {
    root.style.setProperty('--secondary', hexToHsl(config.secondaryColor))
  }
}

function applyAgencyTheme(config: AgencyConfig) {
  const root = document.documentElement
  if (config.primaryColor) {
    root.style.setProperty('--primary', hexToHsl(config.primaryColor))
    root.style.setProperty('--ring', hexToHsl(config.primaryColor))
  }
}

function resetTheme() {
  const root = document.documentElement
  root.style.setProperty('--primary', '20 100% 48%')
  root.style.setProperty('--ring', '20 100% 48%')
  root.style.setProperty('--secondary', '33 90% 50%')
}
