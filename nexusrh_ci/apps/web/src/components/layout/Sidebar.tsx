import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Users, CreditCard, Calendar,
  Smartphone, LogOut, ChevronRight, Briefcase, BookOpen,
  Receipt, BarChart3, Settings, Star, ShieldCheck, ScrollText,
  Calculator, ClipboardCheck, X,
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

interface SidebarProps {
  open?: boolean
  onClose?: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const { user, tenantConfig, logout } = useAuthStore()
  const initials = tenantConfig?.name
    ? tenantConfig.name.split(' ').slice(0, 2).map((w: string) => w[0]).join('').toUpperCase()
    : 'RH'

  const navItems = HR_NAV.filter(item =>
    !item.roles || item.roles.includes(user?.role ?? '')
  )

  return (
    <>
      {/* Overlay mobile */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={cn(
        'flex h-full w-64 flex-col border-r border-border bg-card z-50 transition-transform duration-300',
        'fixed inset-y-0 left-0 lg:relative lg:translate-x-0',
        open ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
      )}>
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border p-4 bg-gradient-to-r from-primary/10 to-transparent">
          {tenantConfig?.logoUrl ? (
            <img src={tenantConfig.logoUrl} alt="Logo" className="h-9 w-9 rounded-xl object-cover shadow-sm" />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
              {initials}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{tenantConfig?.name ?? 'NexusRH CI'}</p>
            {tenantConfig?.city && (
              <p className="text-xs text-muted-foreground">{tenantConfig.city}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="lg:hidden rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose}
              className={({ isActive }) => cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              <ChevronRight className="h-3 w-3 opacity-30" />
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shrink-0 shadow-sm">
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user?.firstName} {user?.lastName}</p>
              <p className="truncate text-xs text-muted-foreground capitalize">{user?.role?.replace('_', ' ')}</p>
            </div>
            <button onClick={logout} className="rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title="Déconnexion">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
