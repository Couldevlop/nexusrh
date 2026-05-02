import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface Notification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  read: boolean
  createdAt: string
}

interface UIState {
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  theme: 'light' | 'dark' | 'system'
  aiDrawerOpen: boolean
  notifications: Notification[]
  unreadCount: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebarCollapse: () => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  toggleAIDrawer: () => void
  setAIDrawerOpen: (open: boolean) => void
  addNotification: (notification: Omit<Notification, 'id' | 'read' | 'createdAt'>) => void
  markNotificationRead: (id: string) => void
  markAllNotificationsRead: () => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      sidebarCollapsed: false,
      theme: 'light',
      aiDrawerOpen: false,
      notifications: [],
      unreadCount: 0,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebarCollapse: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      toggleAIDrawer: () => set((s) => ({ aiDrawerOpen: !s.aiDrawerOpen })),
      setAIDrawerOpen: (open) => set({ aiDrawerOpen: open }),

      addNotification: (notification) => {
        const newNotif: Notification = {
          ...notification,
          id: crypto.randomUUID(),
          read: false,
          createdAt: new Date().toISOString(),
        }
        set((s) => ({
          notifications: [newNotif, ...s.notifications].slice(0, 50),
          unreadCount: s.unreadCount + 1,
        }))
      },

      markNotificationRead: (id) => {
        set((s) => ({
          notifications: s.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
          unreadCount: Math.max(0, s.unreadCount - 1),
        }))
      },

      markAllNotificationsRead: () => {
        set((s) => ({
          notifications: s.notifications.map((n) => ({ ...n, read: true })),
          unreadCount: 0,
        }))
      },
    }),
    {
      name: 'nexusrh-ui',
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        theme: state.theme,
      }),
    }
  )
)
