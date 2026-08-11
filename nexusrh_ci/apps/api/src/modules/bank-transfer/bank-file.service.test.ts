/**
 * Moteur de génération des fichiers de virement paramétrables — logique PURE.
 *
 * Couvre : rendu des 3 formats (xlsx/csv/fixe), catalogue de sources fermé,
 * transformations, padding/troncature, montants FCFA entiers, encodage Latin-1,
 * neutralisation des injections de formule, et durcissement du nom de fichier.
 */
import { describe, it, expect } from 'vitest'
import {
  SOURCE_CATALOG, OUTPUT_KINDS, STARTER_PRESETS,
  renderSegment, buildBankFile, buildBankFileAsync, resolveFilename, specIssues, isSourceKey, previewTable, decomposeRib,
  type BankFileSpec, type BankFileRow, type BankFileContext, type BankFileSegment,
} from './bank-file.service.js'

const row: BankFileRow = {
  lastName: 'Kouamé', firstName: 'Awa', fullName: 'KOUAMÉ Awa',
  employeeNumber: 'EMP-0042', nni: 'CI1234567890', iban: 'CI93CI0080111301134291200589',
  bankName: 'SGCI', department: 'Finance', jobTitle: 'Comptable',
  netPayable: 300_000, grossSalary: 425_000,
}

const ctx: BankFileContext = {
  bank: 'SGCI', month: '2026-07', tenantName: 'SOTRA',
  orderingAccount: 'CI93CI0080100000000000000001', orderingLabel: 'SALAIRES',
  valueDate: '2026-07-28', totalAmount: 300_000, rowCount: 1,
}

const seg = (s: Partial<BankFileSegment> & { source: string }): BankFileSegment => ({ ...s } as BankFileSegment)

function baseSpec(over: Partial<BankFileSpec> = {}): BankFileSpec {
  return {
    output: 'csv', encoding: 'utf8', delimiter: ';', lineEnding: 'crlf',
    filename: 'VIR_{banque}_{mois}.csv',
    header: { mode: 'labels', lines: [] },
    columns: [
      seg({ label: 'COMPTE', source: 'employee.iban' }),
      seg({ label: 'NOM', source: 'employee.full_name', transform: ['upper'] }),
      seg({ label: 'MONTANT', source: 'payslip.net_payable' }),
    ],
    footer: { enabled: false, lines: [] },
    ...over,
  }
}

describe('catalogue de sources', () => {
  it('est fermé — une source inconnue est refusée', () => {
    expect(isSourceKey('employee.iban')).toBe(true)
    expect(isSourceKey('employee.salaire_du_voisin')).toBe(false)
    expect(isSourceKey('process.env.ENCRYPTION_KEY')).toBe(false)
  })

  it('expose chaque source avec son groupe et son libellé', () => {
    for (const entry of SOURCE_CATALOG) {
      expect(isSourceKey(entry.value)).toBe(true)
      expect(entry.group.length).toBeGreaterThan(0)
      expect(entry.label.length).toBeGreaterThan(0)
    }
  })
})

describe('renderSegment', () => {
  it('lit les données du salarié et de la paie', () => {
    expect(renderSegment(seg({ source: 'employee.iban' }), row, ctx, 0)).toBe(row.iban)
    expect(renderSegment(seg({ source: 'payslip.net_payable' }), row, ctx, 0)).toBe('300000')
    expect(renderSegment(seg({ source: 'payslip.month' }), row, ctx, 0)).toBe('2026-07')
  })

  it('rend les valeurs calculées (n° de ligne à partir de 1, total, date de valeur)', () => {
    expect(renderSegment(seg({ source: 'computed.row_index' }), row, ctx, 0)).toBe('1')
    expect(renderSegment(seg({ source: 'computed.row_count' }), row, ctx, 0)).toBe('1')
    expect(renderSegment(seg({ source: 'computed.total_amount' }), row, ctx, 0)).toBe('300000')
    expect(renderSegment(seg({ source: 'computed.value_date', dateFormat: 'DDMMYYYY' }), row, ctx, 0)).toBe('28072026')
    expect(renderSegment(seg({ source: 'computed.value_date', dateFormat: 'DD/MM/YYYY' }), row, ctx, 0)).toBe('28/07/2026')
    expect(renderSegment(seg({ source: 'computed.value_date', dateFormat: 'YYYYMMDD' }), row, ctx, 0)).toBe('20260728')
  })

  it('substitue les jetons d\'un texte fixe', () => {
    expect(renderSegment(seg({ source: 'literal', literal: 'SALAIRE {mois} {banque}' }), row, ctx, 0))
      .toBe('SALAIRE 2026-07 SGCI')
    expect(renderSegment(seg({ source: 'literal', literal: '{annee}/{tenant}' }), row, ctx, 0))
      .toBe('2026/SOTRA')
  })

  it('applique les transformations dans l\'ordre déclaré', () => {
    expect(renderSegment(seg({ source: 'employee.full_name', transform: ['upper'] }), row, ctx, 0)).toBe('KOUAMÉ AWA')
    expect(renderSegment(seg({ source: 'employee.full_name', transform: ['stripAccents', 'upper'] }), row, ctx, 0)).toBe('KOUAME AWA')
    expect(renderSegment(seg({ source: 'employee.iban', transform: ['digitsOnly'] }), row, ctx, 0)).toBe('930080111301134291200589')
    expect(renderSegment(seg({ source: 'employee.full_name', transform: ['alnum'] }), row, ctx, 0)).toBe('KOUAMÉAwa')
  })

  it('tronque puis complète à la largeur demandée', () => {
    expect(renderSegment(seg({ source: 'employee.full_name', truncate: 6 }), row, ctx, 0)).toBe('KOUAMÉ')
    expect(renderSegment(seg({ source: 'employee.employee_number', pad: { width: 12, align: 'left', char: ' ' } }), row, ctx, 0))
      .toBe('EMP-0042    ')
    expect(renderSegment(seg({ source: 'payslip.net_payable', pad: { width: 10, align: 'right', char: '0' } }), row, ctx, 0))
      .toBe('0000300000')
  })

  it('force la largeur exacte en format fixe même si la valeur déborde', () => {
    const out = renderSegment(seg({ source: 'employee.full_name', pad: { width: 4, align: 'left', char: ' ' } }), row, ctx, 0)
    expect(out).toHaveLength(4)
    expect(out).toBe('KOUA')
  })

  it('applique l\'échelle de montant (centimes) sans jamais produire de décimale', () => {
    expect(renderSegment(seg({ source: 'payslip.net_payable', amountScale: 100 }), row, ctx, 0)).toBe('30000000')
    expect(renderSegment(seg({ source: 'payslip.net_payable', amountScale: 1 }), row, ctx, 0)).toBe('300000')
  })

  it('rend une chaîne vide pour une source non mappée plutôt que "undefined"', () => {
    expect(renderSegment(seg({ source: 'unmapped' }), row, ctx, 0)).toBe('')
    expect(renderSegment(seg({ source: 'orderer.account' }), row, { ...ctx, orderingAccount: null }, 0)).toBe('')
  })
})

describe('buildBankFile — CSV', () => {
  it('produit l\'en-tête de libellés puis une ligne par virement', () => {
    const { buffer, mime } = buildBankFile(baseSpec(), [row], ctx)
    const text = buffer.toString('utf8')
    expect(mime).toBe('text/csv')
    expect(text.split('\r\n')[0]).toBe('COMPTE;NOM;MONTANT')
    expect(text.split('\r\n')[1]).toBe(`${row.iban};KOUAMÉ AWA;300000`)
  })

  it('omet l\'en-tête quand le mode est "none"', () => {
    const { buffer } = buildBankFile(baseSpec({ header: { mode: 'none', lines: [] } }), [row], ctx)
    expect(buffer.toString('utf8').split('\r\n')[0]).toBe(`${row.iban};KOUAMÉ AWA;300000`)
  })

  it('neutralise une injection de formule dans une donnée', () => {
    const hostile: BankFileRow = { ...row, fullName: '=cmd|\'/c calc\'!A1' }
    const { buffer } = buildBankFile(baseSpec(), [hostile], ctx)
    expect(buffer.toString('utf8')).toContain(";'=CMD")
  })

  it('échappe le séparateur et les guillemets présents dans une valeur', () => {
    const { buffer } = buildBankFile(baseSpec(), [{ ...row, fullName: 'DIA; "AKA"' }], ctx)
    expect(buffer.toString('utf8')).toContain('"DIA; ""AKA"""')
  })

  it('encode en Latin-1 quand la banque l\'exige', () => {
    const { buffer } = buildBankFile(baseSpec({ encoding: 'latin1' }), [row], ctx)
    expect(buffer.toString('latin1')).toContain('KOUAMÉ AWA')
    expect(buffer.includes(Buffer.from([0xc3, 0x89]))).toBe(false) // pas d'UTF-8 « É »
  })

  it('respecte le saut de ligne demandé', () => {
    const { buffer } = buildBankFile(baseSpec({ lineEnding: 'lf' }), [row], ctx)
    expect(buffer.toString('utf8')).not.toContain('\r\n')
    expect(buffer.toString('utf8')).toContain('\n')
  })

  it('ajoute la ligne totalisatrice quand le pied est activé', () => {
    const spec = baseSpec({
      footer: { enabled: true, lines: [[
        seg({ source: 'literal', literal: 'TOTAL' }),
        seg({ source: 'computed.row_count' }),
        seg({ source: 'computed.total_amount' }),
      ]] },
    })
    const { buffer } = buildBankFile(spec, [row], ctx)
    const lines = buffer.toString('utf8').split('\r\n')
    expect(lines[lines.length - 1]).toBe('TOTAL;1;300000')
  })
})

describe('buildBankFile — texte à format fixe', () => {
  const fixedSpec = baseSpec({
    output: 'fixed', filename: 'VIR_{banque}_{mois}.txt',
    header: { mode: 'custom', lines: [[
      seg({ source: 'literal', literal: '01', pad: { width: 2, align: 'left', char: ' ' } }),
      seg({ source: 'orderer.account', pad: { width: 28, align: 'left', char: ' ' } }),
      seg({ source: 'computed.value_date', dateFormat: 'DDMMYYYY', pad: { width: 8, align: 'left', char: ' ' } }),
    ]] },
    columns: [
      seg({ source: 'literal', literal: '02', pad: { width: 2, align: 'left', char: ' ' } }),
      seg({ source: 'employee.iban', pad: { width: 28, align: 'left', char: ' ' } }),
      seg({ source: 'employee.full_name', transform: ['stripAccents', 'upper'], pad: { width: 24, align: 'left', char: ' ' } }),
      seg({ source: 'payslip.net_payable', pad: { width: 12, align: 'right', char: '0' } }),
    ],
  })

  it('concatène les colonnes sans séparateur, à largeur garantie', () => {
    const { buffer, mime } = buildBankFile(fixedSpec, [row], ctx)
    expect(mime).toBe('text/plain')
    const lines = buffer.toString('utf8').split('\r\n')
    expect(lines[0]).toHaveLength(2 + 28 + 8)
    expect(lines[1]).toHaveLength(2 + 28 + 24 + 12)
    expect(lines[1]!.slice(0, 2)).toBe('02')
    expect(lines[1]!.slice(2, 30)).toBe(row.iban.padEnd(28, ' '))
    expect(lines[1]!.slice(30, 54)).toBe('KOUAME AWA'.padEnd(24, ' '))
    expect(lines[1]!.slice(54)).toBe('000000300000')
  })

  it('neutralise une formule SANS décaler les positions (pas d\'apostrophe ajoutée)', () => {
    const { buffer } = buildBankFile(fixedSpec, [{ ...row, fullName: '=SOMME(A1)' }], ctx)
    const line = buffer.toString('utf8').split('\r\n')[1]!
    expect(line).toHaveLength(2 + 28 + 24 + 12)          // largeur intacte
    expect(line.slice(30, 54)).toBe(' SOMME(A1)'.padEnd(24, ' ')) // amorce remplacée par une espace
    expect(line).not.toContain("'")                       // l'apostrophe décalerait tout
  })

  it('laisse passer un « - » en tête, qui préfixe légitimement un montant signé', () => {
    const { buffer } = buildBankFile(fixedSpec, [{ ...row, fullName: '-DIALLO' }], ctx)
    expect(buffer.toString('utf8').split('\r\n')[1]!.slice(30, 54)).toBe('-DIALLO'.padEnd(24, ' '))
  })

  it('donne 1 comme n° de ligne au premier virement et incrémente ensuite', () => {
    const spec = baseSpec({
      output: 'fixed', header: { mode: 'none', lines: [] },
      columns: [seg({ source: 'computed.row_index', pad: { width: 3, align: 'right', char: '0' } })],
    })
    const { buffer } = buildBankFile(spec, [row, row], { ...ctx, rowCount: 2 })
    expect(buffer.toString('utf8').split('\r\n')).toEqual(['001', '002'])
  })
})

describe('buildBankFile — XLSX', () => {
  it('produit un classeur non vide au bon type MIME', async () => {
    const { buffer, mime } = await buildBankFileAsync(baseSpec({ output: 'xlsx', filename: 'VIR_{banque}_{mois}.xlsx' }), [row], ctx)
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(buffer.byteLength).toBeGreaterThan(0)
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK') // archive ZIP
  })

  it('refuse le rendu synchrone pour un classeur (ExcelJS est asynchrone)', () => {
    expect(() => buildBankFile(baseSpec({ output: 'xlsx' }), [row], ctx)).toThrow()
  })
})

describe('previewTable', () => {
  it('rend l\'en-tête, les lignes et le pied sans encodage CSV', () => {
    const spec = baseSpec({
      footer: { enabled: true, lines: [[
        seg({ source: 'literal', literal: 'TOTAL' }),
        seg({ source: 'literal', literal: '-' }),
        seg({ source: 'computed.total_amount' }),
      ]] },
    })
    expect(previewTable(spec, [row], ctx)).toEqual([
      ['COMPTE', 'NOM', 'MONTANT'],
      [row.iban, 'KOUAMÉ AWA', '300000'],
      ['TOTAL', '-', '300000'],
    ])
  })

  it('rend aussi un profil xlsx, qui ne peut pas s\'afficher comme du texte', () => {
    const table = previewTable(baseSpec({ output: 'xlsx' }), [row], ctx)
    expect(table).toHaveLength(2)
    expect(table[1]).toEqual([row.iban, 'KOUAMÉ AWA', '300000'])
  })
})

describe('resolveFilename — durcissement', () => {
  it('substitue les jetons', () => {
    expect(resolveFilename('VIR_{banque}_{mois}.csv', 'csv', ctx)).toBe('VIR_SGCI_2026-07.csv')
  })

  it('neutralise une traversée de chemin', () => {
    const name = resolveFilename('../../../etc/passwd', 'csv', ctx)
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
  })

  it('neutralise une injection d\'en-tête Content-Disposition', () => {
    const name = resolveFilename('a"; filename="b.exe\r\nX: y', 'csv', ctx)
    expect(name).not.toMatch(/["\r\n;]/)
  })

  it('impose l\'extension correspondant au format de sortie', () => {
    expect(resolveFilename('ordre', 'fixed', ctx)).toBe('ordre.txt')
    expect(resolveFilename('ordre.csv', 'xlsx', ctx)).toBe('ordre.xlsx')
  })

  it('retombe sur un nom par défaut si le gabarit ne laisse rien d\'exploitable', () => {
    expect(resolveFilename('///', 'csv', ctx)).toBe('virements_SGCI_2026-07.csv')
    expect(resolveFilename('', 'csv', ctx)).toBe('virements_SGCI_2026-07.csv')
  })

  it('borne la longueur du nom', () => {
    expect(resolveFilename('a'.repeat(500), 'csv', ctx).length).toBeLessThanOrEqual(120)
  })
})

describe('specIssues — contrôle avant activation', () => {
  it('ne signale rien sur un profil complet', () => {
    expect(specIssues(baseSpec())).toEqual([])
  })

  it('refuse un profil sans colonne', () => {
    expect(specIssues(baseSpec({ columns: [] }))).toContain('columns.empty')
  })

  it('refuse une colonne restée « à mapper »', () => {
    const issues = specIssues(baseSpec({ columns: [seg({ label: 'REF', source: 'unmapped' })] }))
    expect(issues.some(i => i.startsWith('columns.unmapped'))).toBe(true)
  })

  it('exige une largeur sur chaque colonne d\'un format fixe', () => {
    const issues = specIssues(baseSpec({ output: 'fixed' }))
    expect(issues.some(i => i.startsWith('columns.missingWidth'))).toBe(true)
  })

  it('refuse un texte fixe vide', () => {
    expect(specIssues(baseSpec({ columns: [seg({ source: 'literal' })] })).some(i => i.startsWith('columns.emptyLiteral'))).toBe(true)
  })

  it('refuse un profil hors bornes (colonnes, largeur cumulée)', () => {
    const many = Array.from({ length: 201 }, () => seg({ source: 'employee.iban' }))
    expect(specIssues(baseSpec({ columns: many }))).toContain('columns.tooMany')
    const wide = [seg({ source: 'employee.iban', pad: { width: 4001, align: 'left', char: ' ' } })]
    expect(specIssues(baseSpec({ output: 'fixed', columns: wide }))).toContain('columns.tooWide')
  })
})

describe('modèles de départ', () => {
  it('en fournit un par format de sortie, tous activables tels quels', async () => {
    const kinds = new Set(STARTER_PRESETS.map(p => p.spec.output))
    for (const kind of OUTPUT_KINDS) expect(kinds.has(kind)).toBe(true)
    for (const preset of STARTER_PRESETS) {
      expect(specIssues(preset.spec)).toEqual([])
      const built = await buildBankFileAsync(preset.spec, [row], ctx)
      expect(built.buffer.byteLength).toBeGreaterThan(0)
    }
  })
})

describe('découpe du RIB ivoirien', () => {
  // Structure vérifiée sur un ordre de virement BNI réel : le « CI008 » de la
  // colonne CODE BANQUE correspond aux 5 premiers caractères du BBAN.
  it('sépare code banque, code guichet, numéro de compte et clé', () => {
    expect(decomposeRib('CI93CI0080109400945293281189')).toEqual({
      bankCode: 'CI008', branchCode: '01094', accountNumber: '009452932811', key: '89',
    })
  })

  it('tolère espaces, minuscules et absence du préfixe pays', () => {
    expect(decomposeRib('ci93 CI008 01094 009452932811 89').bankCode).toBe('CI008')
    expect(decomposeRib('CI00801094009452932811' + '89').branchCode).toBe('01094')
  })

  it('renvoie du VIDE sur un RIB de longueur inattendue — jamais une découpe arbitraire', () => {
    // Un compte tronqué enverrait l'argent au mauvais endroit ; une colonne
    // vide se voit immédiatement dans l'aperçu.
    for (const mauvais of ['', 'CI93CI008', 'nimportequoi', 'CI93CI00801094009452932811890000']) {
      expect(decomposeRib(mauvais)).toEqual({ bankCode: '', branchCode: '', accountNumber: '', key: '' })
    }
  })

  it('alimente les quatre sources du catalogue', () => {
    const r = { ...row, iban: 'CI93CI0080109400945293281189' }
    const s2 = (source: string) => renderSegment(seg({ source }), r, ctx, 0)
    expect(s2('employee.bank_code')).toBe('CI008')
    expect(s2('employee.branch_code')).toBe('01094')
    expect(s2('employee.account_number')).toBe('009452932811')
    expect(s2('employee.rib_key')).toBe('89')
    expect(s2('employee.iban')).toBe('CI93CI0080109400945293281189')
  })
})
