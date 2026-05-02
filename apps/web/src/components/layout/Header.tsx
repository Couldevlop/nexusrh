import { Bell, Search, Sparkles, LogOut, Sun, Moon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useUIStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { useLogout } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

interface HeaderProps {
  title?: string
  subtitle?: string
}

export function Header({ title, subtitle }: HeaderProps) {
  const { toggleAIDrawer, unreadCount, theme, setTheme } = useUIStore()
  const { user } = useAuthStore()
  const logout = useLogout()
  const navigate = useNavigate()

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 flex-shrink-0">
      {/* Title */}
      <div>
        {title && (
          <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        )}
        {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Search */}
        <button className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-500 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
          <Search className="w-4 h-4" />
          <span className="hidden md:inline">Rechercher...</span>
          <kbd className="hidden md:inline text-xs bg-white border border-gray-300 rounded px-1">
            ⌘K
          </kbd>
        </button>

        {/* AI Assistant */}
        <button
          onClick={toggleAIDrawer}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          <span className="hidden md:inline">IA</span>
        </button>

        {/* Notifications */}
        <button className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
          <Bell className="w-5 h-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        >
          {theme === 'light' ? (
            <Moon className="w-5 h-5" />
          ) : (
            <Sun className="w-5 h-5" />
          )}
        </button>

        {/* Logout */}
        <button
          onClick={() => logout.mutate()}
          className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          title="Se déconnecter"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>
    </header>
  )
}
