import { describe, it, expect } from 'vitest'
import { BEN_2024, CIV_2024, TGO_2024 } from './legislation-packs.js'
import { explainLines } from './payroll-explainer.service.js'
import type { PayrollLine } from './payroll-engine-ci.js'

const line = (code: string): PayrollLine => ({ code, label: 'x', type: 'earning', base: 100_000, amount: 10_000 })

describe('explainLines selon le pack', () => {
  it('CIV (défaut et explicite) : sortie historique', () => {
    const [d] = explainLines([line('1400')])
    const [e] = explainLines([line('1400')], CIV_2024)
    expect(e).toEqual(d)
    expect(d?.rate).toBe(0.15)
    expect(d?.legalReference).toContain('2024-898')
    expect(d?.legalReference).toContain('art. 25')
    expect(d?.formulaHuman).toContain('+15 %')
    expect(d?.formulaHuman).toContain('46e heure')
  })
  it('CIV : heures supplémentaires du décret n° 2024-898 (art. 25)', () => {
    const [n47, nuit, dim, ferie] = explainLines(['1450', '1500', '1520', '1550'].map(line))
    expect(n47).toMatchObject({ rate: 0.5, category: 'overtime' })
    expect(n47?.formulaHuman).toContain('au-delà de la 46e heure')
    expect(n47?.formulaHuman).toContain('+50 %')
    expect(nuit).toMatchObject({ rate: 0.75 })
    expect(nuit?.formulaHuman).toContain('de nuit majorées de +75 %')
    expect(dim).toMatchObject({ rate: 0.75 })
    expect(dim?.formulaHuman).toContain('de jour, les dimanches et jours fériés')
    expect(ferie).toMatchObject({ rate: 1 })
    expect(ferie?.formulaHuman).toContain('de nuit, les dimanches et jours fériés, majorées de +100 %')
    for (const x of [n47, nuit, dim, ferie]) expect(x?.legalReference).toContain('2024-898')
  })
  it('CIV : plafonds CNPS 2023 (3 375 000 / 75 000) et source', () => {
    const [ret, pf, at] = explainLines(['2000', '3100', '3300'].map(line))
    expect(ret?.baseLabel?.replace(/\s/g, ' ')).toContain('3 375 000 FCFA')
    expect(pf?.baseLabel?.replace(/\s/g, ' ')).toContain('75 000 FCFA')
    expect(at?.baseLabel?.replace(/\s/g, ' ')).toContain('75 000 FCFA')
    for (const x of [ret, pf, at]) {
      expect(x?.legalReference).toContain('communiqué CNPS du 11/01/2023')
      expect(x?.legalReference).toContain('2022-986')
    }
  })
  it('CIV : lignes CMU 2200 / 3400', () => {
    const [sal, pat] = explainLines(['2200', '3400'].map(line))
    expect(sal).toMatchObject({ category: 'health' })
    expect(sal?.formulaHuman).toContain('500 F par bénéficiaire')
    expect(sal?.formulaHuman).toContain('au-delà du 6e')
    expect(pat?.formulaHuman).toContain('500 F par bénéficiaire')
    for (const x of [sal, pat]) expect(x?.legalReference).toContain('2014-131')
  })
  it('TGO 1500 : nuit 50 % / dimanche 65 %, aucun article ivoirien', () => {
    const [x] = explainLines([line('1500')], TGO_2024)
    expect(x?.formulaHuman).toContain('nuit (+50 %)')
    expect(x?.formulaHuman).toContain('dimanche (+65 %)')
    expect(x?.legalReference).toBeUndefined()
    expect(x?.formulaHuman).not.toContain('CNPS')
  })
  it('BEN 1400 : +12 %', () => {
    const [x] = explainLines([line('1400')], BEN_2024)
    expect(x?.rate).toBe(0.12)
    expect(x?.formulaHuman).toContain('+12 %')
  })
  it('non-CIV : aucune référence ivoirienne dans les rubriques courantes', () => {
    const codes = ['1000', '1100', '1300', '1600', '1630', '2000', '2100', '3000', '3300', '5100', '6000']
    for (const x of explainLines(codes.map(line), TGO_2024)) {
      const txt = `${x.formulaHuman} ${x.baseLabel ?? ''} ${x.legalReference ?? ''}`
      expect(txt, x.code).not.toMatch(/\bCI\b|CNPS|ITS|Ivoir|Abidjan|Bouaké/)
    }
  })
})
