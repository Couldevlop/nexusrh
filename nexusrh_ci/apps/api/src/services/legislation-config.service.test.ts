/**
 * TU — vue de paramétrage légal d'un tenant (buildLegislationConfig).
 *
 * Garantit que le choix d'un pays installe la bonne configuration (pack complet)
 * et que les replis / drapeaux de sécurité (supported / usable) sont corrects.
 */
import { describe, it, expect } from 'vitest'
import { buildLegislationConfig } from './legislation-config.service.js'
import { CIV_2024, SEN_2024 } from './legislation-packs.js'

describe('buildLegislationConfig — paramétrage légal par pays', () => {
  it('CIV : pack actif, utilisable, configuration complète', () => {
    const v = buildLegislationConfig('CIV')
    expect(v.countryCode).toBe('CIV')
    expect(v.supported).toBe(true)
    expect(v.usable).toBe(true)            // status active → calcul autorisé
    expect(v.pack).toBe(CIV_2024)
    expect(v.pack.smigMensuel).toBe(75_000)
    expect(v.pack.tranchesImpotSalaire.length).toBeGreaterThan(0)
    expect(v.countryLabel).toBe('Côte d\'Ivoire')
  })

  it('SEN : pack pris en charge et utilisable (actif)', () => {
    const v = buildLegislationConfig('SEN')
    expect(v.countryCode).toBe('SEN')
    expect(v.supported).toBe(true)
    expect(v.usable).toBe(true)            // actif → calcul autorisé
    expect(v.pack).toBe(SEN_2024)
  })

  it('pays inconnu : repli sur CIV, marqué non pris en charge', () => {
    const v = buildLegislationConfig('XXX')
    expect(v.supported).toBe(false)        // le pays demandé n'existe pas
    expect(v.countryCode).toBe('CIV')      // mais on retombe sur un pack valide
    expect(v.pack).toBe(CIV_2024)
    expect(v.usable).toBe(true)
  })

  it('null/undefined : repli sécurisé sur CIV', () => {
    expect(buildLegislationConfig(null).countryCode).toBe('CIV')
    expect(buildLegislationConfig(undefined).pack).toBe(CIV_2024)
  })

  it('la liste des pays sélectionnables accompagne toujours la vue', () => {
    const v = buildLegislationConfig('CIV')
    expect(v.available).toHaveLength(16)
    expect(v.available.some(c => c.countryCode === 'SEN')).toBe(true)
  })
})
