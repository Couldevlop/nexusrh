/**
 * Navigation et habilitations RH.
 *
 * Ce que ce banc protège : quand l'utilisateur a une affectation, la navigation
 * ne montre QUE les rubriques que l'API lui ouvrira. Afficher « Paie » à un
 * chargé de recrutement habilité produirait un écran en 403 — et la conviction
 * que le produit est cassé. Sans affectation, rien ne change : l'accès reste
 * celui du rôle (tenants non activés).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
}))
vi.mock('@/components/shared/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }))
vi.mock('@/components/approvals/workflow', () => ({ usePendingApprovals: () => ({ data: null }) }))
vi.mock('@/assets/OPENLAB.png', () => ({ default: 'logo.png' }))

const state: { habPermissions: string[] | null; role: string } = { habPermissions: null, role: 'hr_manager' }
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel?: (s: unknown) => unknown) => {
    const store = {
      user: { sub: 'u-1', role: state.role, firstName: 'A', lastName: 'B', email: 'a@sotra.ci' },
      tenantConfig: { name: 'SOTRA', hasSubsidiaries: false, enabledModules: undefined },
      habPermissions: state.habPermissions,
      logout: vi.fn(),
    }
    return sel ? sel(store) : store
  },
}))

import { Sidebar } from './Sidebar'

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Sidebar /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.habPermissions = null
  state.role = 'hr_manager'
  getMock.mockReset().mockResolvedValue({ data: { data: [] } })
  // Les groupes de la navigation sont repliés par défaut : on les déplie tous
  // (l'état est mémorisé dans localStorage) pour voir les entrées.
  localStorage.setItem('nexusrh:sidebar-groups', JSON.stringify({
    collaborators: true, payroll: true, timeExpenses: true, talent: true, analytics: true, adminSecurity: true,
  }))
})
afterEach(() => cleanup())

describe('Sidebar — filtrage par la grille d\'habilitations', () => {
  it('sans affectation, la navigation du rôle est inchangée (Paie visible)', () => {
    renderSidebar()
    expect(screen.getByText('payroll')).toBeTruthy()
    expect(screen.getByText('employees')).toBeTruthy()
  })

  it('un habilité sans aucune case payroll:* ne voit plus Paie', () => {
    state.habPermissions = ['recruitment:view', 'employees:view']
    renderSidebar()
    expect(screen.queryByText('payroll')).toBeNull()
    expect(screen.getByText('recruitment')).toBeTruthy()
    expect(screen.getByText('employees')).toBeTruthy()
  })

  it('une case payroll:view suffit à garder Paie', () => {
    state.habPermissions = ['payroll:view']
    renderSidebar()
    expect(screen.getByText('payroll')).toBeTruthy()
    expect(screen.queryByText('recruitment')).toBeNull()
  })

  it('l\'entrée Habilitations est réservée à l\'admin, au porteur de la case, ou à un validateur', () => {
    state.habPermissions = ['employees:view']
    renderSidebar()
    expect(screen.queryByText('habilitations')).toBeNull()
    cleanup()

    state.habPermissions = ['employees:view', 'manage_habilitations']
    renderSidebar()
    expect(screen.getByText('habilitations')).toBeTruthy()
    cleanup()

    state.habPermissions = null
    state.role = 'admin'
    renderSidebar()
    expect(screen.getByText('habilitations')).toBeTruthy()
  })
})
