import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import openlabLogo from '@/assets/OPENLAB.png'
import {
  LayoutDashboard, Users, CreditCard, Calendar,
  Smartphone, LogOut, ChevronRight, ChevronDown, Briefcase, BookOpen,
  Receipt, BarChart3, Settings, Star, ShieldCheck, ScrollText,
  Calculator, ClipboardCheck, X, Scale, ClipboardList, Layers, Rocket,
  Eye, Activity, Network, Gavel, DoorOpen, MessageSquare, GitBranch, GraduationCap, Grid3x3, Route, FileSignature, ShieldHalf, FileSpreadsheet,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher'
import { cn } from '@/lib/utils'
import { isModuleEnabled, type ModuleKey } from '@/lib/modules'

interface NavItem {
  to: string
  /** Clé de traduction dans le namespace `nav` */
  labelKey: string
  icon: React.ElementType
  roles?: string[]
  end?: boolean
  /** Si true, affiché uniquement quand tenantConfig.hasSubsidiaries === true */
  requiresSubsidiaries?: boolean
  /** Si true, MASQUÉ quand tenantConfig.hasSubsidiaries === true. Pour un tenant
   *  à filiales, la « Paie multi-filiales » couvre toute la paie ; l'onglet
   *  « Paie » mono-filiale ferait doublon/confusion. */
  hideIfSubsidiaries?: boolean
  /** Module activable : l'entrée est MASQUÉE si le module est désactivé pour
   *  le tenant (piloté par le super_admin — voir lib/modules.ts). */
  moduleKey?: ModuleKey
}

// Entrée épinglée en haut, hors groupe (toujours visible).
const PINNED: NavItem = { to: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard, end: true }

interface NavGroup {
  /** Clé de traduction du libellé de groupe dans le namespace `nav.groups`. */
  key: string
  items: NavItem[]
}

// Navigation RH regroupée par catégorie dépliable (la liste à plat dépassait
// ~30 entrées). Le filtrage rôle/module est appliqué AVANT le rendu ; un groupe
// sans aucune entrée visible est entièrement masqué (la sidebar se raccourcit
// donc selon le profil).
const NAV_GROUPS: NavGroup[] = [
  { key: 'collaborators', items: [
    { to: '/employees',     labelKey: 'employees',  icon: Users,      end: true },
    { to: '/contracts',     labelKey: 'contracts',  icon: ScrollText, end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'contracts' },
    { to: '/org-chart',     labelKey: 'orgChart',   icon: Network,    end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'org_chart' },
    { to: '/signature',     labelKey: 'signature',  icon: FileSignature, end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'signature' },
    { to: '/discipline',    labelKey: 'discipline', icon: Gavel,      end: true, roles: ['admin','hr_manager','hr_officer'], moduleKey: 'discipline' },
    { to: '/offboarding',   labelKey: 'offboarding', icon: DoorOpen,  end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'offboarding' },
  ] },
  { key: 'payroll', items: [
    { to: '/payroll',       labelKey: 'payroll',    icon: CreditCard, end: true, roles: ['admin','hr_manager','hr_officer','readonly'], hideIfSubsidiaries: true, moduleKey: 'payroll' },
    // Workflow multi-filiales — visible UNIQUEMENT pour les tenants à filiales :
    //  - RH centrale (admin/hr_manager) : pilotage complet (initier draft, décliner,
    //    suivi progression par filiale, consolider, clôturer) → /payroll/multi-filiales
    //  - RAF site : son unique point d'accès (soumission de SA filiale, filtré
    //    server-side sur raf_user_id = user.sub) → /raf/periods
    { to: '/payroll/multi-filiales', labelKey: 'payrollMulti', icon: Layers, end: true,
      roles: ['admin','hr_manager'], requiresSubsidiaries: true, moduleKey: 'payroll' },
    { to: '/raf/periods',   labelKey: 'payrollRaf', icon: ClipboardList, end: true,
      roles: ['raf_site'], requiresSubsidiaries: true, moduleKey: 'payroll' },
    { to: '/payroll/simulateur-its', labelKey: 'itsSimulator', icon: Calculator, roles: ['admin','hr_manager','hr_officer'], moduleKey: 'payroll' },
    { to: '/cnps',          labelKey: 'cnps',       icon: ShieldCheck,    end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'cnps' },
    { to: '/cnps/audit',    labelKey: 'cnpsAudit',  icon: ClipboardCheck, end: true, roles: ['admin','hr_manager','hr_officer'], moduleKey: 'cnps' },
    { to: '/mobile-money',  labelKey: 'mobileMoney', icon: Smartphone, end: true, roles: ['admin','hr_manager'], moduleKey: 'mobile_money' },
    { to: '/sage',          labelKey: 'sage',       icon: FileSpreadsheet, end: true, roles: ['admin','hr_manager'], moduleKey: 'sage' },
  ] },
  { key: 'timeExpenses', items: [
    { to: '/absences',      labelKey: 'absences',   icon: Calendar,   end: true, moduleKey: 'absences' },
    { to: '/expenses-rh',   labelKey: 'expenses',   icon: Receipt,    end: true, roles: ['admin','hr_manager','hr_officer','manager'], moduleKey: 'expenses' },
  ] },
  { key: 'talent', items: [
    { to: '/recruitment',   labelKey: 'recruitment', icon: Briefcase,  end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'recruitment' },
    { to: '/onboarding',    labelKey: 'onboarding', icon: Rocket,     end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'onboarding' },
    { to: '/training',      labelKey: 'training',   icon: BookOpen,   end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'training' },
    { to: '/careers',       labelKey: 'careers',    icon: Star,       end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'careers' },
    { to: '/competencies',  labelKey: 'competencies', icon: GraduationCap, end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'competencies' },
    { to: '/calibration',   labelKey: 'calibration', icon: Grid3x3,     end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'calibration' },
    { to: '/mobility',      labelKey: 'mobility',   icon: Route,       end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly'], moduleKey: 'mobility' },
    { to: '/succession',    labelKey: 'succession', icon: GitBranch,  end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'succession' },
    { to: '/climate',       labelKey: 'climate',    icon: MessageSquare, end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'climate' },
  ] },
  { key: 'analytics', items: [
    { to: '/reporting',     labelKey: 'reporting',  icon: BarChart3,  end: true, roles: ['admin','hr_manager','hr_officer','readonly'], moduleKey: 'reporting' },
    { to: '/referentiels',  labelKey: 'referentiels', icon: Scale, end: true, roles: ['admin','hr_manager','hr_officer','readonly'] },
  ] },
  { key: 'adminSecurity', items: [
    { to: '/classification', labelKey: 'classification', icon: Layers, end: true, roles: ['admin','hr_manager','hr_officer','manager','readonly','dg'], moduleKey: 'classification' },
    { to: '/security',      labelKey: 'security',   icon: ShieldHalf, end: true, roles: ['admin'], moduleKey: 'security' },
    { to: '/settings',      labelKey: 'settings',   icon: Settings,   end: true, roles: ['admin'] },
  ] },
]

// Navigation dédiée au Directeur Général : vue 360° + journal d'activité des
// responsables. Aucune action de gestion RH — lecture consolidée uniquement.
const DG_NAV: NavItem[] = [
  { to: '/dg',          labelKey: 'dgOverview', icon: Eye,      end: true, moduleKey: 'dg_view' },
  { to: '/dg/activity', labelKey: 'dgActivity', icon: Activity, end: true, moduleKey: 'dg_view' },
]

interface SidebarProps {
  open?: boolean
  onClose?: () => void
}

const GROUP_STORAGE_KEY = 'nexusrh:sidebar-groups'

function loadGroupState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Record<string, boolean>
  } catch { /* stockage inaccessible */ }
  return {}
}

const pathMatchesItem = (pathname: string, item: NavItem): boolean =>
  item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(item.to + '/')

export function Sidebar({ open, onClose }: SidebarProps) {
  const { t } = useTranslation('nav')
  const { t: tc } = useTranslation('common')
  const { user, tenantConfig, logout } = useAuthStore()
  const location = useLocation()
  const initials = tenantConfig?.name
    ? tenantConfig.name.split(' ').slice(0, 2).map((w: string) => w[0]).join('').toUpperCase()
    : 'RH'

  const hasSubsidiaries = tenantConfig?.hasSubsidiaries === true
  const isVisible = (item: NavItem): boolean => {
    if (item.roles && !item.roles.includes(user?.role ?? '')) return false
    if (item.requiresSubsidiaries && !hasSubsidiaries) return false
    if (item.hideIfSubsidiaries && hasSubsidiaries) return false
    if (item.moduleKey && !isModuleEnabled(tenantConfig, item.moduleKey)) return false
    return true
  }

  const isDg = user?.role === 'dg'
  // DG : navigation courte et plate (pas de regroupement). HR : groupes dépliables.
  const dgItems = isDg ? DG_NAV.filter(isVisible) : []
  const groups = isDg
    ? []
    : NAV_GROUPS.map(g => ({ key: g.key, items: g.items.filter(isVisible) })).filter(g => g.items.length > 0)

  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadGroupState)
  useEffect(() => {
    try { localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(expanded)) } catch { /* non bloquant */ }
  }, [expanded])
  // Déplie automatiquement le groupe contenant la page active (sans refermer les autres).
  useEffect(() => {
    const active = groups.find(g => g.items.some(i => pathMatchesItem(location.pathname, i)))
    if (active) setExpanded(prev => (prev[active.key] ? prev : { ...prev, [active.key]: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  const toggleGroup = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  const renderLink = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      onClick={onClose}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
        isActive
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{t(item.labelKey)}</span>
      <ChevronRight className="h-3 w-3 opacity-30" />
    </NavLink>
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
            <p className="truncate text-sm font-semibold">{tenantConfig?.name ?? t('appName')}</p>
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
          {isDg ? (
            dgItems.map(renderLink)
          ) : (
            <>
              {/* Tableau de bord — épinglé en haut, hors groupe */}
              {renderLink(PINNED)}

              {groups.map(group => {
                const isOpen = expanded[group.key] ?? false
                const hasActive = group.items.some(i => pathMatchesItem(location.pathname, i))
                return (
                  <div key={group.key} className="pt-1.5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {isOpen
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      <span className="flex-1 text-left">{t(`groups.${group.key}`)}</span>
                      {/* Pastille : page active dans un groupe replié */}
                      {!isOpen && hasActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                    </button>
                    {isOpen && <div className="mt-0.5 space-y-0.5">{group.items.map(renderLink)}</div>}
                  </div>
                )
              })}
            </>
          )}
        </nav>

        {/* Langue + OpenLab signature */}
        <div className="px-3 pb-1 flex items-center justify-center">
          <LanguageSwitcher />
        </div>
        <div className="px-3 pb-2 flex items-center justify-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
          <img src={openlabLogo} alt="OpenLab Consulting" className="h-5 w-auto object-contain" />
          <span className="text-[10px] text-muted-foreground leading-tight">{t('byOpenlab')}</span>
        </div>

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
            <button onClick={logout} className="rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title={tc('actions.logout')}>
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
