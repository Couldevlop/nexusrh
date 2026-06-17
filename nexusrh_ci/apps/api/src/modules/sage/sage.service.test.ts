import { describe, it, expect } from 'vitest'
import {
  EXPORT_KINDS, isValidExportKind, SEPARATORS, resolveSeparator, SAGE_COLUMNS,
  sanitizeCsvField, encodeField, buildSageCsv, exportFilename,
} from './sage.service.js'

describe('sage.service — validations', () => {
  it('types d\'export bornés', () => {
    expect(EXPORT_KINDS).toEqual(['employees', 'variable_elements', 'payroll'])
    expect(isValidExportKind('payroll')).toBe(true)
    expect(isValidExportKind('secret')).toBe(false)
  })
  it('séparateur : point-virgule par défaut', () => {
    expect(SEPARATORS.semicolon).toBe(';')
    expect(resolveSeparator('comma')).toBe(',')
    expect(resolveSeparator('tab')).toBe('\t')
    expect(resolveSeparator(undefined)).toBe(';')
    expect(resolveSeparator('inconnu')).toBe(';')
  })
  it('colonnes définies pour chaque type', () => {
    expect(SAGE_COLUMNS.employees[0]).toEqual({ header: 'Matricule', field: 'matricule' })
    expect(SAGE_COLUMNS.payroll.some((c) => c.field === 'net_payable')).toBe(true)
    expect(SAGE_COLUMNS.variable_elements.map((c) => c.field)).toContain('amount')
  })
})

describe('sage.service — sécurité CSV (injection de formule)', () => {
  it('préfixe les champs débutant par = + - @ (et tab/CR)', () => {
    expect(sanitizeCsvField('=1+1')).toBe("'=1+1")
    expect(sanitizeCsvField('+33600')).toBe("'+33600")
    expect(sanitizeCsvField('-2')).toBe("'-2")
    expect(sanitizeCsvField('@cmd')).toBe("'@cmd")
    expect(sanitizeCsvField('Kouassi')).toBe('Kouassi')
    expect(sanitizeCsvField(null)).toBe('')
    expect(sanitizeCsvField(150000)).toBe('150000')
  })
  it('quote les champs contenant le séparateur ou des guillemets', () => {
    expect(encodeField('Yao;Jean', ';')).toBe('"Yao;Jean"')
    expect(encodeField('Say "hi"', ';')).toBe('"Say ""hi"""')
    expect(encodeField('simple', ';')).toBe('simple')
  })
})

describe('sage.service — construction du fichier', () => {
  const cols = [{ header: 'Matricule', field: 'matricule' }, { header: 'Montant', field: 'amount' }]
  it('en-tête + lignes, séparées par CRLF', () => {
    const csv = buildSageCsv(cols, [{ matricule: 'M001', amount: 150000 }, { matricule: 'M002', amount: 200000 }], { separator: ';' })
    expect(csv).toBe('Matricule;Montant\r\nM001;150000\r\nM002;200000')
  })
  it('sans en-tête si demandé', () => {
    const csv = buildSageCsv(cols, [{ matricule: 'M001', amount: 1 }], { includeHeader: false })
    expect(csv).toBe('M001;1')
  })
  it('champ manquant → vide ; injection neutralisée dans les données', () => {
    const csv = buildSageCsv(cols, [{ matricule: '=DANGER', amount: undefined }], { separator: ';' })
    expect(csv).toBe("Matricule;Montant\r\n'=DANGER;")
  })
  it('nom de fichier normalisé', () => {
    expect(exportFilename('employees')).toBe('sage_employees.csv')
    expect(exportFilename('payroll', '2024-12')).toBe('sage_payroll_2024-12.csv')
  })
})
