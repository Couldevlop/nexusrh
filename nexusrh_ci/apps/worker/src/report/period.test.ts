import { describe, it, expect } from 'vitest'
import { weeklyPeriod, monthlyPeriod } from './period.js'

describe('weeklyPeriod', () => {
  it('couvre les 7 jours écoulés, dimanche précédent inclus au samedi', () => {
    // Dimanche 6 septembre 2026, 06:00 UTC — heure de déclenchement du cron.
    const p = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
    expect(p.start.toISOString()).toBe('2026-08-30T00:00:00.000Z') // dimanche précédent
    expect(p.end.toISOString()).toBe('2026-09-06T00:00:00.000Z')   // exclu : ce dimanche
    expect(p.type).toBe('weekly')
  })

  it("ne dépend pas de l'heure de déclenchement", () => {
    const a = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
    const b = weeklyPeriod(new Date('2026-09-06T23:59:00Z'))
    expect(a.start.toISOString()).toBe(b.start.toISOString())
  })

  it('rend la même période quel que soit le jour d\'appel dans la semaine', () => {
    const dimanche = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
    for (const t of ['2026-09-07T02:00:00Z', '2026-09-09T18:00:00Z', '2026-09-12T23:59:00Z']) {
      const autre = weeklyPeriod(new Date(t))
      expect(autre.start.toISOString(), `appel du ${t}`).toBe(dimanche.start.toISOString())
      expect(autre.end.toISOString(), `appel du ${t}`).toBe(dimanche.end.toISOString())
    }
  })

  it('libelle la période avec son premier et son dernier jour', () => {
    const p = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
    expect(p.label).toBe('30 août 2026 — 5 septembre 2026')
  })
})

describe('monthlyPeriod', () => {
  it('couvre le mois calendaire précédent', () => {
    const p = monthlyPeriod(new Date('2026-09-01T06:15:00Z'))
    expect(p.start.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(p.end.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(p.type).toBe('monthly')
  })

  it('remonte à décembre quand on est en janvier', () => {
    const p = monthlyPeriod(new Date('2027-01-01T06:15:00Z'))
    expect(p.start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})
