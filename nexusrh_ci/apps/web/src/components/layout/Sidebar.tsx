import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Users, CreditCard, Calendar,
  Smartphone, LogOut, ChevronRight, Briefcase, BookOpen,
  Receipt, BarChart3, Settings, Star, ShieldCheck, ScrollText,
  Calculator, ClipboardCheck,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: React.ElementType
  roles?: string[]
  end?: boolean
}

const HR_NAV: NavItem[] = [
  { to: '/dashboard',     label: 'Tableau de bord', icon: LayoutDashboard, end: true },
  { to: '/employees',     label: 'Employés',         icon: Users,      end: true },
  { to: '/contracts',     label: 'Contrats OHADA',   icon: ScrollText, end: true, roles: ['admin','hr_manager','hr_officer','readonly'] },
  { to: '/payroll',       label: 'Paie',             icon: CreditCard, end: true },
  { to: '/payroll/simulateur-its', label: 'Simulateur ITS', icon: Calculator, roles: ['admin','hr_manager','hr_officer'] },
  { to: '/absences',      label: 'Absences',         icon: Calendar,   end: true },
  { to: '/expenses-rh',   label: 'Notes de frais',   icon: Receipt,    end: true, roles: ['admin','hr_manager','hr_officer','manager'] },
  { to: '/recruitment',   label: 'Recrutement',      icon: Briefcase,  end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'] },
  { to: '/training',      label: 'Formations FDFP',  icon: BookOpen,   end: true, roles: ['admin','hr_manager','hr_officer','readonly'] },
  { to: '/careers',       label: 'Carrières',        icon: Star,       end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'] },
  { to: '/cnps',          label: 'CNPS & DISA',      icon: ShieldCheck,    end: true, roles: ['admin','hr_manager','hr_officer','readonly'] },
  { to: '/cnps/audit',    label: 'Audit social',     icon: ClipboardCheck, end: true, roles: ['admin','hr_manager','hr_officer'] },
  { to: '/mobile-money',  label: 'Mobile Money',     icon: Smartphone, end: true, roles: ['admin','hr_manager'] },
  { to: '/reporting',     label: 'Reporting',        icon: BarChart3,  end: true, roles: ['admin','hr_manager','hr_officer','readonly'] },
  { to: '/settings',      label: 'Paramètres',       icon: Settings,   end: true, roles: ['admin'] },
]

export function Sidebar() {
  const { user, tenantConfig, logout } = useAuthStore()
  const initials = tenantConfig?.name
    ? tenantConfig.name.split(' ').slice(0, 2).map((w: string) => w[0]).join('').toUpperCase()
    : 'RH'

  const navItems = HR_NAV.filter(item =>
    !item.roles || item.roles.includes(user?.role ?? '')
  )

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-card">
      {/* Logo tenant */}
      <div className="flex items-center gap-3 border-b border-border p-4">
        {tenantConfig?.logoUrl ? (
          <img src={tenantConfig.logoUrl} alt="Logo" className="h-9 w-9 rounded-lg object-cover" />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{tenantConfig?.name ?? 'NexusRH CI'}</p>
          {tenantConfig?.city && (
            <p className="text-xs text-muted-foreground">{tenantConfig.city}</p>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {navItems.map(({ to, label, icon: Icon, end }) => (
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
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{label}</span>
            <ChevronRight className="h-3 w-3 opacity-40" />
          </NavLink>
        ))}
      </nav>

      {/* User footer */}
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-md px-3 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shrink-0">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.firstName} {user?.lastName}</p>
            <p className="truncate text-xs text-muted-foreground capitalize">{user?.role?.replace('_', ' ')}</p>
          </div>
          <button onClick={logout} className="text-muted-foreground hover:text-destructive" title="Déconnexion">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
