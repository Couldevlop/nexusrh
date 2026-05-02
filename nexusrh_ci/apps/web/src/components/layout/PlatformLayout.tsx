import { Outlet, NavLink } from 'react-router-dom'
import { LayoutDashboard, Building2, LogOut, Settings } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/platform/dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { to: '/platform/tenants',   label: 'Tenants',          icon: Building2 },
  { to: '/platform/settings',  label: 'Paramètres',       icon: Settings },
]

export default function PlatformLayout() {
  const { user, logout } = useAuthStore()
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex h-full w-64 flex-col border-r border-border bg-slate-900 text-white">
        {/* Header */}
        <div className="border-b border-slate-700 p-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 text-sm font-bold">
              N
            </div>
            <div>
              <p className="text-sm font-bold">NexusRH CI</p>
              <p className="text-xs text-slate-400">Portail plateforme</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-orange-500 text-white'
                  : 'text-slate-300 hover:bg-slate-800'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="border-t border-slate-700 p-3">
          <div className="flex items-center gap-3 rounded-md px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-xs font-bold">
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white">{user?.firstName}</p>
              <p className="text-xs text-slate-400">Super Admin</p>
            </div>
            <button onClick={logout} className="text-slate-400 hover:text-red-400" title="Déconnexion">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto bg-background">
        <Outlet />
      </main>
    </div>
  )
}
