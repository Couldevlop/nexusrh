/**
 * Onglets de Paramètres gouvernés par les modules activés du tenant.
 *
 * Bug terrain : l'onglet « Simulation d'entretien » s'affichait pour TOUS les
 * tenants alors que le module `interview_sim` est opt-in (défaut `false`). Un
 * admin qui cliquait dessus déclenchait GET /interview-sim/config → 403
 * { moduleDisabled: true } (hook global app.ts) et restait bloqué sur un
 * « Chargement… » perpétuel, sans aucun message.
 *
 * Invariant : un onglet adossé à un module désactivé n'est ni affiché, ni
 * atteignable par ?tab=… (l'API reste la source de vérité — OWASP A01).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, authStoreMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  authStoreMock: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}))
vi.mock('@/stores/authStore', () => ({ useAuthStore: authStoreMock }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import SettingsPage from './SettingsPage'

function renderPage(enabledModules: Record<string, boolean>, search = '') {
  window.history.replaceState({}, '', `/settings${search}`)
  authStoreMock.mockReturnValue({ tenantConfig: { name: 'SOTRA', enabledModules } })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset().mockImplementation(() => Promise.resolve({ data: { data: [] } }))
})
afterEach(() => cleanup())

describe('SettingsPage — onglets et modules du tenant', () => {
  it('masque l’onglet Simulation d’entretien quand le module est désactivé', () => {
    renderPage({ interview_sim: false })
    expect(screen.queryByText('tabs.interviewSim')).toBeNull()
  })

  it('masque l’onglet quand le module est absent des surcharges (défaut opt-in = false)', () => {
    renderPage({})
    expect(screen.queryByText('tabs.interviewSim')).toBeNull()
  })

  it('affiche l’onglet quand le module est activé pour le tenant', () => {
    renderPage({ interview_sim: true })
    expect(screen.getByText('tabs.interviewSim')).toBeTruthy()
  })

  it('n’appelle pas /interview-sim/config via ?tab=interview-sim si le module est désactivé', () => {
    renderPage({ interview_sim: false }, '?tab=interview-sim')
    expect(getMock.mock.calls.some((c) => String(c[0]).startsWith('/interview-sim'))).toBe(false)
  })

  it('masque aussi l’onglet Mobile Money quand ce module est désactivé', () => {
    renderPage({ mobile_money: false })
    expect(screen.queryByText('tabs.mobileMoney')).toBeNull()
  })

  it('garde les onglets non adossés à un module (Général) en toutes circonstances', () => {
    renderPage({ interview_sim: false, mobile_money: false })
    expect(screen.getByText('tabs.general')).toBeTruthy()
  })
})
