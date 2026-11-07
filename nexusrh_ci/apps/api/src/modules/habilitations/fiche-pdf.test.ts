/**
 * PDF de la fiche d'habilitation (tâche 10).
 *
 * La fiche est un document qui circule (signature hiérarchique, archivage RH) :
 * elle ne doit porter AUCUNE donnée sensible — ni salaire, ni NNI, ni RIB. Le
 * test l'exige explicitement, parce qu'une régression de ce genre ne se voit
 * pas à la lecture du code mais sur un papier déjà distribué.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), end: vi.fn() })) }))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test', poolMin: 1, poolMax: 2 },
    redis: { url: 'redis://localhost:6380' },
  },
}))

import { ficheMarkdown, draftMarkFor, FICHE_DRAFT_MARK, type FichePdfData } from './fiche-pdf.js'

function data(over: Partial<FichePdfData> = {}): FichePdfData {
  return {
    number: 'HAB-2026-0007',
    status: 'n1',
    kind: 'grant',
    person: { name: 'Awa Koné', matricule: 'SOT-0142' },
    groupName: 'DRH Groupe',
    subgroupName: 'RH Filiale Bouaké',
    scopeLabel: 'Filiale Bouaké',
    permissions: ['employees:view', 'employees:create', 'recruitment:view', 'payroll:validate'],
    sodAlerts: ['Valider la paie et payer'],
    timeline: [
      { event: 'created', actorName: 'Koffi Yao', at: '2026-11-02' },
      { event: 'validated', actorName: 'Mariam Traoré', at: '2026-11-03' },
    ],
    motive: 'Prise de poste au service recrutement',
    ...over,
  }
}

describe('ficheMarkdown', () => {
  it('porte le numéro, la personne, son matricule et le sous-groupe', () => {
    const md = ficheMarkdown(data())
    expect(md).toContain('HAB-2026-0007')
    expect(md).toContain('Awa Koné')
    expect(md).toContain('SOT-0142')
    expect(md).toContain('RH Filiale')
    expect(md).toContain('Filiale Bouaké')
  })

  it('coche les actions fonction par fonction, et ne montre que les fonctions concernées', () => {
    const md = ficheMarkdown(data())
    const employees = md.split('\n').find((l) => l.includes('Employés'))
    expect(employees).toBeDefined()
    // « Consulter » et « Créer » cochées, « Supprimer » non.
    expect(employees).toMatch(/\|\s*X\s*\|/)
    expect(md).not.toContain('Climat social')
  })

  it('ne contient aucun montant ni donnée sensible', () => {
    const md = ficheMarkdown(data())
    expect(md).not.toMatch(/\d[\d\s ]{2,}\s*(FCFA|XOF)/i)
    expect(md.toLowerCase()).not.toContain('salaire')
    expect(md.toLowerCase()).not.toContain('iban')
    expect(md.toLowerCase()).not.toContain('nni')
  })

  it('annonce les cumuls sensibles relevés', () => {
    expect(ficheMarkdown(data())).toContain('Valider la paie et payer')
  })

  it('rend la chronologie des validations avec nom et date', () => {
    const md = ficheMarkdown(data())
    expect(md).toContain('Mariam Traoré')
    expect(md).toContain('2026-11-03')
  })

  it('annonce un retrait de droits quand la fiche est de ce type', () => {
    expect(ficheMarkdown(data({ kind: 'revoke' })).toLowerCase()).toContain('retrait')
  })

  it('sans validateur nommé, la chronologie reste lisible', () => {
    const md = ficheMarkdown(data({ timeline: [{ event: 'created', actorName: null, at: '2026-11-02' }] }))
    expect(md).toContain('2026-11-02')
  })
})

describe('draftMarkFor', () => {
  it('marque le brouillon tant que la fiche n\'est pas verrouillée', () => {
    expect(draftMarkFor('draft')).toBe(FICHE_DRAFT_MARK)
    expect(draftMarkFor('n1')).toBe(FICHE_DRAFT_MARK)
    expect(draftMarkFor('n2')).toBe(FICHE_DRAFT_MARK)
    expect(draftMarkFor('rejected')).toBe(FICHE_DRAFT_MARK)
  })

  it('ne marque plus rien une fois verrouillée ou appliquée', () => {
    expect(draftMarkFor('locked')).toBeNull()
    expect(draftMarkFor('applied')).toBeNull()
  })
})
