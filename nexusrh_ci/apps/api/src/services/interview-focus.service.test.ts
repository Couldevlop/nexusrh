import { describe, it, expect } from 'vitest'
import { parseInterviewFocus, CECRL_LEVELS } from './interview-focus.service.js'

describe('parseInterviewFocus', () => {
  it('accepte un profil complet et valide', () => {
    const input = {
      technologies: [
        { name: 'Java', yearsRequired: 5 },
        { name: 'Spring', yearsRequired: 3 },
      ],
      tools: ['Git', 'Jenkins'],
      methodologies: ['Scrum', 'SAFe'],
      languages: [{ language: 'Anglais', level: 'B2' }],
    }
    expect(parseInterviewFocus(input)).toEqual(input)
  })

  it('null/undefined → profil vide (non renseigné)', () => {
    const empty = { technologies: [], tools: [], methodologies: [], languages: [] }
    expect(parseInterviewFocus(null)).toEqual(empty)
    expect(parseInterviewFocus(undefined)).toEqual(empty)
  })

  it('rejette une technologie sans nom', () => {
    expect(parseInterviewFocus({ technologies: [{ name: '', yearsRequired: 5 }], tools: [], methodologies: [], languages: [] })).toBeNull()
  })

  it('rejette des années hors bornes (négatif ou > 40)', () => {
    expect(parseInterviewFocus({ technologies: [{ name: 'Java', yearsRequired: -1 }], tools: [], methodologies: [], languages: [] })).toBeNull()
    expect(parseInterviewFocus({ technologies: [{ name: 'Java', yearsRequired: 41 }], tools: [], methodologies: [], languages: [] })).toBeNull()
  })

  it('rejette un niveau CECRL invalide', () => {
    expect(parseInterviewFocus({ technologies: [], tools: [], methodologies: [], languages: [{ language: 'Anglais', level: 'Z9' }] })).toBeNull()
  })

  it('rejette plus de 15 technologies (borne anti-abus)', () => {
    const technologies = Array.from({ length: 16 }, (_, i) => ({ name: `Tech${i}`, yearsRequired: 1 }))
    expect(parseInterviewFocus({ technologies, tools: [], methodologies: [], languages: [] })).toBeNull()
  })

  it('rejette un champ inconnu (schema strict)', () => {
    expect(parseInterviewFocus({ technologies: [], tools: [], methodologies: [], languages: [], extra: 'x' })).toBeNull()
  })

  it('CECRL_LEVELS expose les 6 niveaux dans l\'ordre', () => {
    expect(CECRL_LEVELS).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
  })
})
