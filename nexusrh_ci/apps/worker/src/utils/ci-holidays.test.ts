// COPIE VERBATIM de apps/api/src/utils/ci-holidays.test.ts — garder synchronisé
// (le worker ne peut pas importer le package api).
import { describe, it, expect } from 'vitest'
import { joursFeriesCI } from './ci-holidays.js'

describe('ci-holidays — jours fériés Côte d\'Ivoire (ABS-008)', () => {
  it('inclut les dates fixes (Fête Nationale 7 août, Noël, 1er mai, etc.)', () => {
    const f2025 = joursFeriesCI(2025)
    expect(f2025.has('2025-08-07')).toBe(true) // Fête Nationale
    expect(f2025.has('2025-01-01')).toBe(true)
    expect(f2025.has('2025-05-01')).toBe(true)
    expect(f2025.has('2025-12-25')).toBe(true)
    expect(f2025.has('2025-11-15')).toBe(true) // Journée Nationale de la Paix
  })

  it('inclut les fêtes chrétiennes mobiles (Lundi de Pâques 2025 = 21 avril)', () => {
    const f2025 = joursFeriesCI(2025)
    expect(f2025.has('2025-04-21')).toBe(true) // Lundi de Pâques 2025
  })

  it('un jour ouvré normal n\'est pas férié', () => {
    // Même assertion qu'avant, mais via `joursFeriesCI` — la seule fonction que
    // le worker appelle réellement (jobs/attendance-evaluate.ts). Le prédicat
    // `estJourFerieCI` n'existait que pour ce test.
    const jours = joursFeriesCI(2025)
    expect(jours.has('2025-08-06')).toBe(false)
    expect(jours.has('2025-08-07')).toBe(true)  // fête de l'Indépendance
  })
})
