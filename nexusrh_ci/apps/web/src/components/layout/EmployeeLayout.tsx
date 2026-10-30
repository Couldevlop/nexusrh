import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, NavLink, Link, useLocation } from 'react-router-dom'
import { Home, Calendar, FileText, User, LogOut, Receipt, BookOpen, TrendingUp, Menu, X, Briefcase, Rocket, MessageSquare, Clock, AlertTriangle, ListChecks, LayoutDashboard, FileSignature } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher'
import { cn } from '@/lib/utils'
import { isModuleEnabled, type ModuleKey } from '@/lib/modules'
import ApprovalAlerts from '@/components/approvals/ApprovalAlerts'
import { usePendingApprovals } from '@/components/approvals/workflow'
import { useSignedContractOptions } from '@/lib/signed-contracts'

interface EmployeeNavItem {
  to: string
  labelKey: string
  icon: React.ElementType
  end?: boolean
  /** Module activable : entrée MASQUÉE si le module est désactivé pour le tenant. */
  moduleKey?: ModuleKey
  /** Option tenant (Paramètres) : entrée MASQUÉE si l'admin ne l'a pas activée. */
  option?: 'employeeContractAccess'
}

const NAV: EmployeeNavItem[] = [
  { to: '/mon-espace',              labelKey: 'nav.home',        icon: Home,        end: true },
  { to: '/mon-espace/integration',  labelKey: 'nav.integration', icon: Rocket },
  { to: '/mon-espace/absences',     labelKey: 'nav.absences',    icon: Calendar },
  { to: '/mon-espace/pointages',    labelKey: 'nav.attendance',  icon: Clock, moduleKey: 'attendance' },
  { to: '/mon-espace/avertissements', labelKey: 'nav.attendanceWarnings', icon: AlertTriangle, moduleKey: 'attendance' },
  { to: '/mon-espace/bulletins',    labelKey: 'nav.payslips',    icon: FileText },
  { to: '/mon-espace/contrat',      labelKey: 'nav.contract',    icon: FileSignature, moduleKey: 'contracts', option: 'employeeContractAccess' },
  { to: '/mon-espace/frais',        labelKey: 'nav.expenses',    icon: Receipt },
  { to: '/mon-espace/formation',    labelKey: 'nav.training',    icon: BookOpen },
  { to: '/mon-espace/carriere',     labelKey: 'nav.career',      icon: TrendingUp },
  { to: '/mon-espace/offres',       labelKey: 'nav.offers',      icon: Briefcase },
  { to: '/mon-espace/climat',       labelKey: 'nav.climate',     icon: MessageSquare },
  { to: '/mon-espace/profil',       labelKey: 'nav.profile',     icon: User },
]

// « Mes validations » pour un chef d'équipe au rôle employé (valideur N+1/N+2) :
// entrée affichée seulement s'il a des demandes à suivre. Les rôles RH/manager
// valident depuis l'espace RH (/approvals).
const VALIDATIONS_ROUTE = '/mon-espace/validations'
const VALIDATIONS_ITEM: EmployeeNavItem = { to: VALIDATIONS_ROUTE, labelKey: 'nav.validations', icon: ListChecks }

const ROUTE_TITLE_KEYS: Record<string, string> = {
  '/mon-espace': 'nav.titles.home',
  '/mon-espace/integration': 'nav.titles.integration',
  '/mon-espace/absences': 'nav.titles.absences',
  '/mon-espace/pointages': 'nav.titles.attendance',
  '/mon-espace/avertissements': 'nav.titles.attendanceWarnings',
  '/mon-espace/bulletins': 'nav.titles.payslips',
  '/mon-espace/contrat': 'nav.titles.contract',
  '/mon-espace/frais': 'nav.titles.expenses',
  '/mon-espace/formation': 'nav.titles.training',
  '/mon-espace/carriere': 'nav.titles.career',
  '/mon-espace/offres': 'nav.titles.offers',
  '/mon-espace/climat': 'nav.titles.climate',
  '/mon-espace/profil': 'nav.titles.profile',
  '/mon-espace/validations': 'nav.titles.validations',
}

export default function EmployeeLayout() {
  const { t } = useTranslation('monEspace')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { user, tenantConfig, logout } = useAuthStore()
  const location = useLocation()
  const pageTitle = t(ROUTE_TITLE_KEYS[location.pathname] ?? 'nav.titles.default')
  const initials = tenantConfig?.name
    ? tenantConfig.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : 'RH'
  // Module activable (ex. Badgeuse/Pointage, désactivé par défaut) : entrée
  // masquée si le tenant n'a pas activé le module — piloté par le super_admin.
  const { data: contractOptions } = useSignedContractOptions(!!user)
  const moduleNav = NAV.filter((item) => (!item.moduleKey || isModuleEnabled(tenantConfig, item.moduleKey))
    && (!item.option || contractOptions?.[item.option] === true))
  const isEmployee = user?.role === 'employee'
  const { data: pending } = usePendingApprovals(!!user)
  const pendingCount = (pending?.summary?.actionable ?? 0) + (pending?.summary?.readOnly ?? 0)
  // Inséré juste après « Accueil » : reste visible dans la barre mobile (5 premières entrées).
  const visibleNav = isEmployee && pendingCount > 0
    ? [...moduleNav.slice(0, 1), VALIDATIONS_ITEM, ...moduleNav.slice(1)]
    : moduleNav
  // Lien de la bannière d'échéances : page servie dans l'espace où l'utilisateur valide.
  const approvalsHref = isEmployee ? VALIDATIONS_ROUTE : '/approvals'

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
              <p className="text-xs text-muted-foreground">{t('nav.personalSpace')}</p>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="lg:hidden rounded-md p-1 text-muted-foreground hover:bg-accent">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Nav */}
          <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
            {/* RH / managers : retour à l'espace RH (ils sont aussi salariés) */}
            {!isEmployee && (
              <Link
                to="/dashboard"
                onClick={() => setSidebarOpen(false)}
                className="mb-2 flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-150 hover:bg-accent hover:text-accent-foreground"
              >
                <LayoutDashboard className="h-4 w-4 shrink-0" />
                {t('nav.backToRh')}
              </Link>
            )}
            {visibleNav.map(({ to, labelKey, icon: Icon, end }) => (
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
                {t(labelKey)}
              </NavLink>
            ))}
          </nav>

          {/* Langue */}
          <div className="px-3 pb-1 flex items-center justify-center">
            <LanguageSwitcher />
          </div>

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

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Échéances de validation : un chef d'équipe au rôle employé peut être valideur N+1 */}
          <ApprovalAlerts href={approvalsHref} />
          <main className="flex-1 overflow-auto bg-background pb-16 lg:pb-0">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Bottom tab bar — mobile uniquement */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-card/95 backdrop-blur-sm">
        <div className="flex">
          {visibleNav.slice(0, 5).map(({ to, labelKey, icon: Icon, end }) => (
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
              <span>{t(labelKey)}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
