/**
 * Lecture d'un classeur de reprise — ce qu'un client dépose vraiment.
 *
 * Le fichier qui arrive ici n'est pas fabriqué par nous : c'est notre modèle
 * CSV ouvert dans Excel puis « enregistré sous .xlsx ». Excel en profite pour
 * typer ce qu'il croit comprendre — une date devient un objet Date, un salaire
 * un nombre, un email un hyperlien — et laisse traîner des lignes vides sous
 * les données. Ce banc fige ce que le handler d'import doit recevoir malgré
 * tout : des CHAÎNES, alignées sur l'en-tête, comme s'il lisait un CSV.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  lireClasseurImport, WorkbookRejectedError,
  WORKBOOK_MAX_HEADERS, WORKBOOK_MAX_ROWS,
} from './import-workbook.service.js'

/** Fabrique un classeur à partir de lignes brutes, comme Excel le ferait. */
async function classeur(lignes: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Feuil1')
  for (const l of lignes) ws.addRow(l)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const ENTETE = ['prenom', 'nom', 'email', 'date_embauche', 'salaire_brut']

describe('Lecture d’un classeur de reprise', () => {
  it('rend l’en-tête et les lignes comme un CSV', async () => {
    const buf = await classeur([ENTETE, ['Kouamé', 'Konan', 'k.konan@sotra.ci', '2022-01-10', '450000']])
    const { headers, rows } = await lireClasseurImport(buf)
    expect(headers).toEqual(ENTETE)
    expect(rows).toEqual([['Kouamé', 'Konan', 'k.konan@sotra.ci', '2022-01-10', '450000']])
  })

  it('une DATE typée par Excel ressort en AAAA-MM-JJ', async () => {
    // Le piège central : Excel convertit « 2022-01-10 » en objet Date. Rendu
    // tel quel, le handler recevrait « Mon Jan 10 2022 … » et la date
    // d'embauche partirait à la poubelle silencieusement.
    const buf = await classeur([ENTETE, ['A', 'B', 'a@b.ci', new Date(Date.UTC(2022, 0, 10)), 450000]])
    const { rows } = await lireClasseurImport(buf)
    expect(rows[0]?.[3]).toBe('2022-01-10')
    expect(rows[0]?.[4]).toBe('450000')
  })

  it('un email transformé en HYPERLIEN rend l’adresse, pas un objet', async () => {
    const buf = await classeur([ENTETE,
      ['A', 'B', { text: 'a@b.ci', hyperlink: 'mailto:a@b.ci' }, '2022-01-10', '1'],
    ])
    const { rows } = await lireClasseurImport(buf)
    expect(rows[0]?.[2]).toBe('a@b.ci')
  })

  it('une FORMULE rend son résultat calculé', async () => {
    const buf = await classeur([ENTETE, ['A', 'B', 'a@b.ci', '2022-01-10', { formula: 'B1&""', result: 650000 }]])
    const { rows } = await lireClasseurImport(buf)
    expect(rows[0]?.[4]).toBe('650000')
  })

  it('une cellule vide au MILIEU ne décale pas les colonnes suivantes', async () => {
    // ExcelJS rend un tableau creux : sans densification, `.map()` saute le
    // trou et la ville se retrouverait dans le matricule.
    const buf = await classeur([ENTETE, ['A', 'B', null, '2022-01-10', '450000']])
    const { rows } = await lireClasseurImport(buf)
    expect(rows[0]).toEqual(['A', 'B', '', '2022-01-10', '450000'])
  })

  it('les lignes vides qu’Excel laisse sous les données sont ignorées', async () => {
    const buf = await classeur([ENTETE, ['A', 'B', 'a@b.ci', '2022-01-10', '1'], [], [null, null]])
    const { rows } = await lireClasseurImport(buf)
    expect(rows).toHaveLength(1)
  })

  it('une ligne plus COURTE que l’en-tête est complétée, pas tronquée', async () => {
    const buf = await classeur([ENTETE, ['A', 'B', 'a@b.ci']])
    const { rows } = await lireClasseurImport(buf)
    expect(rows[0]).toEqual(['A', 'B', 'a@b.ci', '', ''])
  })

  it('les colonnes sans intitulé en fin d’en-tête sont retirées', async () => {
    const buf = await classeur([[...ENTETE, '', ''], ['A', 'B', 'a@b.ci', '2022-01-10', '1']])
    const { headers } = await lireClasseurImport(buf)
    expect(headers).toEqual(ENTETE)
  })
})

describe('Refus explicites', () => {
  it('refuse un fichier qui n’est pas un ZIP (donc pas un .xlsx)', async () => {
    await expect(lireClasseurImport(Buffer.from('prenom;nom\nA;B\n', 'utf8')))
      .rejects.toBeInstanceOf(WorkbookRejectedError)
  })

  it('refuse un ZIP qui n’est pas un classeur', async () => {
    const faux = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
    await expect(lireClasseurImport(faux)).rejects.toBeInstanceOf(WorkbookRejectedError)
  })

  it('refuse un classeur vide, au lieu d’importer zéro ligne en silence', async () => {
    await expect(lireClasseurImport(await classeur([]))).rejects.toThrow(/vide/i)
  })

  it('refuse un classeur SANS ligne de données', async () => {
    await expect(lireClasseurImport(await classeur([ENTETE]))).rejects.toThrow(/aucune ligne/i)
  })

  it('refuse au-delà du plafond de colonnes, comme l’import CSV', async () => {
    const large = Array.from({ length: WORKBOOK_MAX_HEADERS + 1 }, (_, i) => `c${i}`)
    await expect(lireClasseurImport(await classeur([large, large])))
      .rejects.toThrow(new RegExp(String(WORKBOOK_MAX_HEADERS)))
  })

  it('les plafonds sont ceux de l’import CSV : un .xlsx n’ouvre pas de porte plus large', () => {
    expect(WORKBOOK_MAX_HEADERS).toBe(50)
    expect(WORKBOOK_MAX_ROWS).toBe(10_000)
  })
})
