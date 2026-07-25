/**
 * Le niveau de poste des employés de démo doit rendre les offres internes
 * CIBLÉES réellement visibles.
 *
 * Régression couverte (prod, 25/07/2026) : les 82 employés SOTRA avaient
 * `job_level = NULL`, alors que les 3 offres internes ouvertes ciblent des
 * niveaux précis. `e.job_level = ANY(rj.target_job_levels)` ne matchait donc
 * personne → « Mes offres internes » vide pour tout le monde, et le bouton
 * « S'entraîner à l'entretien » (interview_sim) inatteignable.
 */
import { describe, it, expect } from 'vitest'
import { JOB_LEVELS, jobLevelForSalary, type JobLevel } from './seed-job-level.js'

// Grilles de salaire des départements SOTRA (seed.ts — SOTRA_DEPTS).
const SOTRA_RANGES: Record<string, [number, number]> = {
  DG:  [300_000, 600_000],
  EXP: [80_000, 180_000],
  MTN: [90_000, 200_000],
  FIN: [120_000, 280_000],
  RH:  [120_000, 250_000],
  COM: [100_000, 220_000],
  IT:  [150_000, 350_000],
  SEC: [75_000, 130_000],
}
// Ciblage des offres internes de démo (seed.ts — SOTRA_JOBS_OFFERS).
const OFFER_TARGETS: Array<{ dept: string; levels: JobLevel[] }> = [
  { dept: 'EXP', levels: ['agent_maitrise', 'ouvrier'] },
  { dept: 'EXP', levels: ['agent_maitrise', 'employe'] },
  { dept: 'DG',  levels: ['cadre'] },
]

/** Niveaux atteignables dans une fourchette de salaire (pas de 1 000 FCFA). */
function levelsInRange([min, max]: [number, number]): Set<JobLevel> {
  const out = new Set<JobLevel>()
  for (let s = min; s <= max; s += 1_000) out.add(jobLevelForSalary(s))
  return out
}

describe('jobLevelForSalary', () => {
  it('ne renvoie qu’une clé technique de la liste canonique', () => {
    for (const s of [0, 60_000, 110_000, 150_000, 300_000, 2_000_000]) {
      expect(JOB_LEVELS).toContain(jobLevelForSalary(s))
    }
  })

  it('est monotone : un salaire supérieur ne rétrograde jamais le niveau', () => {
    const rank = (l: JobLevel) => ['ouvrier', 'employe', 'agent_maitrise', 'cadre'].indexOf(l)
    let previous = -1
    for (let s = 0; s <= 1_000_000; s += 5_000) {
      const r = rank(jobLevelForSalary(s))
      expect(r).toBeGreaterThanOrEqual(previous)
      previous = r
    }
  })

  it('respecte les seuils documentés', () => {
    expect(jobLevelForSalary(109_999)).toBe('ouvrier')
    expect(jobLevelForSalary(110_000)).toBe('employe')
    expect(jobLevelForSalary(149_999)).toBe('employe')
    expect(jobLevelForSalary(150_000)).toBe('agent_maitrise')
    expect(jobLevelForSalary(299_999)).toBe('agent_maitrise')
    expect(jobLevelForSalary(300_000)).toBe('cadre')
  })
})

describe('couverture des offres internes de démo', () => {
  it('chaque niveau canonique est représenté dans l’effectif SOTRA', () => {
    const all = new Set<JobLevel>()
    for (const range of Object.values(SOTRA_RANGES)) {
      for (const l of levelsInRange(range)) all.add(l)
    }
    for (const level of JOB_LEVELS) expect(all).toContain(level)
  })

  it('chaque offre interne ciblée a des destinataires dans son département', () => {
    for (const { dept, levels } of OFFER_TARGETS) {
      const reachable = levelsInRange(SOTRA_RANGES[dept]!)
      const matching = levels.filter((l) => reachable.has(l))
      expect(matching.length, `offre ciblant ${levels.join('/')} dans ${dept}`).toBeGreaterThan(0)
    }
  })
})
