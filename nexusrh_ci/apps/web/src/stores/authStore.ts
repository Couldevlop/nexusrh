import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface TenantConfig {
  primaryColor: string
  secondaryColor: string
  logoUrl: string | null
  name: string
  slug: string
  city?: string
}

export interface AuthUser {
  sub: string
  tenantId: string | null
  schemaName: string
  role: 'super_admin' | 'admin' | 'hr_manager' | 'hr_officer' | 'manager' | 'employee' | 'readonly'
  email: string
  firstName: string
  lastName: string
  employeeId: string | null
}

interface AuthState {
  user: AuthUser | null
  token: string | null
  refreshToken: string | null
  tenantConfig: TenantConfig | null

  setAuth: (user: AuthUser, token: string, refreshToken: string, tenantConfig: TenantConfig | null) => void
  setToken: (token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      tenantConfig: null,

      setAuth: (user, token, refreshToken, tenantConfig) => {
        set({ user, token, refreshToken, tenantConfig })
        // Appliquer les couleurs du tenant en CSS variables
        if (tenantConfig) {
          applyTenantTheme(tenantConfig)
        }
      },

      setToken: (token) => set({ token }),

      logout: () => {
        set({ user: null, token: null, refreshToken: null, tenantConfig: null })
        resetTheme()
      },

      isAuthenticated: () => !!get().token && !!get().user,
    }),
    {
      name: 'nexusrhci-auth',
      onRehydrateStorage: () => (state) => {
        // Ré-appliquer le thème au chargement
        if (state?.tenantConfig) {
          applyTenantTheme(state.tenantConfig)
        }
      },
    }
  )
)

function hexToHsl(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return '0 0% 50%'

  let r = parseInt(result[1]!, 16) / 255
  let g = parseInt(result[2]!, 16) / 255
  let b = parseInt(result[3]!, 16) / 255

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
  root.style.setProperty('--primary', hexToHsl(config.primaryColor))
  root.style.setProperty('--ring', hexToHsl(config.primaryColor))
  if (config.secondaryColor) {
    root.style.setProperty('--secondary', hexToHsl(config.secondaryColor))
  }
}

function resetTheme() {
  const root = document.documentElement
  root.style.setProperty('--primary', '20 100% 48%')
  root.style.setProperty('--ring', '20 100% 48%')
  root.style.setProperty('--secondary', '33 90% 50%')
}
