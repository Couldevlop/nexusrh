import { describe, it, expect } from 'vitest'
import {
  resolvePeriod, median, average, percent, normalizeSource,
  bySource, byStage, byDepartureType, summarizeRetention,
  APPLICATION_SOURCES, PIPELINE_STAGES,
} from './employer-brand.service.js'

describe('resolvePeriod', () => {
  const today = new Date('2026-10-29T10:00:00Z')
  it('défaut : 12 derniers mois jusqu\'à aujourd\'hui', () => {
    expect(resolvePeriod(undefined, undefined, today)).toEqual({ from: '2025-10-30', to: '2026-10-29' })
  })
  it('bornes explicites conservées', () => {
    expect(resolvePeriod('2026-01-01', '2026-06-30', today)).toEqual({ from: '2026-01-01', to: '2026-06-30' })
  })
  it('début seul : fin = aujourd\'hui', () => {
    expect(resolvePeriod('2026-01-01', '', today)).toEqual({ from: '2026-01-01', to: '2026-10-29' })
  })
  it('rejette une date mal formée ou inexistante', () => {
    expect(() => resolvePeriod('2026-13-01', '2026-12-01', today)).toThrow(/début/)
    expect(() => resolvePeriod('2026-01-01', "2026-01-01' OR 1=1", today)).toThrow(/fin/)
    expect(() => resolvePeriod('2026-02-30', '2026-03-01', today)).toThrow()
  })
  it('rejette début > fin et période > 5 ans', () => {
    expect(() => resolvePeriod('2026-06-01', '2026-01-01', today)).toThrow(/précéder/)
    expect(() => resolvePeriod('2015-01-01', '2026-01-01', today)).toThrow(/5 ans/)
  })
})

describe('statistiques', () => {
  it('médiane paire / impaire / vide', () => {
    expect(median([10, 2, 4])).toBe(4)
    expect(median([1, 2, 3, 10])).toBe(2.5)
    expect(median([])).toBeNull()
  })
  it('moyenne arrondie à 0,1', () => {
    expect(average([1, 2, 2])).toBe(1.7)
    expect(average([])).toBeNull()
  })
  it('pourcentage, null si dénominateur nul', () => {
    expect(percent(1, 3)).toBe(33.3)
    expect(percent(0, 0)).toBeNull()
  })
})

describe('normalisation des catégories', () => {
  it('source vide = manuelle, inconnue = autre', () => {
    expect(normalizeSource(null)).toBe('manual')
    expect(normalizeSource('')).toBe('manual')
    expect(normalizeSource('careers_page')).toBe('careers_page')
    expect(normalizeSource('linkedin')).toBe('other')
  })
  it('bySource : toutes les sources dans l\'ordre, zéros inclus, cumul des inconnues', () => {
    const out = bySource([{ source: 'internal', n: '3' }, { source: 'x', n: 2 }, { source: 'y', n: 1 }, { source: null, n: 4 }])
    expect(out.map((o) => o.source)).toEqual([...APPLICATION_SOURCES])
    expect(out.find((o) => o.source === 'internal')?.count).toBe(3)
    expect(out.find((o) => o.source === 'other')?.count).toBe(3)
    expect(out.find((o) => o.source === 'manual')?.count).toBe(4)
    expect(out.find((o) => o.source === 'careers_page')?.count).toBe(0)
  })
  it('byStage : ordre du kanban', () => {
    const out = byStage([{ stage: 'hired', n: 1 }, { stage: 'new', n: 5 }])
    expect(out.map((o) => o.stage)).toEqual([...PIPELINE_STAGES])
    expect(out[0]).toEqual({ stage: 'new', count: 5 })
  })
  it('byDepartureType : type inconnu → autre', () => {
    const out = byDepartureType([{ departure_type: 'demission', n: 2 }, { departure_type: 'mystere', n: 1 }])
    expect(out.find((o) => o.type === 'demission')?.count).toBe(2)
    expect(out.find((o) => o.type === 'autre')?.count).toBe(1)
  })
})

describe('summarizeRetention', () => {
  it('calcule les taux à partir des compteurs SQL', () => {
    const r = summarizeRetention({
      hires: '10', eligible_3m: 8, retained_3m: 6, eligible_12m: 4, retained_12m: 3,
      departures: 5, early_departures: 2,
    })
    expect(r.hires).toBe(10)
    expect(r.retention3m).toEqual({ eligible: 8, retained: 6, rate: 75 })
    expect(r.retention12m.rate).toBe(75)
    expect(r.earlyDepartureRate).toBe(40)
  })
  it('aucune donnée → zéros et taux null', () => {
    const r = summarizeRetention(undefined)
    expect(r.hires).toBe(0)
    expect(r.retention3m.rate).toBeNull()
    expect(r.earlyDepartureRate).toBeNull()
  })
})
