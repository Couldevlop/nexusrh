import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { User, TenantConfig } from '@nexusrh/shared'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  entityId: string | null
  tenantConfig: TenantConfig | null
  setAuth: (user: User, accessToken: string, refreshToken: string, tenantConfig?: TenantConfig) => void
  setTokens: (accessToken: string, refreshToken: string) => void
  setEntityId: (entityId: string) => void
  setTenantConfig: (config: TenantConfig) => void
  logout: () => void
}

function applyTenantTheme(config: TenantConfig): void {
  document.documentElement.style.setProperty('--primary-color', config.primaryColor)
  document.documentElement.style.setProperty('--secondary-color', config.secondaryColor)
}

function resetTenantTheme(): void {
  document.documentElement.style.removeProperty('--primary-color')
  document.documentElement.style.removeProperty('--secondary-color')
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      entityId: null,
      tenantConfig: null,

      setAuth: (user, accessToken, refreshToken, tenantConfig) => {
        if (tenantConfig) {
          applyTenantTheme(tenantConfig)
        }
        set({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
          tenantConfig: tenantConfig ?? null,
        })
      },

      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),

      setEntityId: (entityId) => set({ entityId }),

      setTenantConfig: (config) => {
        applyTenantTheme(config)
        set({ tenantConfig: config })
      },

      logout: () => {
        resetTenantTheme()
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          tenantConfig: null,
        })
      },
    }),
    {
      name: 'nexusrh-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        entityId: state.entityId,
        tenantConfig: state.tenantConfig,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.tenantConfig) {
          applyTenantTheme(state.tenantConfig)
        }
      },
    }
  )
)
