import { describe, it, expect, vi } from 'vitest'

// Service pur : la lecture DB (loadRafReadiness) n'est pas exercée ici.
vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }))

import { getLegislationPack } from './legislation-packs.js'
import {
  computeRafReadiness, employeeMissing, isPayrollEligible, variablesFingerprint,
  takeUnjustifiedAbsenceDays, withUnjustifiedAbsence, readinessRefusalMessage,
  type ReadinessEmployeeInput,
} from './raf-readiness.service.js'

const CIV = getLegislationPack('CIV-2024')
const BFA = getLegislationPack('BFA-2024')

function emp(over: Partial<ReadinessEmployeeInput> = {}): ReadinessEmployeeInput {
  return {
    id: 'e1', first_name: 'Awa', last_name: 'Koné', base_salary: '150000',
    marital_status: 'single', children_count: 0, cnps_number: 'CNPS-001',
    payment_method: 'mobile_money', mobile_money_phone: '+2250701020304', has_iban: false,
    ...over,
  }
}

describe('employeeMissing — données salarié obligatoires', () => {
  it('dossier complet → aucun manque', () => {
    expect(employeeMissing(emp(), CIV.smigMensuel)).toEqual([])
  })

  it('0 enfant est une valeur valide, NULL ne l\'est pas', () => {
    expect(employeeMissing(emp({ children_count: 0 }), CIV.smigMensuel)).not.toContain('children_count')
    expect(employeeMissing(emp({ children_count: null }), CIV.smigMensuel)).toContain('children_count')
  })

  it('chaque code manquant est signalé', () => {
    expect(employeeMissing(emp({ marital_status: null }), CIV.smigMensuel)).toEqual(['marital_status'])
    expect(employeeMissing(emp({ marital_status: '  ' }), CIV.smigMensuel)).toEqual(['marital_status'])
    expect(employeeMissing(emp({ cnps_number: '' }), CIV.smigMensuel)).toEqual(['cnps_number'])
    expect(employeeMissing(emp({ payment_method: null }), CIV.smigMensuel)).toEqual(['payment_method'])
    expect(employeeMissing(emp({ payment_method: 'cash' }), CIV.smigMensuel)).toEqual(['payment_method'])
    expect(employeeMissing(emp({ mobile_money_phone: null }), CIV.smigMensuel)).toEqual(['mobile_money_phone'])
    expect(employeeMissing(emp({ payment_method: 'bank_transfer', has_iban: false }), CIV.smigMensuel)).toEqual(['iban'])
    expect(employeeMissing(emp({ payment_method: 'bank_transfer', has_iban: true, mobile_money_phone: null }), CIV.smigMensuel)).toEqual([])
    expect(employeeMissing(emp({ base_salary: '60000' }), CIV.smigMensuel)).toEqual(['below_smig'])
  })

  it('SMIG du pays de la filiale : BFA 45 000, CIV 75 000', () => {
    expect(BFA.smigMensuel).toBe(45_000)
    expect(CIV.smigMensuel).toBe(75_000)
    expect(employeeMissing(emp({ base_salary: '45000' }), BFA.smigMensuel)).toEqual([])
    expect(employeeMissing(emp({ base_salary: '44999' }), BFA.smigMensuel)).toEqual(['below_smig'])
    expect(employeeMissing(emp({ base_salary: '74999' }), CIV.smigMensuel)).toEqual(['below_smig'])
    expect(employeeMissing(emp({ base_salary: '75000' }), CIV.smigMensuel)).toEqual([])
  })

  it('fiches à salaire nul ou négatif hors paie', () => {
    expect(isPayrollEligible({ base_salary: '0' })).toBe(false)
    expect(isPayrollEligible({ base_salary: '-5' })).toBe(false)
    expect(isPayrollEligible({ base_salary: null })).toBe(false)
    expect(isPayrollEligible({ base_salary: '1' })).toBe(true)
  })
})

describe('computeRafReadiness', () => {
  const hashNone = variablesFingerprint({})

  it('prêt quand tous les dossiers sont complets et toutes les lignes validées', () => {
    const r = computeRafReadiness({
      employees: [emp(), emp({ id: 'e2' }), emp({ id: 'e0', base_salary: '0', cnps_number: null })],
      variables: [{ employee_id: 'e2', rule_code: 'PRIME_RENDEMENT', amount: '10000' }],
      validations: [
        { employee_id: 'e1', mode: 'none', variables_hash: hashNone, validated_at: null, validated_by: 'u' },
        { employee_id: 'e2', mode: 'entered', variables_hash: variablesFingerprint({ PRIME_RENDEMENT: 10000 }), validated_at: null, validated_by: 'u' },
      ],
      pack: CIV,
    })
    expect(r.totalEmployees).toBe(2) // la fiche à 0 est ignorée
    expect(r.validatedCount).toBe(2)
    expect(r.ready).toBe(true)
  })

  it('non prêt si une ligne n\'est pas validée', () => {
    const r = computeRafReadiness({ employees: [emp()], variables: [], validations: [], pack: CIV })
    expect(r.dataComplete).toBe(true)
    expect(r.variablesValidated).toBe(false)
    expect(r.ready).toBe(false)
    expect(readinessRefusalMessage(r)).toContain('variables du mois')
  })

  it('une modification après validation invalide la ligne', () => {
    const r = computeRafReadiness({
      employees: [emp()],
      variables: [{ employee_id: 'e1', rule_code: 'PRIME_TRANSPORT', amount: '25000' }],
      validations: [{ employee_id: 'e1', mode: 'entered', variables_hash: variablesFingerprint({ PRIME_TRANSPORT: 20000 }), validated_at: null, validated_by: 'u' }],
      pack: CIV,
    })
    expect(r.employees[0]!.validation?.valid).toBe(false)
    expect(r.ready).toBe(false)
  })

  it('non prêt si un dossier est incomplet, même validé', () => {
    const r = computeRafReadiness({
      employees: [emp({ cnps_number: null })], variables: [],
      validations: [{ employee_id: 'e1', mode: 'none', variables_hash: hashNone, validated_at: null, validated_by: 'u' }],
      pack: CIV,
    })
    expect(r.employees[0]!.missing).toEqual(['cnps_number'])
    expect(r.ready).toBe(false)
    expect(readinessRefusalMessage(r)).toContain('dossier incomplet')
  })

  it('l\'empreinte ignore l\'ordre et les montants nuls', () => {
    expect(variablesFingerprint({ A: 1, B: 2 })).toBe(variablesFingerprint({ B: 2, A: 1, C: 0 }))
    expect(variablesFingerprint({ A: 1 })).not.toBe(variablesFingerprint({ A: 2 }))
  })
})

describe('absences injustifiées (jours) → retenue', () => {
  it('retire la clé des variables et ajoute la retenue au pointage', () => {
    const varEls: Record<string, number> = { ABSENCE_INJ: 2, PRIME_PANIER: 5000 }
    const days = takeUnjustifiedAbsenceDays(varEls)
    expect(days).toBe(2)
    expect(varEls).toEqual({ PRIME_PANIER: 5000 })
    const att = withUnjustifiedAbsence(undefined, days, 260_000, 26)
    expect(att).toEqual({ absenceDays: 2, absenceAmount: 20_000, lateMinutes: 0, latenessAmount: 0, suspendAttendanceBonus: false })
    const merged = withUnjustifiedAbsence({ absenceDays: 1, absenceAmount: 10_000, lateMinutes: 30, latenessAmount: 1_000, suspendAttendanceBonus: true }, 1, 260_000, 26)
    expect(merged).toEqual({ absenceDays: 2, absenceAmount: 20_000, lateMinutes: 30, latenessAmount: 1_000, suspendAttendanceBonus: true })
    expect(withUnjustifiedAbsence(undefined, 0, 260_000, 26)).toBeUndefined()
  })
})
