import { describe, it, expect } from 'vitest'
import {
  evaluateScreening,
  sanitizeCriteria,
  parseDiploma,
  type ScreeningCriteria,
  type CandidateExtracted,
} from './recruitment-screening.service.js'

describe('recruitment-screening — evaluateScreening (règles dures pures)', () => {
  it('sans critères → revue humaine (jamais d\'auto-rejet)', () => {
    const v = evaluateScreening(null, { yearsExperience: 0, skills: [] }, 10)
    expect(v.decision).toBe('review')
    expect(v.knockoutFailed).toBe(false)
    expect(v.failedRules).toHaveLength(0)
  })

  it('expérience insuffisante → auto-rejet knockout', () => {
    const crit: ScreeningCriteria = { minExperienceYears: 5 }
    const v = evaluateScreening(crit, { yearsExperience: 2 }, 90)
    expect(v.decision).toBe('auto_reject')
    expect(v.knockoutFailed).toBe(true)
    expect(v.autoRejectReason).toContain('Expérience insuffisante')
  })

  it('expérience inconnue → PAS de knockout (revue humaine, prudence A04)', () => {
    const crit: ScreeningCriteria = { minExperienceYears: 5 }
    const v = evaluateScreening(crit, { yearsExperience: null }, 90)
    expect(v.decision).toBe('review')
    expect(v.knockoutFailed).toBe(false)
  })

  it('compétence obligatoire absente → auto-rejet', () => {
    const crit: ScreeningCriteria = { requiredSkills: ['React', 'Node.js'] }
    const ext: CandidateExtracted = { skills: ['React', 'Vue'] }
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('auto_reject')
    expect(v.autoRejectReason).toContain('Node.js')
  })

  it('compétence présente via variante normalisée (Node ↔ Node.js)', () => {
    const crit: ScreeningCriteria = { requiredSkills: ['Node'] }
    const ext: CandidateExtracted = { skills: ['Node.js', 'Docker'] }
    const v = evaluateScreening(crit, ext, 80)
    expect(v.decision).toBe('review')
    expect(v.passedRules.join(' ')).toContain('compétences obligatoires')
  })

  it('localisation hors zone → auto-rejet ; inconnue → revue', () => {
    const crit: ScreeningCriteria = { allowedLocations: ['Abidjan', 'Bouaké'] }
    expect(evaluateScreening(crit, { location: 'Dakar' }, 80).decision).toBe('auto_reject')
    expect(evaluateScreening(crit, { location: null }, 80).decision).toBe('review')
    expect(evaluateScreening(crit, { location: 'Abidjan, Cocody' }, 80).decision).toBe('review')
  })

  it('prétention salariale au-dessus du max → auto-rejet', () => {
    const crit: ScreeningCriteria = { maxExpectedSalary: 500_000 }
    expect(evaluateScreening(crit, { expectedSalary: 800_000 }, 80).decision).toBe('auto_reject')
    expect(evaluateScreening(crit, { expectedSalary: 400_000 }, 80).decision).toBe('review')
  })

  it('diplôme insuffisant → auto-rejet ; non reconnu → revue', () => {
    const crit: ScreeningCriteria = { minDiploma: 'bac+3' }
    expect(evaluateScreening(crit, { highestDiploma: 'BTS' }, 80).decision).toBe('auto_reject')
    expect(evaluateScreening(crit, { highestDiploma: 'Master 2' }, 80).decision).toBe('review')
    expect(evaluateScreening(crit, { highestDiploma: 'truc inconnu' }, 80).decision).toBe('review')
  })

  it('seuil de score : sous le seuil → auto-rejet (mais pas un knockout structurel)', () => {
    const crit: ScreeningCriteria = { autoRejectBelowScore: 50 }
    const v = evaluateScreening(crit, {}, 30)
    expect(v.decision).toBe('auto_reject')
    expect(v.belowScoreThreshold).toBe(true)
    expect(v.knockoutFailed).toBe(false)
  })

  it('knockoutEnabled=false → les règles dures sont neutralisées, le seuil reste actif', () => {
    const crit: ScreeningCriteria = {
      knockoutEnabled: false,
      requiredSkills: ['React'],
      autoRejectBelowScore: 50,
    }
    // compétence absente mais knockout désactivé + score ok → review
    expect(evaluateScreening(crit, { skills: ['Vue'] }, 80).decision).toBe('review')
    // score sous seuil → auto-rejet quand même
    expect(evaluateScreening(crit, { skills: ['Vue'] }, 30).decision).toBe('auto_reject')
  })

  it('candidat conforme sur tous les critères → revue', () => {
    const crit: ScreeningCriteria = {
      minExperienceYears: 3,
      requiredSkills: ['React'],
      allowedLocations: ['Abidjan'],
      maxExpectedSalary: 1_000_000,
      minDiploma: 'bac+3',
      autoRejectBelowScore: 50,
    }
    const ext: CandidateExtracted = {
      yearsExperience: 5,
      skills: ['React', 'TypeScript'],
      location: 'Abidjan',
      expectedSalary: 700_000,
      highestDiploma: 'Licence',
    }
    const v = evaluateScreening(crit, ext, 78)
    expect(v.decision).toBe('review')
    expect(v.failedRules).toHaveLength(0)
    expect(v.passedRules.length).toBeGreaterThanOrEqual(5)
  })
})

describe('recruitment-screening — parseDiploma', () => {
  it('mappe les libellés courants CI/FR', () => {
    expect(parseDiploma('Master 2')).toBe('bac+5')
    expect(parseDiploma('Licence professionnelle')).toBe('bac+3')
    expect(parseDiploma('BTS Informatique')).toBe('bac+2')
    expect(parseDiploma('Doctorat')).toBe('doctorat')
    expect(parseDiploma('Baccalauréat')).toBe('bac')
    expect(parseDiploma('inconnu')).toBeNull()
    expect(parseDiploma(null)).toBeNull()
  })
})

describe('recruitment-screening — sanitizeCriteria (OWASP A03/A04)', () => {
  it('borne les valeurs et ignore les champs inattendus', () => {
    const c = sanitizeCriteria({
      minExperienceYears: 999,        // > 50 → null
      requiredSkills: ['  React  ', '', 123, 'Node'], // trim + filtre
      autoRejectBelowScore: 200,      // > 100 → null
      maxExpectedSalary: -10,         // < 0 → null
      minDiploma: 'bac+3',
      injection: 'DROP TABLE',        // ignoré
    })
    expect(c.minExperienceYears).toBeNull()
    expect(c.requiredSkills).toEqual(['React', 'Node'])
    expect(c.autoRejectBelowScore).toBeNull()
    expect(c.maxExpectedSalary).toBeNull()
    expect(c.minDiploma).toBe('bac+3')
    expect((c as Record<string, unknown>)['injection']).toBeUndefined()
  })

  it('minDiploma invalide → null', () => {
    expect(sanitizeCriteria({ minDiploma: 'bac+7' }).minDiploma).toBeNull()
  })

  it('knockoutEnabled défaut true, explicitement false respecté', () => {
    expect(sanitizeCriteria({}).knockoutEnabled).toBe(true)
    expect(sanitizeCriteria({ knockoutEnabled: false }).knockoutEnabled).toBe(false)
  })
})
