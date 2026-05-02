import { Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Users, CreditCard, Calendar, Briefcase,
  BookOpen, Receipt, BarChart3, Settings,
  ChevronLeft, ChevronRight, Sparkles, TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import type { UserRole } from '@nexusrh/shared'

interface NavItem {
  path: string
  label: string
  icon: React.ElementType
  roles: UserRole[] | ['*']
}

const navItems: NavItem[] = [
  {
    path: '/dashboard',
    label: 'Tableau de bord',
    icon: LayoutDashboard,
    roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'],
  },
  {
    path: '/employees',
    label: 'Collaborateurs',
    icon: Users,
    roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly', 'payroll_service'],
  },
  {
    path: '/payroll',
    label: 'Paie',
    icon: CreditCard,
    roles: ['hr_manager', 'hr_officer', 'admin', 'payroll_service'],
  },
  {
    path: '/absences',
    label: 'Absences',
    icon: Calendar,
    roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'],
  },
  {
    path: '/recruitment',
    label: 'Recrutement',
    icon: Briefcase,
    roles: ['hr_manager', 'hr_officer', 'manager', 'admin', 'readonly'],
  },
  {
    path: '/training',
    label: 'Formation',
    icon: BookOpen,
    roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'],
  },
  {
    path: '/expenses',
    label: 'Notes de frais',
    icon: Receipt,
    roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'],
  },
  {
    path: '/careers',
    label: 'Carrières & Entretiens',
    icon: TrendingUp,
    roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'],
  },
  {
    path: '/reporting',
    label: 'Reporting',
    icon: BarChart3,
    roles: ['hr_manager', 'admin', 'readonly'],
  },
  {
    path: '/settings',
    label: 'Paramètres',
    icon: Settings,
    roles: ['admin'],
  },
]

export function Sidebar() {
  const location = useLocation()
  const { sidebarCollapsed, toggleSidebarCollapse } = useUIStore()
  const { user, tenantConfig } = useAuthStore()

  const primaryColor = tenantConfig?.primaryColor ?? '#4F46E5'

  const visibleItems = navItems.filter((item) => {
    if (!user) return false
    // Never show RH nav items to employees (they use EmployeeLayout)
    if (user.role === 'employee') return false
    // Never show platform nav to super_admin (they use PlatformLayout)
    if (user.role === 'super_admin') return false
    const rolesArray = item.roles as string[]
    if (rolesArray.includes('*')) return true
    return rolesArray.includes(user.role)
  })

  function renderLogo() {
    if (tenantConfig?.logoUrl) {
      return (
        <img
          src={tenantConfig.logoUrl}
          alt={tenantConfig.name}
          className="w-8 h-8 rounded-lg object-cover flex-shrink-0"
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
        className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
        style={{ backgroundColor: primaryColor }}
      >
        {initials}
      </div>
    )
  }

  return (
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
              className="flex items-center gap-2 min-w-0"
            >
              {tenantConfig ? (
                <>
                  {renderLogo()}
                  <span className="font-bold text-sm text-white truncate">
                    {tenantConfig.name}
                  </span>
                </>
              ) : (
                <>
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: primaryColor }}
                  >
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <span className="font-bold text-lg">NexusRH</span>
                </>
              )}
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
        {visibleItems.map((item) => {
          const Icon = item.icon
          const isActive = location.pathname.startsWith(item.path)

          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors group',
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

      {/* User info */}
      <div className="border-t border-gray-800 p-3">
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
                className="overflow-hidden"
              >
                <p className="text-sm font-medium text-white truncate">
                  {user?.firstName} {user?.lastName}
                </p>
                <p className="text-xs text-gray-400 truncate">
                  {user?.role === 'payroll_service' ? 'Service Paie' : user?.role}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  )
}
