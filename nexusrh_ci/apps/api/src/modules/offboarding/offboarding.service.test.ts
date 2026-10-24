import { describe, it, expect } from 'vitest'
import {
  DEPARTURE_TYPES,
  OFFBOARDING_STATUSES,
  DEFAULT_CHECKLIST,
  isValidStatus,
  canTransition,
  noticeMonths,
  computeSettlement,
} from './offboarding.service.js'
import { CIV_2024, type TerminationRules } from '../../services/legislation-packs.js'

const CI_RULES = CIV_2024.terminationRules!

describe('offboarding.service — types, statuts, transitions', () => {
  it('checklist par défaut couvre restitution matériel + accès', () => {
    const keys = DEFAULT_CHECKLIST.map((c) => c.key)
    expect(keys).toContain('badge')
    expect(keys).toContain('materiel_informatique')
    expect(keys).toContain('acces_si')
    expect(DEFAULT_CHECKLIST.every((c) => c.done === false)).toBe(true)
  })
  it('transitions de statut', () => {
    expect(canTransition('open', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'settled')).toBe(true)
    expect(canTransition('settled', 'closed')).toBe(true)
    expect(canTransition('open', 'closed')).toBe(false)
    expect(canTransition('closed', 'open')).toBe(false)
  })
})

describe('offboarding.service — préavis (pack CIV-2024)', () => {
  it('durée de préavis selon ancienneté — bornes historiques inchangées', () => {
    expect(noticeMonths(6, CI_RULES)).toBe(1)
    expect(noticeMonths(11, CI_RULES)).toBe(1)
    expect(noticeMonths(12, CI_RULES)).toBe(2)
    expect(noticeMonths(24, CI_RULES)).toBe(2)
    expect(noticeMonths(60, CI_RULES)).toBe(2)
    expect(noticeMonths(61, CI_RULES)).toBe(3)
    expect(noticeMonths(72, CI_RULES)).toBe(3)
  })
  it('sans règles paramétrées : aucune durée (jamais les règles CI par défaut)', () => {
    expect(noticeMonths(24, null)).toBeNull()
  })
})

describe('offboarding.service — solde de tout compte', () => {
  it('démission : uniquement indemnité de congés (pas de préavis payé ni licenciement)', () => {
    const s = computeSettlement({
      monthlyGross: 300_000, seniorityMonths: 40, departureType: 'demission',
      congesDaysOutstanding: 12, noticeServed: true, rules: CI_RULES,
    })
    expect(s.indemnitePreavis).toBe(0)
    expect(s.indemniteLicenciement).toBe(0)
    expect(s.indemniteConges).toBe(Math.round(12 * Math.round(300_000 / 30)))
    expect(s.total).toBe(s.indemniteConges)
    expect(s.warnings).toEqual([])
  })

  it('licenciement 7 ans : congés + indemnité de licenciement progressive', () => {
    const monthly = 300_000
    const s = computeSettlement({
      monthlyGross: monthly, seniorityMonths: 84, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: true, rules: CI_RULES,
    })
    // 7 ans : années 1-5 à 30 %, années 6-7 à 35 %
    const expected = Math.round(0.30 * monthly) * 5 + Math.round(0.35 * monthly) * 2
    expect(s.seniorityYears).toBe(7)
    expect(s.indemniteLicenciement).toBe(expected)
    expect(s.indemnitePreavis).toBe(0) // préavis effectué
  })

  it('licenciement 12 ans : le palier au-delà de 10 ans passe à 40 %', () => {
    const monthly = 100_000
    const s = computeSettlement({
      monthlyGross: monthly, seniorityMonths: 144, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: true, rules: CI_RULES,
    })
    expect(s.indemniteLicenciement).toBe(30_000 * 5 + 35_000 * 5 + 40_000 * 2)
  })

  it('licenciement avec préavis NON effectué : indemnité compensatrice de préavis due', () => {
    const monthly = 300_000
    const s = computeSettlement({
      monthlyGross: monthly, seniorityMonths: 24, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: false, rules: CI_RULES,
    })
    expect(s.noticeMonths).toBe(2)
    expect(s.indemnitePreavis).toBe(2 * monthly)
  })

  it('montants entiers (jamais de décimale)', () => {
    const s = computeSettlement({
      monthlyGross: 123_457, seniorityMonths: 30, departureType: 'licenciement',
      congesDaysOutstanding: 7, noticeServed: false, rules: CI_RULES,
    })
    for (const v of [s.indemniteConges, s.indemnitePreavis, s.indemniteLicenciement, s.total]) {
      expect(Number.isInteger(v)).toBe(true)
    }
    expect(s.total).toBe(s.indemniteConges + s.indemnitePreavis + s.indemniteLicenciement)
  })

  it('ancienneté < 1 an : pas d\'indemnité de licenciement', () => {
    const s = computeSettlement({
      monthlyGross: 200_000, seniorityMonths: 8, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: true, rules: CI_RULES,
    })
    expect(s.seniorityYears).toBe(0)
    expect(s.indemniteLicenciement).toBe(0)
  })
})

describe('offboarding.service — règles par pays / tenant', () => {
  it('pays sans règles : préavis et licenciement à 0 + avertissements, congés toujours dus', () => {
    const s = computeSettlement({
      monthlyGross: 300_000, seniorityMonths: 84, departureType: 'licenciement',
      congesDaysOutstanding: 10, noticeServed: false, rules: null,
    })
    expect(s.indemnitePreavis).toBe(0)
    expect(s.indemniteLicenciement).toBe(0)
    expect(s.indemniteConges).toBe(100_000)
    expect(s.warnings).toHaveLength(2)
  })

  it('préavis saisi au dossier : prime sur les règles et lève l\'avertissement', () => {
    const s = computeSettlement({
      monthlyGross: 300_000, seniorityMonths: 24, departureType: 'rupture_conventionnelle',
      congesDaysOutstanding: 0, noticeServed: false, rules: null, noticeMonthsOverride: 1.5,
    })
    expect(s.noticeMonths).toBe(1.5)
    expect(s.indemnitePreavis).toBe(450_000)
    expect(s.warnings).toEqual([])
  })

  it('convention du tenant plus favorable : ses paliers s\'appliquent', () => {
    const convention: TerminationRules = {
      noticeMonths: [{ upToSeniorityMonths: null, months: 3 }],
      severanceRates: [{ upToYear: null, rate: 0.5 }],
    }
    const s = computeSettlement({
      monthlyGross: 200_000, seniorityMonths: 36, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: false, rules: convention,
    })
    expect(s.indemnitePreavis).toBe(600_000)
    expect(s.indemniteLicenciement).toBe(300_000)
  })
})
