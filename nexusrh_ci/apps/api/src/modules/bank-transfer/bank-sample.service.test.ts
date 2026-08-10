/**
 * Import assisté : analyse du fichier exemple fourni par la banque.
 *
 * Le fichier sert à DEVINER la structure, jamais à générer. Ce qui n'est pas
 * reconnu doit rester explicitement « à mapper » — une devinette silencieuse
 * passerait le contrôle et ferait rejeter le fichier par la banque.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  MAX_SAMPLE_BYTES, MAX_SAMPLE_LINES, SampleRejectedError,
  suggestSourceForHeader, detectDelimiter, detectFixedColumns, analyzeSample,
} from './bank-sample.service.js'

/**
 * Deux enregistrements à positions fixes : type(2) · compte(28) · nom(24) ·
 * montant(12), séparés par une espace. Les champs sont pleins : une position
 * n'est un séparateur que si elle est vide sur TOUTES les lignes d'exemple.
 */
const FIXED_LINES = [
  ['02', 'CI93CI0080111301134291200589', 'KOUASSIAKISSIGNAMIENDIAB', '000000300000'].join(' '),
  ['02', 'CI11CI0080111301134291200111', 'DIARRAMOUSSAKONEBAMBAXYZ', '000000250000'].join(' '),
]

describe('suggestSourceForHeader', () => {
  it('reconnaît le compte du bénéficiaire sous ses variantes', () => {
    for (const h of ['IBAN', 'RIB', 'COMPTE_BENEF', 'N° de compte', 'NUM COMPTE', 'compte bénéficiaire']) {
      expect(suggestSourceForHeader(h)).toBe('employee.iban')
    }
  })

  it('reconnaît le montant', () => {
    for (const h of ['MONTANT', 'Montant (FCFA)', 'NET A PAYER', 'NET_PAYABLE', 'SOMME']) {
      expect(suggestSourceForHeader(h)).toBe('payslip.net_payable')
    }
  })

  it('reconnaît le bénéficiaire sans le confondre avec son compte', () => {
    expect(suggestSourceForHeader('NOM_BENEF')).toBe('employee.full_name')
    expect(suggestSourceForHeader('BENEFICIAIRE')).toBe('employee.full_name')
    expect(suggestSourceForHeader('COMPTE_BENEF')).toBe('employee.iban')
  })

  it('reconnaît matricule, NNI, banque, date et libellé', () => {
    expect(suggestSourceForHeader('MATRICULE')).toBe('employee.employee_number')
    expect(suggestSourceForHeader('NNI')).toBe('employee.nni')
    expect(suggestSourceForHeader('BANQUE')).toBe('employee.bank_name')
    expect(suggestSourceForHeader('DATE DE VALEUR')).toBe('computed.value_date')
    expect(suggestSourceForHeader('LIBELLE')).toBe('literal')
  })

  it('laisse « à mapper » ce qu\'il ne reconnaît pas — jamais de devinette', () => {
    expect(suggestSourceForHeader('ZONE_RESERVEE_BANQUE')).toBe('unmapped')
    expect(suggestSourceForHeader('')).toBe('unmapped')
    expect(suggestSourceForHeader('XYZ42')).toBe('unmapped')
  })
})

describe('detectDelimiter', () => {
  it('reconnaît le séparateur majoritaire', () => {
    expect(detectDelimiter('A;B;C\n1;2;3')).toBe(';')
    expect(detectDelimiter('A,B,C\n1,2,3')).toBe(',')
    expect(detectDelimiter('A\tB\tC\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('A|B|C\n1|2|3')).toBe('|')
  })

  it('retombe sur le point-virgule quand aucun séparateur ne ressort', () => {
    expect(detectDelimiter('UNECOLONNE\nVALEUR')).toBe(';')
  })
})

describe('detectFixedColumns', () => {
  it('déduit les largeurs à partir des colonnes constamment vides', () => {
    const cols = detectFixedColumns(FIXED_LINES)
    expect(cols.map(c => c.width)).toEqual([2, 28, 24, 12])
    expect(cols[0]!.start).toBe(0)
    expect(cols[1]!.start).toBe(3)
  })

  it('lit le remplissage commun à toutes les lignes comme un séparateur (limite assumée)', () => {
    // Si aucun exemple ne remplit le champ, sa fin est indistinguable d'un blanc
    // de séparation. L'admin recale la frontière dans l'éditeur ; la largeur
    // TOTALE de la ligne, elle, reste exacte (cf. segments de remplissage).
    const short = [
      ['02', 'CI93CI0080111301134291200589', 'KONE'.padEnd(24), '000000300000'].join(' '),
      ['02', 'CI11CI0080111301134291200111', 'DIARRA'.padEnd(24), '000000250000'].join(' '),
    ]
    expect(detectFixedColumns(short).map(c => c.width)).toEqual([2, 28, 6, 12])
  })

  it('retourne une seule colonne quand rien ne sépare les positions', () => {
    expect(detectFixedColumns(['ABCDEF', 'GHIJKL'])).toEqual([{ start: 0, width: 6 }])
  })

  it('ignore les lignes vides', () => {
    expect(detectFixedColumns(['AB CD', '', 'EF GH'])).toEqual([{ start: 0, width: 2 }, { start: 3, width: 2 }])
  })
})

describe('analyzeSample — fichier délimité', () => {
  const csv = 'COMPTE_BENEF;NOM_BENEF;MONTANT;ZONE_BANQUE\nCI93…;KOUAME AWA;300000;XX\n'

  it('propose une colonne par en-tête, pré-mappée', async () => {
    const res = await analyzeSample('modele_sgci.csv', Buffer.from(csv, 'utf8'))
    expect(res.output).toBe('csv')
    expect(res.delimiter).toBe(';')
    expect(res.columns.map(c => c.label)).toEqual(['COMPTE_BENEF', 'NOM_BENEF', 'MONTANT', 'ZONE_BANQUE'])
    expect(res.columns.map(c => c.source)).toEqual(['employee.iban', 'employee.full_name', 'payslip.net_payable', 'unmapped'])
  })

  it('signale les colonnes restées à mapper', async () => {
    const res = await analyzeSample('modele_sgci.csv', Buffer.from(csv, 'utf8'))
    expect(res.unmappedCount).toBe(1)
  })

  it('ne renvoie AUCUNE donnée de cellule — seulement la structure', async () => {
    const res = await analyzeSample('modele_sgci.csv', Buffer.from(csv, 'utf8'))
    expect(JSON.stringify(res)).not.toContain('KOUAME AWA')
    expect(JSON.stringify(res)).not.toContain('300000')
  })
})

describe('analyzeSample — encodage du fichier délimité', () => {
  const headers = 'Compte bénéficiaire;Bénéficiaire;Montant\n'

  it('reconnaît les intitulés accentués d\'un CSV UTF-8', async () => {
    const res = await analyzeSample('modele.csv', Buffer.from(headers, 'utf8'))
    expect(res.encoding).toBe('utf8')
    expect(res.columns.map(c => c.label)).toEqual(['Compte bénéficiaire', 'Bénéficiaire', 'Montant'])
    expect(res.columns.map(c => c.source)).toEqual(['employee.iban', 'employee.full_name', 'payslip.net_payable'])
  })

  it('reconnaît aussi les mêmes intitulés dans un CSV ISO-8859-1', async () => {
    const res = await analyzeSample('modele.csv', Buffer.from(headers, 'latin1'))
    expect(res.encoding).toBe('latin1')
    expect(res.columns.map(c => c.source)).toEqual(['employee.iban', 'employee.full_name', 'payslip.net_payable'])
  })

  it('retire le BOM pour ne pas polluer le premier intitulé', async () => {
    const res = await analyzeSample('modele.csv', Buffer.from(`﻿${headers}`, 'utf8'))
    expect(res.columns[0]!.label).toBe('Compte bénéficiaire')
  })
})

describe('analyzeSample — texte à format fixe', () => {
  const txt = FIXED_LINES.join('\r\n')

  it('déduit des colonnes à largeur fixe, toutes à mapper', async () => {
    const res = await analyzeSample('modele.txt', Buffer.from(txt, 'latin1'))
    expect(res.output).toBe('fixed')
    expect(res.columns.filter(c => c.source === 'unmapped').map(c => c.pad?.width)).toEqual([2, 28, 24, 12])
    expect(res.unmappedCount).toBe(4)
  })

  it('conserve les espaces de séparation comme remplissage — sinon les positions se décalent', async () => {
    const res = await analyzeSample('modele.txt', Buffer.from(txt, 'latin1'))
    expect(res.columns.map(c => c.pad?.width)).toEqual([2, 1, 28, 1, 24, 1, 12])
    const total = res.columns.reduce((s, c) => s + (c.pad?.width ?? 0), 0)
    expect(total).toBe(FIXED_LINES[0]!.length)
  })
})

describe('analyzeSample — classeur Excel', () => {
  async function xlsxBuffer(headers: string[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Modèle')
    ws.addRow(headers)
    ws.addRow(['CI93…', 'KOUAME AWA', 300000])
    return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
  }

  it('lit la ligne d\'en-tête et pré-mappe', async () => {
    const res = await analyzeSample('modele.xlsx', await xlsxBuffer(['IBAN', 'BENEFICIAIRE', 'MONTANT']))
    expect(res.output).toBe('xlsx')
    expect(res.columns.map(c => c.source)).toEqual(['employee.iban', 'employee.full_name', 'payslip.net_payable'])
  })

  it('ne renvoie aucune donnée de cellule', async () => {
    const res = await analyzeSample('modele.xlsx', await xlsxBuffer(['IBAN', 'BENEFICIAIRE', 'MONTANT']))
    expect(JSON.stringify(res)).not.toContain('KOUAME AWA')
  })
})

describe('analyzeSample — durcissement', () => {
  it('refuse une extension non autorisée', async () => {
    await expect(analyzeSample('charge.exe', Buffer.from('MZ'))).rejects.toBeInstanceOf(SampleRejectedError)
    await expect(analyzeSample('modele.xml', Buffer.from('<a/>'))).rejects.toBeInstanceOf(SampleRejectedError)
  })

  it('refuse un fichier au-delà de la taille maximale', async () => {
    const big = Buffer.alloc(MAX_SAMPLE_BYTES + 1, 0x41)
    await expect(analyzeSample('modele.csv', big)).rejects.toBeInstanceOf(SampleRejectedError)
  })

  it('refuse un fichier vide', async () => {
    await expect(analyzeSample('modele.csv', Buffer.alloc(0))).rejects.toBeInstanceOf(SampleRejectedError)
  })

  it('refuse un contenu qui n\'est pas un classeur malgré l\'extension .xlsx', async () => {
    await expect(analyzeSample('piege.xlsx', Buffer.from('pas une archive zip'))).rejects.toBeInstanceOf(SampleRejectedError)
  })

  it('borne le nombre de colonnes déduites', async () => {
    const headers = Array.from({ length: 500 }, (_, i) => `C${i}`).join(';')
    const res = await analyzeSample('large.csv', Buffer.from(`${headers}\n`, 'utf8'))
    expect(res.columns.length).toBeLessThanOrEqual(200)
    expect(res.truncated).toBe(true)
  })

  it('ne lit qu\'un nombre borné de lignes', async () => {
    const line = 'AB CD'
    const many = Array.from({ length: MAX_SAMPLE_LINES + 500 }, () => line).join('\n')
    const res = await analyzeSample('modele.txt', Buffer.from(many, 'utf8'))
    expect(res.linesRead).toBeLessThanOrEqual(MAX_SAMPLE_LINES)
  })
})
