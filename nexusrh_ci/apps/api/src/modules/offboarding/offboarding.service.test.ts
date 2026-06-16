import { describe, it, expect } from 'vitest'
import {
  DEPARTURE_TYPES,
  OFFBOARDING_STATUSES,
  DEFAULT_CHECKLIST,
  isValidDepartureType,
  isValidStatus,
  canTransition,
  noticeMonths,
  computeSettlement,
} from './offboarding.service.js'

describe('offboarding.service — types, statuts, transitions', () => {
  it('valide types et statuts', () => {
    expect(isValidDepartureType('licenciement')).toBe(true)
    expect(isValidDepartureType('xxx')).toBe(false)
    expect(isValidStatus('settled')).toBe(true)
    expect(isValidStatus('zzz')).toBe(false)
    expect(DEPARTURE_TYPES.length).toBeGreaterThanOrEqual(5)
  })
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

describe('offboarding.service — préavis (Code du travail CI)', () => {
  it('durée de préavis selon ancienneté', () => {
    expect(noticeMonths(6)).toBe(1)
    expect(noticeMonths(24)).toBe(2)
    expect(noticeMonths(72)).toBe(3)
  })
})

describe('offboarding.service — solde de tout compte', () => {
  it('démission : uniquement indemnité de congés (pas de préavis payé ni licenciement)', () => {
    const s = computeSettlement({
      monthlyGross: 300_000, seniorityMonths: 40, departureType: 'demission',
      congesDaysOutstanding: 12, noticeServed: true,
    })
    expect(s.indemnitePreavis).toBe(0)
    expect(s.indemniteLicenciement).toBe(0)
    expect(s.indemniteConges).toBe(Math.round(12 * Math.round(300_000 / 30)))
    expect(s.total).toBe(s.indemniteConges)
  })

  it('licenciement 7 ans : congés + indemnité de licenciement progressive', () => {
    const monthly = 300_000
    const s = computeSettlement({
      monthlyGross: monthly, seniorityMonths: 84, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: true,
    })
    // 7 ans : années 1-5 à 30 %, années 6-7 à 35 %
    const expected = Math.round(0.30 * monthly) * 5 + Math.round(0.35 * monthly) * 2
    expect(s.seniorityYears).toBe(7)
    expect(s.indemniteLicenciement).toBe(expected)
    expect(s.indemnitePreavis).toBe(0) // préavis effectué
  })

  it('licenciement avec préavis NON effectué : indemnité compensatrice de préavis due', () => {
    const monthly = 300_000
    const s = computeSettlement({
      monthlyGross: monthly, seniorityMonths: 24, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: false,
    })
    expect(s.noticeMonths).toBe(2)
    expect(s.indemnitePreavis).toBe(2 * monthly)
  })

  it('montants entiers (FCFA, jamais de décimale)', () => {
    const s = computeSettlement({
      monthlyGross: 123_457, seniorityMonths: 30, departureType: 'licenciement',
      congesDaysOutstanding: 7, noticeServed: false,
    })
    for (const v of [s.indemniteConges, s.indemnitePreavis, s.indemniteLicenciement, s.total]) {
      expect(Number.isInteger(v)).toBe(true)
    }
    expect(s.total).toBe(s.indemniteConges + s.indemnitePreavis + s.indemniteLicenciement)
  })

  it('ancienneté < 1 an : pas d\'indemnité de licenciement', () => {
    const s = computeSettlement({
      monthlyGross: 200_000, seniorityMonths: 8, departureType: 'licenciement',
      congesDaysOutstanding: 0, noticeServed: true,
    })
    expect(s.seniorityYears).toBe(0)
    expect(s.indemniteLicenciement).toBe(0)
  })
})
