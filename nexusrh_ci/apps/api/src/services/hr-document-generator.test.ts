import { describe, it, expect, vi } from 'vitest'

// La cle est lue a l'IMPORT du module de chiffrement : la poser dans le corps
// d'un test serait trop tard. `vi.hoisted` s'execute avant les imports.
vi.hoisted(() => { process.env.ENCRYPTION_KEY = 'c'.repeat(64) })
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
    expect(doc.markdown).toContain('250 000 FCFA') // espace simple : U+202F de toLocaleString deviendrait « ? » dans le PDF
    expect(doc.markdown).not.toMatch(/[\u202F\u00A0]/)
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

describe('NNI chiffré — colonne mixte', () => {
  const base = {
    tenantName: 'SOTRA', city: 'Abidjan',
    employer: { cnpsNumber: 'CI-00123456-X', rccm: 'CI-ABJ-2005-B-123456' },
    salary: 250000, startDate: '2026-01-15',
  }

  it('imprime le NUMÉRO, pas le cryptogramme', async () => {
    // L'attestation lisait `employees.nni` brute. Les 157 NNI de production
    // étant en clair, le defaut passait inaperçu ; le premier NNI saisi par
    // l'interface est chiffré, et c'est le cryptogramme qui serait imprimé sur
    // un document remis au salarié.
    const { encrypt } = await import('@nexusrhci/shared/crypto')
    const chiffre = encrypt('CI-1985-004277')
    expect(chiffre).toContain(':')

    const doc = generateHRDocument({
      ...base, type: 'attestation_emploi',
      employee: { firstName: 'Kouassi', lastName: 'Coulibaly', nni: chiffre, cnpsNumber: 'A789', jobTitle: 'Chauffeur' },
    })
    expect(doc.markdown).toContain('CI-1985-004277')
    expect(doc.markdown).not.toContain(chiffre)
  })

  it('un NNI en clair reste imprimé tel quel', () => {
    const doc = generateHRDocument({
      ...base, type: 'attestation_emploi',
      employee: { firstName: 'Kouassi', lastName: 'Coulibaly', nni: 'CI-1985-004277', cnpsNumber: 'A789', jobTitle: 'Chauffeur' },
    })
    expect(doc.markdown).toContain('CI-1985-004277')
  })
})
