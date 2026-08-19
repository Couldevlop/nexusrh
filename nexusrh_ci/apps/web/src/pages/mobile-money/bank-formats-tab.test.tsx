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

/**
 * Correction du nom de la banque — c'est lui, et lui seul, qui décide à quels
 * salariés le format s'applique. Gardé hors de l'état « modifié », il rendait la
 * correction inenregistrable, et laissait l'activation ouverte : on activait
 * alors l'ANCIENNE banque en croyant avoir corrigé.
 */
describe("correction de la banque d'un brouillon", () => {
  const SPEC = {
    output: 'xlsx', encoding: 'utf8', delimiter: ';', lineEnding: 'crlf', filename: 'VIR.xlsx',
    header: { mode: 'labels', lines: [] },
    columns: [{ label: 'MONTANT', source: 'payslip.net_payable' }],
    footer: { enabled: false, lines: [] },
  }

  beforeEach(() => {
    getMock.mockImplementation((url: string) => {
      if (url === '/bank-transfer/templates') {
        return Promise.resolve({ data: {
          data: [{ id: 't1', bank: 'DISQUETTE EXEMPLE', version: 1, status: 'draft', label: 'x', outputKind: 'xlsx', sampleFilename: null }],
          directory: [], employeeBanks: ['SGCI'],
          referential: {
            sources: [{ value: 'payslip.net_payable', group: 'payslip', label: 'Net à payer' }],
            transforms: [], dateFormats: [], outputs: ['xlsx'], encodings: ['utf8'], delimiters: [';'],
            presets: [], maxColumns: 200, maxSampleBytes: 1048576,
          },
        } })
      }
      return Promise.resolve({ data: { data: { id: 't1', bank: 'DISQUETTE EXEMPLE', version: 1, status: 'draft', label: 'x', spec: SPEC, issues: [] } } })
    })
  })

  async function ouvrirEditeur() {
    renderFor('admin')
    fireEvent.click(screen.getByText('Formats bancaires'))
    fireEvent.click(await screen.findByText('Ouvrir'))
    return await screen.findByDisplayValue('DISQUETTE EXEMPLE')
  }

  it("rend la correction enregistrable et bloque l'activation tant qu'elle ne l'est pas", async () => {
    const champ = await ouvrirEditeur()
    // Avant toute modification : rien à enregistrer, activation possible.
    expect((screen.getByText('Enregistrer le brouillon') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('Activer ce format') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(champ, { target: { value: 'BNI' } })

    expect((screen.getByText('Enregistrer le brouillon') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByText('Activer ce format') as HTMLButtonElement).disabled).toBe(true)
  })

  it("refuse d'enregistrer un nom de banque vide", async () => {
    const champ = await ouvrirEditeur()
    fireEvent.change(champ, { target: { value: '   ' } })
    expect((screen.getByText('Enregistrer le brouillon') as HTMLButtonElement).disabled).toBe(true)
  })

  it("avertit quand aucun salarié n'a cette banque", async () => {
    await ouvrirEditeur()
    expect(screen.getByText(/ne s’appliquera à personne/)).toBeTruthy()
  })
})
