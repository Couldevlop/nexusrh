import { describe, it, expect } from 'vitest'
import { payslipColumnLabels } from './payslip-labels'

describe('payslipColumnLabels', () => {
  it('tout CI → libellés CI', () => {
    expect(payslipColumnLabels([
      { caisse_short: 'CNPS', impot_short: 'ITS' }, { caisse_short: 'CNPS', impot_short: 'ITS' },
    ])).toEqual({ mixed: false, caisse: 'CNPS', impot: 'ITS' })
  })
  it('liste vide ou ancienne API sans libellés → CI', () => {
    expect(payslipColumnLabels([])).toEqual({ mixed: false, caisse: 'CNPS', impot: 'ITS' })
    expect(payslipColumnLabels([{}])).toEqual({ mixed: false, caisse: 'CNPS', impot: 'ITS' })
  })
  it('filtre sur un seul pays (Burkina) → CNSS / IUTS', () => {
    expect(payslipColumnLabels([{ caisse_short: 'CNSS', impot_short: 'IUTS' }]))
      .toEqual({ mixed: false, caisse: 'CNSS', impot: 'IUTS' })
  })
  it('CI + Burkina + Bénin → en-têtes neutres', () => {
    expect(payslipColumnLabels([
      { caisse_short: 'CNPS', impot_short: 'ITS' },
      { caisse_short: 'CNSS', impot_short: 'IUTS' },
      { caisse_short: 'CNSS', impot_short: 'ITS' },
    ])).toEqual({ mixed: true })
  })
})