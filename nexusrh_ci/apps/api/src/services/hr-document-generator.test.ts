import { describe, it, expect } from 'vitest'
import { generateHRDocument } from './hr-document-generator.service.js'

describe('hr-document-generator (AI-006/007)', () => {
  const base = {
    tenantName: 'SOTRA', city: 'Abidjan',
    employer: { cnpsNumber: 'CI-00123456-X', rccm: 'CI-ABJ-2005-B-123456' },
    employee: { firstName: 'Kouassi', lastName: 'Coulibaly', nni: 'CI123', cnpsNumber: 'A789', jobTitle: 'Chauffeur' },
    salary: 250000, startDate: '2026-01-15',
  }

  it('CDI CI : clauses OHADA + NNI + CNPS + période d\'essai', () => {
    const doc = generateHRDocument({ ...base, type: 'cdi_ci' })
    expect(doc.title).toContain('durée indéterminée')
    expect(doc.markdown).toContain('OHADA')
    expect(doc.markdown).toContain('CI123')              // NNI
    expect(doc.markdown).toContain('A789')               // CNPS salarié
    expect(doc.markdown).toContain('Période d\'essai')
    expect(doc.markdown).toContain('250 000 FCFA') // salaire formaté FR (espace insécable)
  })

  it('cadre → période d\'essai 3 mois', () => {
    const doc = generateHRDocument({ ...base, type: 'cdi_ci', isCadre: true })
    expect(doc.markdown).toContain('trois (3) mois')
  })

  it('non-cadre → période d\'essai 1 mois', () => {
    const doc = generateHRDocument({ ...base, type: 'cdi_ci', isCadre: false })
    expect(doc.markdown).toContain('un (1) mois')
  })

  it('CDD CI : article durée déterminée OHADA', () => {
    const doc = generateHRDocument({ ...base, type: 'cdd_ci', endDate: '2026-12-31' })
    expect(doc.title).toContain('durée déterminée')
    expect(doc.markdown).toContain('CDD')
  })

  it('certificat de travail : nom employé + mentions', () => {
    const doc = generateHRDocument({ ...base, type: 'certificat_travail', endDate: '2026-06-30' })
    expect(doc.title).toBe('Certificat de travail')
    expect(doc.markdown).toContain('Kouassi Coulibaly')
    expect(doc.markdown).toContain('libre de tout engagement')
  })

  it('attestation d\'emploi : poste + salaire', () => {
    const doc = generateHRDocument({ ...base, type: 'attestation_emploi' })
    expect(doc.markdown).toContain('Attestation d\'emploi')
    expect(doc.markdown).toContain('Chauffeur')
  })
})
