import { describe, it, expect } from 'vitest'
import { renderHrDocumentPdf } from './hr-document-pdf.js'
import { generateHRDocument } from '../../services/hr-document-generator.service.js'

describe('renderHrDocumentPdf', () => {
  it('produit un PDF valide (%PDF header) depuis un contrat CDI', async () => {
    const { markdown } = generateHRDocument({
      type: 'cdi_ci',
      tenantName: 'SOTRA',
      city: 'Abidjan',
      employer: { cnpsNumber: 'CI-001', rccm: 'CI-ABJ-1' },
      employee: { firstName: 'Awa', lastName: 'Traoré', jobTitle: 'Chauffeur', nni: 'NNI-1' },
      salary: 250000,
      startDate: '2026-07-01',
      isCadre: true,
    })
    const pdf = await renderHrDocumentPdf(markdown)
    expect(pdf).toBeInstanceOf(Uint8Array)
    expect(pdf.byteLength).toBeGreaterThan(800)
    expect(Buffer.from(pdf.subarray(0, 4)).toString()).toBe('%PDF')
  })

  it('gère titres, tableaux, séparateurs et caractères hors WinAnsi (multi-pages)', async () => {
    const md = [
      '# Titre Principal',
      '## Section',
      '### Sous-titre',
      '---',
      '| Col A | Col B |',
      '|---|---|',
      '| v1 | v2 |',
      '**Ligne en gras pleine**',
      'Un paragraphe normal avec un caractère hors plage : 🚀 et des accents éàù.',
      ...Array.from({ length: 120 }, (_, i) => `Clause numéro ${i + 1} du contrat, texte de remplissage pour forcer la pagination.`),
    ].join('\n')
    const pdf = await renderHrDocumentPdf(md)
    expect(Buffer.from(pdf.subarray(0, 4)).toString()).toBe('%PDF')
    expect(pdf.byteLength).toBeGreaterThan(2000)
  })
})
