import { useEffect } from 'react'
import { Outlet, useNavigate, NavLink, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Building2, LayoutDashboard, FileText, Settings,
  ChevronLeft, ChevronRight, LogOut, Sparkles, Bell,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'

const navItems = [
  { path: '/platform/dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { path: '/platform/tenants', label: 'Tenants', icon: Building2 },
  { path: '/platform/logs', label: 'Logs activité', icon: FileText },
  { path: '/platform/settings', label: 'Paramètres', icon: Settings },
]

export function PlatformLayout() {
  const { isAuthenticated, user, logout } = useAuthStore()
  const { sidebarCollapsed, toggleSidebarCollapse } = useUIStore()
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (!isAuthenticated) { navigate('/login', { replace: true }); return }
    if (user?.role !== 'super_admin') navigate('/dashboard', { replace: true })
  }, [isAuthenticated, user, navigate])

  if (!isAuthenticated || user?.role !== 'super_admin') return null

  const initials = `${user?.firstName?.charAt(0) ?? ''}${user?.lastName?.charAt(0) ?? ''}`
  const activeLabel = navItems.find(
    n => location.pathname === n.path || (n.path !== '/platform/dashboard' && location.pathname.startsWith(n.path))
  )?.label ?? 'Dashboard'

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* ── Sidebar ── */}
      <motion.aside
        animate={{ width: sidebarCollapsed ? 72 : 256 }}
        transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
        className="flex flex-col h-screen flex-shrink-0 relative z-10"
        style={{
          background: 'linear-gradient(160deg, #0f172a 0%, #1e1b4b 60%, #0f172a 100%)',
          borderRight: '1px solid rgba(139,92,246,0.15)',
        }}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-3 h-16 border-b border-white/5">
          <AnimatePresence mode="wait">
            {!sidebarCollapsed ? (
              <motion.div key="expanded" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2.5 flex-1 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shadow-lg shadow-violet-900/50 flex-shrink-0">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div className="leading-none min-w-0">
                  <p className="text-sm font-bold text-white tracking-tight">NexusRH</p>
                  <p className="text-[10px] text-purple-400 mt-0.5 font-medium">Platform Admin</p>
                </div>
              </motion.div>
            ) : (
              <motion.div key="collapsed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center mx-auto shadow-lg shadow-violet-900/50">
                <Sparkles className="w-4 h-4 text-white" />
              </motion.div>
            )}
          </AnimatePresence>
          {!sidebarCollapsed && (
            <button onClick={toggleSidebarCollapse}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors ml-1 flex-shrink-0">
              <ChevronLeft className="w-4 h-4 text-slate-400" />
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto p-2.5 space-y-0.5">
          {!sidebarCollapsed && (
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold px-2.5 pt-2 pb-1.5">
              Navigation
            </p>
          )}
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = location.pathname === item.path ||
              (item.path !== '/platform/dashboard' && location.pathname.startsWith(item.path))
            return (
              <NavLink key={item.path} to={item.path} title={sidebarCollapsed ? item.label : undefined}
                className={cn(
                  'flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition-all duration-150 group',
                  isActive
                    ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-md shadow-violet-900/40'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                )}>
                <Icon size={17} className="flex-shrink-0" />
                <AnimatePresence mode="wait">
                  {!sidebarCollapsed && (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="text-sm font-medium whitespace-nowrap flex-1">
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </NavLink>
            )
          })}
        </nav>

        {/* Bottom */}
        <div className="p-2.5 border-t border-white/5 space-y-1">
          {sidebarCollapsed && (
            <button onClick={toggleSidebarCollapse}
              className="w-full flex items-center justify-center py-2 rounded-xl hover:bg-white/5 transition-colors">
              <ChevronRight className="w-4 h-4 text-slate-400" />
            </button>
          )}
          <div className={cn('flex items-center gap-2.5 p-2 rounded-xl', !sidebarCollapsed && 'bg-white/5')}>
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white">
              {initials}
            </div>
            <AnimatePresence mode="wait">
              {!sidebarCollapsed && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{user?.firstName} {user?.lastName}</p>
                  <p className="text-[10px] text-slate-400 truncate">{user?.email}</p>
                </motion.div>
              )}
            </AnimatePresence>
            {!sidebarCollapsed && (
              <button onClick={() => { logout(); navigate('/login', { replace: true }) }}
                className="p-1 rounded-lg hover:bg-red-500/10 transition-colors" title="Déconnexion">
                <LogOut size={14} className="text-slate-500 hover:text-red-400 transition-colors" />
              </button>
            )}
          </div>
          {sidebarCollapsed && (
            <button onClick={() => { logout(); navigate('/login', { replace: true }) }}
              className="w-full flex items-center justify-center py-2 rounded-xl hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors">
              <LogOut size={15} />
            </button>
          )}
        </div>
      </motion.aside>

      {/* ── Main ── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <header className="h-16 bg-white border-b border-gray-100 flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-400">Plateforme</span>
            <span className="text-gray-200 mx-1">/</span>
            <span className="font-semibold text-gray-800">{activeLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="relative p-2 rounded-xl hover:bg-gray-100 transition-colors">
              <Bell size={16} className="text-gray-500" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-red-500 rounded-full ring-2 ring-white" />
            </button>
            <div className="h-6 w-px bg-gray-200 mx-1" />
            <div className="flex items-center gap-2 px-3 py-1.5 bg-violet-50 border border-violet-100 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 inline-block animate-pulse" />
              <span className="text-xs font-semibold text-violet-700">Super Admin</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-slate-50">
          <AnimatePresence mode="wait">
            <motion.div key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="min-h-full">
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
