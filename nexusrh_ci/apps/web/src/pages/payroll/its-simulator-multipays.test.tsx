/**
 * Simulateur de salaire — l'écran n'est plus ivoirien en dur, et le formulaire
 * porte enfin tout ce qui change le résultat.
 *
 * Avant le 07/11/2026 la page affichait « Simulateur ITS — Côte d'Ivoire », un
 * barème `BAREME_ITS_2024` recopié dans le composant, un SMIG de 75 000 et un
 * détail CNPS qui RECALCULAIT côté navigateur les plafonds (3 375 000 / 75 000)
 * et les taux (6,3 / 7,7 / 5,75 %). Cinq champs en tout : un tenant d'un autre
 * pays lisait des chiffres ivoiriens sur son propre salaire, et personne ne
 * pouvait saisir une catégorie, une ancienneté, des heures supplémentaires ni
 * un avantage en nature.
 *
 * Ce banc vérifie les trois moitiés de la correction :
 *   - le PACK du pays pilote les champs affichés (santé, ancienneté, natures
 *     d'heures supplémentaires) ;
 *   - le formulaire ENVOIE ce qu'on y saisit ;
 *   - l'écran AFFICHE ce que le serveur renvoie, et rien qui soit écrit dans
 *     le composant.
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

const QUALIFICATIONS = [
  { key: 'bac', label: 'BAC (général ou technique)', yearsAfterBac: 0, usualJobLevel: 'employe' },
  { key: 'bac5', label: 'BAC+5 (Master 2, diplôme d’ingénieur)', yearsAfterBac: 5, usualJobLevel: 'cadre' },
]

/** Pack du pays, tel que `GET /settings/legislation` le sert. */
function pack(over: Record<string, unknown> = {}) {
  return {
    code: 'CIV-2024', countryCode: 'CIV', name: "Côte d'Ivoire", currency: 'XOF', status: 'active',
    smigMensuel: 75_000,
    tranchesImpotSalaire: [{ min: 0, max: 75_000, taux: 0 }, { min: 75_001, max: 240_000, taux: 0.16 }],
    primeTransportExoneree: { defaut: 20_000, parZone: { abidjan: 30_000 } },
    cmu: { perBeneficiary: 1_000, employerShare: 0.5, maxSharedChildren: 6 },
    seniorityBonus: { base: 'category_minimum', source: 'CCI art. 55' },
    leaveRules: { overtimeRates: { weekly: 0.15, weeklyBeyond: 0.5, night: 0.75 } },
    ...over,
  }
}

function legislation(over: Record<string, unknown> = {}) {
  return {
    countryCode: 'SEN', countryLabel: 'Sénégal', usable: true,
    pack: pack(), available: AVAILABLE, qualificationLevels: QUALIFICATIONS,
    ...over,
  }
}

/** Réponse du moteur, paramétrable. */
function simResponse(over: Record<string, unknown> = {}) {
  return {
    data: {
      input: {
        baseSalary: 300_000, primes: 0, brut: 300_000, atRate: 0.02,
        seniorityAmount: 0, transportAllowance: 0, countryCode: 'CIV', packCode: 'CIV-2024',
        categoryMinimum: 75_000, categoryMinimumProvided: false,
        professionalCategory: null, categoryLevel: null, qualificationLevel: null,
        weeklyHours: 40, benefitsInKind: 0,
      },
      seniority: { years: 0, rate: null, base: 75_000, amount: 0, source: null },
      overtime: { lines: [], total: 0, hourlyRate: 1731 },
      compliance: { smig: true, smigMinimum: 75_000, categoryMinimum: null },
      positioning: { usualJobLevel: null, salaryJobLevel: 'cadre', aligned: true, note: 'Repère : poste de niveau cadre.' },
      comparison: null,
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
        overtimeRates: { weekly: 0.15, weeklyBeyond: 0.5, night: 0.75 },
        brackets: [{ min: 0, max: 75_000, taux: 0 }, { min: 75_001, max: 240_000, taux: 0.16 }],
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

const countrySelect = () => document.querySelectorAll('select')[0] as HTMLSelectElement
const payload = () => postMock.mock.calls.at(-1)![1] as Record<string, unknown>
const clickCalculate = () => fireEvent.click(screen.getByText('simulator.calculate'))
/** Attend que le pays du tenant et son pack soient chargés. */
const ready = async () => {
  await waitFor(() => expect(countrySelect().options.length).toBe(3))
  await waitFor(() => expect(screen.queryByText('simulator.overtimeLabel')).not.toBeNull())
}

/** Pack renvoyé pour `?country=` ; par défaut le même que celui du tenant. */
let countryPack: Record<string, unknown> | null = null

beforeEach(() => {
  countryPack = null
  getMock.mockReset().mockImplementation((url: string) => {
    if (url.startsWith('/settings/legislation')) {
      const m = /country=([A-Za-z]{3})/.exec(url)
      if (m) {
        return Promise.resolve({
          data: { data: legislation({ countryCode: m[1]!.toUpperCase(), ...(countryPack ? { pack: countryPack } : {}) }) },
        })
      }
      return Promise.resolve({ data: { data: legislation() } })
    }
    return Promise.resolve({ data: { data: [] } })
  })
  postMock.mockReset().mockResolvedValue(simResponse())
})
afterEach(() => cleanup())

describe('Choix du pays', () => {
  it('propose les pays déclarés par le serveur, pas une liste écrite dans la page', async () => {
    renderPage()
    await ready()
    expect([...countrySelect().options].map(o => o.value)).toEqual(['CIV', 'SEN', 'GHA'])
    expect(countrySelect().options[2]!.text).toContain('simulator.countryStub')
  })

  it('présélectionne le pays du tenant, pas la Côte d’Ivoire par défaut', async () => {
    renderPage()
    await waitFor(() => expect(countrySelect().value).toBe('SEN'))
  })

  it('envoie le pays choisi au serveur', async () => {
    renderPage()
    await ready()
    fireEvent.change(countrySelect(), { target: { value: 'GHA' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['countryCode']).toBe('GHA')
  })

  it('recharge le pack du pays choisi : le formulaire se reconfigure avant tout calcul', async () => {
    renderPage()
    await ready()
    countryPack = pack({
      cmu: null, seniorityBonus: null,
      leaveRules: { overtimeRates: { weekly: 0.1 } },
      smigMensuel: 64_923,
    })
    fireEvent.change(countrySelect(), { target: { value: 'GHA' } })
    // Pays sans couverture santé ni prime d'ancienneté : les champs disparaissent.
    await waitFor(() => expect(screen.queryByText('simulator.spouseLabel')).toBeNull())
    expect(screen.queryByText('simulator.hireDateLabel')).toBeNull()
    // …et une seule nature d'heures supplémentaires reste proposée.
    expect(screen.getAllByText(/simulator\.overtime\./)).toHaveLength(1)
    expect(postMock).not.toHaveBeenCalled()
  })
})

describe('Les natures d’heures supplémentaires viennent du pack', () => {
  it('n’affiche que celles que le pays majore, avec leur taux', async () => {
    renderPage()
    await ready()
    expect(screen.getByText('simulator.overtime.weekly 15 %')).toBeTruthy()
    expect(screen.getByText('simulator.overtime.weeklyBeyond 50 %')).toBeTruthy()
    expect(screen.getByText('simulator.overtime.night 75 %')).toBeTruthy()
    // Nature absente du pack : aucun champ, donc aucune saisie à refuser.
    expect(screen.queryByText(/simulator.overtime.sundayHolidayNight/)).toBeNull()
  })

  it('transmet les heures saisies, et seulement celles-là', async () => {
    renderPage()
    await ready()
    const night = screen.getByText('simulator.overtime.night 75 %')
      .parentElement!.querySelector('input')!
    fireEvent.change(night, { target: { value: '6' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['overtimeHours']).toEqual({ night: 6 })
  })
})

describe('Champs qui changent le net', () => {
  it('transmet la prime de transport, la ville, les avantages en nature', async () => {
    renderPage()
    await ready()
    fireEvent.change(screen.getByText('simulator.transportLabel FCFA').parentElement!.querySelector('input')!,
      { target: { value: '25000' } })
    fireEvent.change(screen.getByPlaceholderText('simulator.cityPlaceholder'), { target: { value: 'Bouaké' } })
    fireEvent.change(screen.getByText('simulator.benefitsLabel FCFA').parentElement!.querySelector('input')!,
      { target: { value: '40000' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()).toMatchObject({ transportAllowance: 25_000, city: 'Bouaké', benefitsInKind: 40_000 })
    // La prime de transport n'est PAS fondue dans les primes imposables.
    expect(payload()['primes']).toBe(0)
  })

  it('transmet la catégorie et son minimum conventionnel', async () => {
    renderPage()
    await ready()
    fireEvent.change(screen.getByPlaceholderText('simulator.categoryPlaceholder'), { target: { value: '6e catégorie' } })
    fireEvent.change(screen.getByPlaceholderText('simulator.categoryMinimumPlaceholder'), { target: { value: '200000' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()).toMatchObject({ professionalCategory: '6e catégorie', categoryMinimum: 200_000 })
  })

  it('transmet le niveau de qualification proposé par le serveur', async () => {
    renderPage()
    await ready()
    const select = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'bac5'))!
    fireEvent.change(select, { target: { value: 'bac5' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['qualificationLevel']).toBe('bac5')
  })

  it('transmet l’ancienneté en années quand aucune date n’est saisie', async () => {
    renderPage()
    await ready()
    fireEvent.change(screen.getByPlaceholderText('simulator.seniorityYearsPlaceholder'), { target: { value: '12' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['seniorityYears']).toBe(12)
    expect(payload()).not.toHaveProperty('hireDate')
  })

  it('la date d’embauche prime et neutralise la saisie en années', async () => {
    renderPage()
    await ready()
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: '2010-03-01' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['hireDate']).toBe('2010-03-01')
    expect(payload()).not.toHaveProperty('seniorityYears')
  })

  it('n’envoie pas les champs laissés vides', async () => {
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    const p = payload()
    for (const k of ['city', 'transportAllowance', 'benefitsInKind', 'hireDate', 'seniorityYears',
      'workedDays', 'cmuChildrenCovered', 'cmuSpouseCovered', 'professionalCategory',
      'categoryMinimum', 'qualificationLevel', 'overtimeHours', 'comparison']) {
      expect(p, k).not.toHaveProperty(k)
    }
  })

  it('transmet le conjoint sans emploi quand il est renseigné', async () => {
    renderPage()
    await ready()
    const spouse = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'covered'))!
    fireEvent.change(spouse, { target: { value: 'covered' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['cmuSpouseCovered']).toBe(true)
  })
})

describe('Embauche, situation en cours, revalorisation', () => {
  it('ne demande un second salaire que pour une revalorisation', async () => {
    renderPage()
    await ready()
    expect(screen.queryByText(/simulator.newSalaryLabel/)).toBeNull()
    fireEvent.click(screen.getByText('simulator.purpose.raise'))
    expect(screen.getByText('simulator.newSalaryLabel FCFA')).toBeTruthy()
  })

  it('envoie le second scénario et affiche les écarts renvoyés', async () => {
    postMock.mockResolvedValue(simResponse({
      comparison: {
        input: { baseSalary: 360_000, primes: 0, brut: 360_000, seniorityAmount: 0 },
        cnps: { salarial: 22_680, patronal: 15_075 },
        its: { base: 360_000, brut: 51_600, credit: 11_000, parts: 2, net: 40_600 },
        net: { payable: 296_220, smigCompliant: true },
        employerCost: 378_075, lines: [],
        delta: {
          baseSalary: 60_000, brut: 60_000, netPayable: 43_620, its: 12_600,
          cnpsSal: 3_780, employerCost: 62_500, brutPct: 20, netSharePct: 72.7,
        },
      },
    }))
    renderPage()
    await ready()
    fireEvent.click(screen.getByText('simulator.purpose.raise'))
    fireEvent.change(screen.getByText('simulator.newSalaryLabel FCFA').parentElement!.querySelector('input')!,
      { target: { value: '360000' } })
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())
    expect(payload()['comparison']).toEqual({ baseSalary: 360_000 })
    // Le tableau avant / après affiche les écarts, signés, tels que calculés.
    await waitFor(() => expect(screen.getByText(/simulator.comparisonTitle 20/)).toBeTruthy())
    expect(screen.getByText('+43 620 FCFA')).toBeTruthy()
    expect(screen.getByText(/simulator.comparison.netShare 72.7/)).toBeTruthy()
  })

  it('un projet d’embauche met en avant le coût total employeur', async () => {
    renderPage()
    await ready()
    clickCalculate()
    // 315 575 × 12 : le coût annuel est dérivé du coût mensuel du moteur.
    await waitFor(() => expect(screen.getByText(/simulator.hireTotal 315 575 FCFA 3 786 900 FCFA/)).toBeTruthy())
  })

  it('le libellé du salaire s’adapte à l’usage', async () => {
    renderPage()
    await ready()
    expect(screen.getByText('simulator.offeredSalaryLabel FCFA')).toBeTruthy()
    fireEvent.click(screen.getByText('simulator.purpose.current'))
    expect(screen.getByText('simulator.baseSalaryLabel FCFA')).toBeTruthy()
  })
})

describe('Ce qui est affiché vient du serveur', () => {
  it('le barème affiché est celui du pays, pas BAREME_ITS_2024', async () => {
    countryPack = pack({
      countryCode: 'SEN', name: 'Sénégal', smigMensuel: 64_923,
      tranchesImpotSalaire: [{ min: 0, max: 630_000, taux: 0 }, { min: 630_001, max: null, taux: 0.2 }],
    })
    renderPage()
    await ready()
    // Affiché AVANT tout calcul : le pack du pays suffit.
    await waitFor(() => expect(screen.getByText('20 %')).toBeTruthy())
    expect(screen.queryByText('16 %')).toBeNull()
    expect(screen.getByText(/simulator.smigHint 64 923 FCFA/)).toBeTruthy()
  })

  it('les cotisations sont listées ligne par ligne depuis le moteur, bases incluses', async () => {
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/Retenue vieillesse salarié/)).toBeTruthy())
    expect(screen.getByText(/Vieillesse employeur/)).toBeTruthy()
    expect(screen.getByText(/Prestations familiales/).textContent).toContain('simulator.onBase 75 000 FCFA')
  })

  it('affiche la prime d’ancienneté avec son taux, son assiette et sa source', async () => {
    postMock.mockResolvedValue(simResponse({
      seniority: { years: 12, rate: 0.12, base: 200_000, amount: 24_000, source: 'CCI du 19/07/1977, art. 55' },
    }))
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(screen.getByText('simulator.seniorityTitle')).toBeTruthy())
    expect(screen.getByText('12 %')).toBeTruthy()
    expect(screen.getByText('200 000 FCFA')).toBeTruthy()
    expect(screen.getByText(/CCI du 19\/07\/1977/)).toBeTruthy()
  })

  it('affiche les heures supplémentaires calculées, avec le taux horaire', async () => {
    postMock.mockResolvedValue(simResponse({
      overtime: {
        total: 6_924, hourlyRate: 1_731,
        lines: [{ category: 'night', label: 'Heures supp. +75% (nuit)', hours: 4, majoration: 0.75, amount: 6_924 }],
      },
    }))
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/simulator.overtimeTitle 1 731 FCFA/)).toBeTruthy())
    expect(screen.getByText(/Heures supp. \+75% \(nuit\)/)).toBeTruthy()
  })

  it('affiche le verdict du minimum conventionnel seulement s’il a été saisi', async () => {
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/simulator.smigCompliant/)).toBeTruthy())
    expect(screen.queryByText(/simulator.categoryMinimum(Not)?Compliant/)).toBeNull()

    postMock.mockResolvedValue(simResponse({
      compliance: { smig: true, smigMinimum: 75_000, categoryMinimum: false },
      input: { ...simResponse().data.input, categoryMinimum: 200_000, categoryMinimumProvided: true },
    }))
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/simulator.categoryMinimumNotCompliant 200 000 FCFA/)).toBeTruthy())
  })

  it('affiche le repère de classification tel qu’il est rédigé par le serveur', async () => {
    postMock.mockResolvedValue(simResponse({
      positioning: {
        usualJobLevel: 'cadre', salaryJobLevel: 'employe', aligned: false,
        note: 'BAC+5 : niveau usuel « cadre »… Repère de classification : aucun montant n\'en dépend.',
      },
    }))
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/aucun montant n'en dépend/)).toBeTruthy())
  })

  it('avertit quand le pack du pays est préliminaire', async () => {
    countryPack = pack({ status: 'stub', name: 'Ghana' })
    renderPage()
    await ready()
    await waitFor(() => expect(screen.getByText(/simulator.packStubWarning/)).toBeTruthy())
  })

  it('le titre nomme le pays simulé', async () => {
    renderPage()
    await ready()
    expect(screen.getByText(/simulator.title Sénégal/)).toBeTruthy()
    clickCalculate()
    await waitFor(() => expect(screen.getByText(/simulator.title Côte d'Ivoire/)).toBeTruthy())
  })
})

describe('Changer de pays APRÈS un calcul', () => {
  it('les repères légaux suivent le nouveau pays, sans attendre un recalcul', async () => {
    // Constaté en production : après un calcul, l'écran gardait le SMIG et le
    // barème du pays CALCULÉ. En passant du Sénégal au Bénin, la RH
    // lisait encore « salaire minimum légal : 64 710 FCFA » — le minimum d'un
    // AUTRE pays — tant qu'elle n'avait pas recliqué sur Calculer. Un repère
    // légal faux est pire que pas de repère.
    renderPage()
    await ready()
    clickCalculate()
    await waitFor(() => expect(postMock).toHaveBeenCalled())

    countryPack = pack({ smigMensuel: 52_000 })
    fireEvent.change(countrySelect(), { target: { value: 'GHA' } })

    await waitFor(() => expect(screen.getByText(/simulator.smigHint 52 000/)).toBeTruthy())
    // Le titre, lui, continue de nommer le pays réellement simulé : c'est
    // un fait sur le résultat affiché, pas un repère légal pour la saisie.
    expect(screen.queryByText(/simulator.smigHint 75 000/)).toBeNull()
  })
})
