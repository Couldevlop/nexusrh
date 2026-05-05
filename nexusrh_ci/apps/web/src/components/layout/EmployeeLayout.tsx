import { useState } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { Home, Calendar, FileText, User, LogOut, Receipt, BookOpen, TrendingUp, Menu, X } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/mon-espace',              label: 'Accueil',     icon: Home,        end: true },
  { to: '/mon-espace/absences',     label: 'Absences',    icon: Calendar },
  { to: '/mon-espace/bulletins',    label: 'Bulletins',   icon: FileText },
  { to: '/mon-espace/frais',        label: 'Frais',       icon: Receipt },
  { to: '/mon-espace/formation',    label: 'Formation',   icon: BookOpen },
  { to: '/mon-espace/carriere',     label: 'Carrière',    icon: TrendingUp },
  { to: '/mon-espace/profil',       label: 'Profil',      icon: User },
]

const ROUTE_LABELS: Record<string, string> = {
  '/mon-espace': 'Mon espace',
  '/mon-espace/absences': 'Mes absences',
  '/mon-espace/bulletins': 'Mes bulletins',
  '/mon-espace/frais': 'Mes notes de frais',
  '/mon-espace/formation': 'Ma formation',
  '/mon-espace/carriere': 'Ma carrière',
  '/mon-espace/profil': 'Mon profil',
}

export default function EmployeeLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { user, tenantConfig, logout } = useAuthStore()
  const location = useLocation()
  const pageTitle = ROUTE_LABELS[location.pathname] ?? 'Mon espace'
  const initials = tenantConfig?.name
    ? tenantConfig.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : 'RH'

  return (
    <div className="flex h-screen overflow-hidden flex-col">
      {/* Mobile header */}
      <header className="flex lg:hidden items-center gap-3 border-b border-border bg-card px-4 py-3 shrink-0">
        <button
          onClick={() => setSidebarOpen(true)}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="flex-1 text-sm font-semibold">{pageTitle}</span>
        <span className="text-xs text-muted-foreground truncate max-w-[100px]">{tenantConfig?.name}</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside className={cn(
          'flex h-full w-60 flex-col border-r border-border bg-card z-50 transition-transform duration-300',
          'fixed inset-y-0 left-0 lg:relative lg:translate-x-0',
          sidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
        )}>
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-border p-4 bg-gradient-to-r from-primary/10 to-transparent">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{tenantConfig?.name ?? 'NexusRH CI'}</p>
              <p className="text-xs text-muted-foreground">Espace personnel</p>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="lg:hidden rounded-md p-1 text-muted-foreground hover:bg-accent">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Nav */}
          <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) => cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>

          {/* User footer */}
          <div className="border-t border-border p-3">
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shrink-0 shadow-sm">
                {user?.firstName?.[0]}{user?.lastName?.[0]}
              </div>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium">{user?.firstName} {user?.lastName}</p>
                <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
              </div>
              <button onClick={logout} className="rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>

        <main className="flex-1 overflow-auto bg-background pb-16 lg:pb-0">
          <Outlet />
        </main>
      </div>

      {/* Bottom tab bar — mobile uniquement */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-card/95 backdrop-blur-sm">
        <div className="flex">
          {NAV.slice(0, 5).map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <div className="rounded-lg p-1">
                <Icon className="h-5 w-5" />
              </div>
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
