/**
 * Onglet « Formats bancaires » — paramétrage tenant, réservé à l'admin.
 *
 * La matrice RBAC réserve le paramétrage tenant au rôle `admin` : un hr_manager
 * peut générer et envoyer les virements, mais pas redéfinir le format du
 * fichier envoyé à la banque. L'API le refuse (403) ; l'onglet ne doit pas non
 * plus lui être proposé, ni atteignable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, authStoreMock } = vi.hoisted(() => ({ getMock: vi.fn(), authStoreMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: '' } },
  formatFCFA: (n: number) => `${n} FCFA`,
  formatMonth: (m: string) => m,
}))
vi.mock('@/stores/authStore', () => ({ useAuthStore: authStoreMock }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: unknown) => (typeof d === 'string' ? d : _k) }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import MobileMoneyPage from './MobileMoneyPage'

function renderFor(role: string) {
  authStoreMock.mockImplementation((sel: (s: unknown) => unknown) => sel({ user: { role } }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MobileMoneyPage /></QueryClientProvider>)
}

beforeEach(() => {
  getMock.mockReset()
  getMock.mockResolvedValue({ data: { data: [], directory: [], referential: { sources: [], transforms: [], dateFormats: [], outputs: [], encodings: [], delimiters: [], presets: [], maxColumns: 200, maxSampleBytes: 1048576 } } })
})
afterEach(() => cleanup())

describe('onglet Formats bancaires', () => {
  it('est proposé à l\'admin', () => {
    renderFor('admin')
    expect(screen.getByText('Formats bancaires')).toBeTruthy()
  })

  it('n\'est pas proposé à un hr_manager', () => {
    renderFor('hr_manager')
    expect(screen.queryByText('Formats bancaires')).toBeNull()
  })

  it('affiche le paramétrage une fois l\'onglet ouvert par un admin', () => {
    renderFor('admin')
    fireEvent.click(screen.getByText('Formats bancaires'))
    expect(screen.getByText('Formats de fichier bancaire')).toBeTruthy()
    expect(screen.getByText('Nouveau format')).toBeTruthy()
  })
})
