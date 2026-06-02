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
  role: 'super_admin' | 'admin' | 'hr_manager' | 'hr_officer' | 'manager' | 'employee' | 'readonly' | 'raf_site' | 'agency_owner' | 'agency_member'
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
  logout: () => void
  isAuthenticated: () => boolean
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    if (!part) return {}
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
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
      onRehydrateStorage: () => (state) => {
        if (state?.tenantConfig) applyTenantTheme(state.tenantConfig)
        else if (state?.agencyConfig) applyAgencyTheme(state.agencyConfig)
      },
    }
  )
)

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

function applyTenantTheme(config: TenantConfig) {
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
