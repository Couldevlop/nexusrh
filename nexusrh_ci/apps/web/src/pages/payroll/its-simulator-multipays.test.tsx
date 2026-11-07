/**
 * Simulateur de salaire — l'écran n'est plus ivoirien en dur.
 *
 * Avant le 07/11/2026 la page affichait « Simulateur ITS — Côte d'Ivoire »,
 * un barème `BAREME_ITS_2024` recopié dans le composant, un SMIG de 75 000 et
 * un détail CNPS qui RECALCULAIT côté navigateur les plafonds (3 375 000 /
 * 75 000) et les taux (6,3 / 7,7 / 5,75 %). Un tenant d'un autre pays — quinze
 * packs existent — lisait donc des chiffres ivoiriens sur son propre salaire.
 *
 * Ce banc vérifie les deux moitiés de la correction :
 *   - le formulaire ENVOIE le pays et les champs qui changent le net (prime de
 *     transport et ville, conjoint sans emploi, enfants couverts, ancienneté,
 *     jours travaillés) ;
 *   - l'écran AFFICHE ce que le serveur renvoie (barème, salaire minimum,
 *     cotisations ligne par ligne), et rien qui soit écrit dans le composant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  formatFCFA: (n: number) => `${n}`,
  formatDate: (d: string) => d,
}))
// `t` rend la clé SUIVIE des valeurs interpolées : un montant affiché via
// {{amount}} reste donc vérifiable, et une clé manquante se voit.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o ? `${k} ${Object.values(o).join(' ')}` : k,
    i18n: { language: 'fr' },
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))

import ItsSimulatorPage from './ItsSimulatorPage'

const AVAILABLE = [
  { countryCode: 'CIV', packCode: 'CIV-2024', name: "Côte d'Ivoire", status: 'active', currency: 'XOF', smigMensuel: 75_000 },
  { countryCode: 'SEN', packCode: 'SEN-2024', name: 'Sénégal',       status: 'active', currency: 'XOF', smigMensuel: 64_923 },
  { countryCode: 'GHA', packCode: 'GHA-2024', name: 'Ghana',         status: 'stub',   currency: 'GHS', smigMensuel: 547 },
]

/** Réponse serveur minimale, paramétrable par pays. */
function simResponse(over: Record<string, unknown> = {}) {
  return {
    data: {
      input: {
        baseSalary: 300_000, primes: 0, brut: 300_000, atRate: 0.02,
        seniorityAmount: 0, transportAllowance: 0, countryCode: 'CIV', packCode: 'CIV-2024',
      },
      cnps: { salarial: 18_900, patronal: 15_075 },
      cmu: { salarial: 500, patronal: 500 },
      its: { base: 300_000, brut: 39_000, credit: 11_000, parts: 2, net: 28_000 },
      net: { payable: 252_600, smigCompliant: true },
      employerCost: 315_575,
      lines: [
        { code: '2100', label: 'Retenue vieillesse salarié', type: 'employee_contribution', base: 300_000, amount: 18_900 },
        { code: '3100', label: 'Vieillesse employeur',        type: 'employer_contribution', base: 300_000, amount: 23_100 },
        { code: '3200', label: 'Prestations familiales',      type: 'employer_contribution', base: 75_000,  amount: 4_312 },
      ],
      pack: {
        code: 'CIV-2024', countryCode: 'CIV', name: "Côte d'Ivoire", currency: 'XOF', currencyLabel: 'FCFA',
        smigMensuel: 75_000, usable: true, hasCmu: true, hasSeniorityBonus: true,
        transportExoneration: { defaut: 20_000, parZone: { abidjan: 30_000 } },
        brackets: [
          { min: 0, max: 75_000, taux: 0 },
          { min: 75_001, max: 240_000, taux: 0.16 },
        ],
      },
      simulation: { avecUnEnfantSupp: { its: 25_250, net: 255_350, gain: 2_750, message: 'un enfant de plus' } },
      currency: 'XOF',
      ...over,
    },
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ItsSimulatorPage /></QueryClientProvider>)
}

/** Le <select> du pays : premier select de la page. */
const countrySelect = () => document.querySelectorAll('select')[0] as HTMLSelectElement
const payload = () => postMock.mock.calls.at(-1)![1] as Record<string, unknown>
const clickCalculate = () => fireEvent.click(screen.getByText('simulator.calculate'))

beforeEach(() => {
  getMock.mockReset().mockImplementation((url: string) => {
    if (url === '/settings/legislation') {
      return Promise.resolve({ data: { data: { countryCode: 'SEN', countryLabel: 'Sénégal', available: AVAILABLE } } })
    }
    return Promise.resolve({ data: { data: [] } })
  })
  postMock.mockReset().mockResolvedValue(simResponse())
})
afterEach(() => cleanup())

describe('Choix du pays', () => {
  it('propose les pays déclarés par le serveur, pas une liste écrite dans la page', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    expect([...countrySelect().options].map(o => o.value)).toEqual(['CIV', 'SEN', 'GHA'])
    // Un pack préliminaire est signalé comme tel dans la liste.
    expect(countrySelect().options[2]!.text).toContain('simulator.countryStub')
  })

  it('présélectionne le pays du tenant, pas la Côte d’Ivoire par défaut', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().value).toBe('SEN'))
  })

  it('envoie le pays choisi au serveur', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    fireEvent.change(countrySelect(), { target: { value: 'GHA' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['countryCode']).toBe('GHA')
  })
})

describe('Champs qui changent le net', () => {
  it('transmet la prime de transport et la ville de travail', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    // Deux champs à pas de 5 000 : primes imposables puis prime de transport.
    const steps5000 = document.querySelectorAll('input[type="number"][step="5000"]')
    expect(steps5000.length).toBe(2)
    fireEvent.change(steps5000[1]!, { target: { value: '25000' } })
    fireEvent.change(screen.getByPlaceholderText('simulator.cityPlaceholder'), { target: { value: 'Bouaké' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['city']).toBe('Bouaké')
    expect(payload()['transportAllowance']).toBe(25_000)
    // …et elle n'est PAS fondue dans les primes imposables.
    expect(payload()['primes']).toBe(0)
  })

  it('n’envoie pas les champs laissés vides', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    const p = payload()
    expect(p).not.toHaveProperty('city')
    expect(p).not.toHaveProperty('transportAllowance')
    expect(p).not.toHaveProperty('hireDate')
    expect(p).not.toHaveProperty('workedDays')
    expect(p).not.toHaveProperty('cmuChildrenCovered')
    // Conjoint non renseigné : le serveur ne doit pas le compter.
    expect(p).not.toHaveProperty('cmuSpouseCovered')
  })

  it('transmet le conjoint sans emploi quand il est renseigné', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    const spouse = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'covered'))!
    fireEvent.change(spouse, { target: { value: 'covered' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['cmuSpouseCovered']).toBe(true)
  })

  it('transmet la date d’embauche et les jours travaillés', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: '2010-03-01' } })
    fireEvent.change(screen.getByPlaceholderText('simulator.workedDaysPlaceholder'), { target: { value: '13' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['hireDate']).toBe('2010-03-01')
    expect(payload()['workedDays']).toBe(13)
  })
})

describe('Ce qui est affiché vient du serveur', () => {
  it('le barème affiché est celui renvoyé, pas BAREME_ITS_2024', async () => {
    postMock.mockResolvedValue(simResponse({
      pack: {
        ...simResponse().data.pack, code: 'SEN-2024', countryCode: 'SEN', name: 'Sénégal',
        smigMensuel: 64_923, hasCmu: false, currencyLabel: 'FCFA',
        brackets: [{ min: 0, max: 630_000, taux: 0 }, { min: 630_001, max: null, taux: 0.2 }],
      },
    }))
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/simulator.scaleTitle Sénégal/)).toBeTruthy())
    // Tranche ouverte du Sénégal, inexistante dans le barème ivoirien.
    expect(screen.getByText('20 %')).toBeTruthy()
    expect(screen.queryByText('16 %')).toBeNull()
    // Salaire minimum du pays, pas 75 000.
    expect(screen.getByText(/simulator.smigCompliant 64 923 FCFA/)).toBeTruthy()
  })

  it('les cotisations sont listées ligne par ligne depuis le moteur, bases incluses', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    clickCalculate()
    // Libellés venus du moteur : ils n'existent nulle part dans le composant.
    await waitFor(() => expect(screen.getByText(/Retenue vieillesse salarié/)).toBeTruthy())
    expect(screen.getByText(/Vieillesse employeur/)).toBeTruthy()
    // Base plafonnée par le moteur, affichée telle quelle (plus de Math.min local).
    expect(screen.getByText(/Prestations familiales/).textContent).toContain('simulator.onBase 75 000 FCFA')
  })

  it('masque le bloc santé quand le pack du pays n’en déclare pas', async () => {
    postMock.mockResolvedValue(simResponse({
      pack: { ...simResponse().data.pack, hasCmu: false, name: 'Sénégal' },
      cmu: undefined,
    }))
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('simulator.spouseLabel')).toBeNull())
    expect(screen.queryByText('simulator.cmuChildrenLabel')).toBeNull()
  })

  it('avertit quand le pack du pays est préliminaire', async () => {
    postMock.mockResolvedValue(simResponse({
      pack: { ...simResponse().data.pack, usable: false, name: 'Ghana' },
    }))
    renderPage()
    await waitFor(() => expect(countrySelect().options.length).toBe(3))
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/simulator.packStubWarning Ghana/)).toBeTruthy())
  })

  it('le titre nomme le pays simulé', async () => {
    renderPage()
    // Avant tout calcul : le pays du tenant.
    await waitFor(() => expect(screen.getByText(/simulator.title Sénégal/)).toBeTruthy())
    clickCalculate()
    // Après calcul : le pays effectivement appliqué par le serveur.
    await waitFor(() => expect(screen.getByText(/simulator.title Côte d'Ivoire/)).toBeTruthy())
  })
})
