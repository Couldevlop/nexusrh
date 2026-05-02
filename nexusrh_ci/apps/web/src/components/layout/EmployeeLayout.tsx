import { Outlet, NavLink } from 'react-router-dom'
import { Home, Calendar, FileText, User, LogOut, Receipt, BookOpen, TrendingUp } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/mon-espace',                 label: 'Mon espace',         icon: Home,        end: true },
  { to: '/mon-espace/absences',        label: 'Mes absences',       icon: Calendar },
  { to: '/mon-espace/bulletins',       label: 'Mes bulletins',      icon: FileText },
  { to: '/mon-espace/frais',           label: 'Mes notes de frais', icon: Receipt },
  { to: '/mon-espace/formation',       label: 'Ma formation',       icon: BookOpen },
  { to: '/mon-espace/carriere',        label: 'Ma carrière',        icon: TrendingUp },
  { to: '/mon-espace/profil',          label: 'Mon profil',         icon: User },
]

export default function EmployeeLayout() {
  const { user, tenantConfig, logout } = useAuthStore()
  const initials = tenantConfig?.name
    ? tenantConfig.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : 'RH'

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex h-full w-60 flex-col border-r border-border bg-card">
        {/* Logo */}
        <div className="flex items-center gap-3 border-b border-border p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            {initials}
          </div>
          <div>
            <p className="text-sm font-semibold truncate max-w-[130px]">{tenantConfig?.name ?? 'NexusRH CI'}</p>
            <p className="text-xs text-muted-foreground">Espace personnel</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-md px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium">{user?.firstName} {user?.lastName}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            </div>
            <button onClick={logout} className="text-muted-foreground hover:text-destructive" title="Déconnexion">
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
