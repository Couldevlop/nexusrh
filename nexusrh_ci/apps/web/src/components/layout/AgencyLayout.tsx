import { Outlet, NavLink } from 'react-router-dom'
import { LayoutDashboard, Building2, Users, Settings, LogOut, Briefcase } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

export default function AgencyLayout() {
  const { user, agencyConfig, logout } = useAuthStore()
  const isOwner = user?.role === 'agency_owner'

  const NAV = [
    { to: '/agency/dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
    { to: '/agency/clients',   label: 'Mes clients',      icon: Building2 },
    ...(isOwner ? [{ to: '/agency/members', label: 'Membres', icon: Users }] : []),
    { to: '/agency/settings',  label: 'Paramètres',       icon: Settings },
  ]

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex h-full w-64 flex-col border-r border-border bg-slate-900 text-white">
        <div className="border-b border-slate-700 p-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-indigo-500 text-sm font-bold">
              {agencyConfig?.logoUrl
                ? <img src={agencyConfig.logoUrl} alt="" className="h-full w-full object-contain" />
                : <Briefcase className="h-4 w-4" />}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{agencyConfig?.name ?? 'Cabinet'}</p>
              <p className="text-xs text-slate-400">Cabinet de recrutement</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-slate-800',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
              </NavLink>
            )
          })}
        </nav>

        <div className="border-t border-slate-700 p-3">
          <div className="flex items-center gap-3 rounded-md px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold">
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm text-white">{user?.firstName}</p>
              <p className="text-xs text-slate-400">{isOwner ? 'Propriétaire' : 'Recruteur'}</p>
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
