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
    expect(d?.legalReference).toContain('Article 21.3')
    expect(d?.formulaHuman).toContain('+15 %')
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
