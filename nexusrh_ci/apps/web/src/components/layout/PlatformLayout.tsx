import { Outlet, NavLink } from 'react-router-dom'
import { LayoutDashboard, Building2, LogOut, Settings, Scale, Briefcase } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import nexusrhLogo from '@/assets/NexusRH.png'

const NAV = [
  { to: '/platform/dashboard',    label: 'Tableau de bord', icon: LayoutDashboard },
  { to: '/platform/tenants',      label: 'Tenants',          icon: Building2 },
  { to: '/platform/agencies',     label: 'Cabinets',         icon: Briefcase },
  { to: '/platform/legal-watch',  label: 'Veille juridique', icon: Scale, badgeKey: 'pending' },
  { to: '/platform/settings',     label: 'Paramètres',       icon: Settings },
] as const

export default function PlatformLayout() {
  const { user, logout } = useAuthStore()
  // Badge dynamique : nombre de propositions de veille juridique en attente.
  // Silencieux si endpoint indisponible (fallback 0).
  const { data: legalStats } = useQuery<{ data: { pending: number } }>({
    queryKey: ['platform-legal-watch-stats'],
    queryFn: () => api.get('/platform/legal-watch/stats').then(r => r.data).catch(() => ({ data: { pending: 0 } })),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
  const badges: Record<string, number> = {
    pending: legalStats?.data?.pending ?? 0,
  }
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex h-full w-64 flex-col border-r border-border bg-slate-900 text-white">
        {/* Header */}
        <div className="border-b border-slate-700 p-4">
          <div className="flex flex-col gap-1.5">
            <img src={nexusrhLogo} alt="NexusRH" className="h-10 w-auto self-start object-contain" />
            <p className="text-xs text-slate-400">Portail plateforme</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const Icon = item.icon
            const badgeCount = 'badgeKey' in item ? badges[item.badgeKey] ?? 0 : 0
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-orange-500 text-white'
                    : 'text-slate-300 hover:bg-slate-800'
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                {badgeCount > 0 && (
                  <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {badgeCount > 99 ? '99+' : badgeCount}
                  </span>
                )}
              </NavLink>
            )
          })}
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
