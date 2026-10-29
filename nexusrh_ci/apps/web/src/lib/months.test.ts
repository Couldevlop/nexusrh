import { describe, it, expect } from 'vitest'
import { recentMonths } from './months'

describe('recentMonths', () => {
  it('29 octobre 2026 : 12 mois uniques, février présent, mars une seule fois', () => {
    const months = recentMonths(12, new Date(2026, 9, 29, 12, 0, 0))
    expect(months).toEqual([
      '2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05',
      '2026-04', '2026-03', '2026-02', '2026-01', '2025-12', '2025-11',
    ])
    expect(new Set(months).size).toBe(12)
    expect(months.filter(m => m === '2026-03')).toHaveLength(1)
    expect(months).toContain('2026-02')
  })

  it('31 du mois (mois courts : avril, juin, septembre, novembre, février)', () => {
    const months = recentMonths(12, new Date(2026, 11, 31, 23, 30, 0))
    expect(new Set(months).size).toBe(12)
    expect(months[0]).toBe('2026-12')
    expect(months[11]).toBe('2026-01')
  })

  it('janvier : bascule correcte sur l\'année précédente', () => {
    expect(recentMonths(3, new Date(2027, 0, 15))).toEqual(['2027-01', '2026-12', '2026-11'])
  })

  it('count = 0 → liste vide', () => {
    expect(recentMonths(0, new Date(2026, 5, 1))).toEqual([])
  })
})