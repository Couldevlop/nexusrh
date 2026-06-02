import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import AiChat from '@/components/ai/AiChat'
import { AlertTriangle, Menu } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { ActingAsBanner } from '@/components/agency/ActingAsBanner'

const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Tableau de bord',
  '/employees': 'Employés',
  '/contracts': 'Contrats OHADA',
  '/payroll': 'Paie',
  '/absences': 'Absences',
  '/expenses-rh': 'Notes de frais',
  '/recruitment': 'Recrutement',
  '/training': 'Formations FDFP',
  '/careers': 'Carrières',
  '/cnps': 'CNPS & DISA',
  '/mobile-money': 'Mobile Money',
  '/reporting': 'Reporting',
  '/settings': 'Paramètres',
}

export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { tenantConfig } = useAuthStore()
  const location = useLocation()
  const pageTitle = ROUTE_LABELS[location.pathname] ?? 'NexusRH CI'

  return (
    <div className="flex h-screen overflow-hidden flex-col">
      {/* Bannière « cabinet agit pour le tenant X » (session scopée) */}
      <ActingAsBanner />
      {/* Maintenance banner */}
      <MaintenanceBanner />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar (desktop: toujours visible via lg:translate-x-0, mobile: drawer) */}
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Mobile header */}
          <header className="flex lg:hidden items-center gap-3 border-b border-border bg-card px-4 py-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-sm font-semibold truncate">{pageTitle}</span>
            </div>
            <span className="text-xs text-muted-foreground truncate max-w-[120px]">{tenantConfig?.name}</span>
          </header>

          <main className="flex-1 overflow-auto bg-background">
            <Outlet />
          </main>
        </div>

        <AiChat />
      </div>
    </div>
  )
}

function MaintenanceBanner() {
  const [visible, setVisible] = useState(false)

  if (!visible) return null

  return (
    <div className="flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>Service en maintenance — Certaines fonctionnalités sont temporairement indisponibles.</span>
      <button onClick={() => setVisible(false)} className="ml-auto text-white/80 hover:text-white">✕</button>
    </div>
  )
}
