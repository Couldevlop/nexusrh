import { useEffect } from 'react'
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard,
  Calendar,
  FileText,
  Receipt,
  BookOpen,
  User,
  ChevronLeft,
  ChevronRight,
  LogOut,
  TrendingUp,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'

const employeeNavItems = [
  { path: '/mon-espace', label: 'Mon espace', icon: LayoutDashboard, exact: true },
  { path: '/mon-espace/absences', label: 'Mes absences', icon: Calendar },
  { path: '/mon-espace/bulletins', label: 'Mes bulletins', icon: FileText },
  { path: '/mon-espace/notes-de-frais', label: 'Mes notes de frais', icon: Receipt },
  { path: '/mon-espace/formation', label: 'Ma formation', icon: BookOpen },
  { path: '/mon-espace/entretiens', label: 'Mes entretiens', icon: TrendingUp },
  { path: '/mon-espace/profil', label: 'Mon profil', icon: User },
]

export function EmployeeLayout() {
  const { isAuthenticated, user, tenantConfig, logout } = useAuthStore()
  const { sidebarCollapsed, toggleSidebarCollapse } = useUIStore()
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login', { replace: true })
      return
    }
    if (user && user.role !== 'employee') {
      navigate('/dashboard', { replace: true })
    }
  }, [isAuthenticated, user, navigate])

  if (!isAuthenticated || !user || user.role !== 'employee') return null

  const primaryColor = tenantConfig?.primaryColor ?? '#4F46E5'

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  function isItemActive(item: { path: string; exact?: boolean }): boolean {
    if (item.exact) {
      return location.pathname === item.path
    }
    return location.pathname.startsWith(item.path)
  }

  function renderLogo() {
    if (tenantConfig?.logoUrl) {
      return (
        <img
          src={tenantConfig.logoUrl}
          alt={tenantConfig.name}
          className="w-8 h-8 rounded-lg object-cover"
        />
      )
    }
    const initials = tenantConfig?.name
      ? tenantConfig.name
          .split(' ')
          .slice(0, 2)
          .map((w) => w.charAt(0).toUpperCase())
          .join('')
      : 'NR'
    return (
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
        style={{ backgroundColor: primaryColor }}
      >
        {initials}
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <motion.aside
        animate={{ width: sidebarCollapsed ? 64 : 256 }}
        transition={{ duration: 0.2 }}
        className="flex flex-col h-screen bg-gray-900 text-white border-r border-gray-800 flex-shrink-0"
      >
        {/* Logo */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800 h-16">
          <AnimatePresence mode="wait">
            {!sidebarCollapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2"
              >
                {renderLogo()}
                <span className="font-bold text-sm text-white truncate">
                  {tenantConfig?.name ?? 'NexusRH'}
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={toggleSidebarCollapse}
            className="p-1.5 rounded-md hover:bg-gray-800 transition-colors ml-auto"
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-2 space-y-1">
          {employeeNavItems.map((item) => {
            const Icon = item.icon
            const isActive = isItemActive(item)

            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
                  isActive
                    ? 'text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                )}
                style={isActive ? { backgroundColor: primaryColor } : undefined}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                <AnimatePresence mode="wait">
                  {!sidebarCollapsed && (
                    <motion.span
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="text-sm font-medium whitespace-nowrap"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </Link>
            )
          })}
        </nav>

        {/* User info + Logout */}
        <div className="border-t border-gray-800 p-3 space-y-2">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold text-white"
              style={{ backgroundColor: primaryColor }}
            >
              {user?.firstName?.charAt(0)}
              {user?.lastName?.charAt(0)}
            </div>
            <AnimatePresence mode="wait">
              {!sidebarCollapsed && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="overflow-hidden flex-1"
                >
                  <p className="text-sm font-medium text-white truncate">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-xs text-gray-400 truncate">Collaborateur</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors w-full text-gray-400 hover:bg-gray-800 hover:text-red-400"
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            <AnimatePresence mode="wait">
              {!sidebarCollapsed && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-sm whitespace-nowrap"
                >
                  Déconnexion
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>
      </motion.aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-800">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-gray-500">Mon espace collaborateur</p>
            </div>
          </div>
          {tenantConfig && (
            <span
              className="text-xs font-medium px-3 py-1 rounded-full text-white"
              style={{ backgroundColor: primaryColor }}
            >
              {tenantConfig.name}
            </span>
          )}
        </header>

        <main className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.15 }}
              className="min-h-full"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
