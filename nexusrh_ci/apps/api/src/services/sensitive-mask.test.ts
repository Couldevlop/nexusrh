import { describe, it, expect } from 'vitest'
import { MASKED_CELL, csvCell, SENSITIVE_FIELDS, maskSensitive, maskFields, maskSensitiveRows, isMasked } from './sensitive-mask.js'
import type { HabContext } from './habilitation.service.js'

function ctx(sensitive: boolean): HabContext {
  return {
    userId: 'u', subgroupId: 's', kind: 'siege', legalEntityId: null,
    permissions: new Set<string>(), allEntities: true, sensitive,
    manageHabilitations: false, selfEmployeeId: null, headOfficeEntityIds: [],
  }
}

describe('SENSITIVE_FIELDS', () => {
  it('reste exactement la liste de la spec', () => {
    expect(SENSITIVE_FIELDS).toEqual(['base_salary', 'salary', 'nni', 'iban', 'rib', 'bank_account', 'mobile_money_phone', 'cnps_number'])
  })
})

describe('maskSensitive', () => {
  const row = { id: 'e1', first_name: 'Awa', base_salary: '450000', cnps_number: 'CI123', nni: 'enc', iban: 'enc', mobile_money_phone: '0707' }

  it('contexte sans sensitive : valeurs à null, clés conservées', () => {
    const out = maskSensitive(row, ctx(false))
    expect(out.base_salary).toBeNull()
    expect(out.cnps_number).toBeNull()
    expect(out.nni).toBeNull()
    expect(out.iban).toBeNull()
    expect(out.mobile_money_phone).toBeNull()
    expect(Object.keys(out)).toEqual([...Object.keys(row), 'maskedFields'])
    expect(out.maskedFields).toEqual(['base_salary', 'cnps_number', 'nni', 'iban', 'mobile_money_phone'])
    expect(out.first_name).toBe('Awa')
  })

  it('contexte null ou sensitive : valeur intacte', () => {
    expect(maskSensitive(row, null)).toEqual(row)
    expect(maskSensitive(row, ctx(true))).toEqual(row)
    expect('maskedFields' in maskSensitive(row, null)).toBe(false)
  })

  it('ne crée aucune clé absente', () => {
    expect(maskSensitive({ id: 'x' }, ctx(false))).toEqual({ id: 'x' })
  })

  it('valeur déjà vide : rien de caché, pas de maskedFields', () => {
    expect(maskSensitive({ id: 'x', base_salary: null }, ctx(false))).toEqual({ id: 'x', base_salary: null })
  })

  it('gère les formes camelCase et dérivées', () => {
    const out = maskSensitive(
      { baseSalary: 1, cnpsNumber: 'a', mobileMoneyPhone: 'b', bankAccount: 'c', iban_masked: '•••• 1', employee_cnps: 'z', mobile_money_number: 'm', expectedSalary: 9, expected_salary: 9 },
      ctx(false),
    )
    expect(Object.values(out).filter((v) => !Array.isArray(v)).every((v) => v === null)).toBe(true)
    expect(out.maskedFields).toContain('baseSalary')
    expect(out.maskedFields).toContain('iban_masked')
  })

  it('ne modifie pas la ligne source', () => {
    maskSensitive(row, ctx(false))
    expect(row.base_salary).toBe('450000')
  })

  it('une ligne d\'export CSV pour une chargée de recrutement a la colonne salaire vide', () => {
    expect(csvCell(450000, ctx(false))).toBe(MASKED_CELL)
    expect(MASKED_CELL).toBe('Réservé')
    expect(csvCell(450000, null)).toBe(450000)
    expect(csvCell(450000, ctx(true))).toBe(450000)
  })
})

describe('maskFields / maskSensitiveRows / isMasked', () => {
  it('maskFields masque des clés explicites (agrégats)', () => {
    expect(maskFields({ department: 'IT', avg_salary: 5 }, ['avg_salary'], ctx(false))).toEqual({ department: 'IT', avg_salary: null, maskedFields: ['avg_salary'] })
    expect(maskFields({ department: 'IT', avg_salary: 5 }, ['avg_salary'], null)).toEqual({ department: 'IT', avg_salary: 5 })
  })
  it('maskSensitiveRows applique à chaque ligne', () => {
    expect(maskSensitiveRows([{ salary: 1 }, { salary: 2 }], ctx(false))).toEqual([{ salary: null, maskedFields: ['salary'] }, { salary: null, maskedFields: ['salary'] }])
  })
  it('isMasked', () => {
    expect(isMasked(null)).toBe(false)
    expect(isMasked(ctx(true))).toBe(false)
    expect(isMasked(ctx(false))).toBe(true)
  })
})
