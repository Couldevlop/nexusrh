/**
 * Régression terrain (11/08/2026) : un modèle Excel réel déposé en production
 * renvoyait « 400 Validation » à la création du profil, sans explication.
 *
 * Cause : les modèles bancaires commencent presque toujours par une LIGNE DE
 * TITRE, souvent dans une cellule fusionnée. ExcelJS restitue la même valeur
 * dans toutes les cellules de la fusion → l'analyseur fabriquait autant de
 * colonnes que la fusion en couvrait, toutes intitulées avec le titre entier
 * (149 caractères), et la route rejetait en bloc. Les vrais en-têtes, plus bas,
 * n'étaient jamais lus.
 *
 * Invariants couverts ici :
 *  - la ligne de titre est ignorée, les vrais en-têtes sont retenus ;
 *  - un intitulé trop long ne peut plus provoquer de rejet (troncature) ;
 *  - un 400 de validation porte un message ACTIONNABLE, jamais « Validation ».
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import ExcelJS from 'exceljs'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, connect: vi.fn(), end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../config.js', () => ({
  config: {
    env: 'test', jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' },
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: 'x <no@reply>' },
  },
}))
vi.mock('../../utils/schema-migrations.js', () => ({ ensureTenantSchema: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@nexusrhci/shared/crypto', () => ({
  decryptIfPresent: (v: string | null) => v, encryptIfPresent: (v: string | null) => v,
}))
vi.mock('../../services/email.js', () => ({ sendBankTransferEmail: vi.fn() }))

import authPlugin from '../../plugins/auth.js'
import bankTransferRoutes from './bank-transfer.routes.js'
import { analyzeSample } from './bank-sample.service.js'

const TITRE = "ORDRE DE VIREMENT DE SALAIRES — SOCIETE GENERALE COTE D'IVOIRE — COMPTE DONNEUR D'ORDRE CI93CI0080100000000000000001 — PERIODE DE PAIE MAI 2026"

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(bankTransferRoutes, { prefix: '/bank-transfer' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

const token = () => app.jwt.sign({ sub: 'u1', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin', email: 'a@b.ci', firstName: 'A', lastName: 'B', employeeId: null })

/** Classeur tel qu'une banque le fournit : titre fusionné, ligne vide, en-têtes. */
async function classeurAvecTitre(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Ordre de virement')
  ws.mergeCells('A1:F1')
  ws.getCell('A1').value = TITRE
  ws.addRow([])
  ws.addRow(['COMPTE_BENEF', 'NOM_BENEF', 'MONTANT', 'LIBELLE'])
  ws.addRow(['CI93…', 'KOUAME AWA', 300000, 'SALAIRE'])
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

describe('modèle Excel commençant par une ligne de titre', () => {
  it('ignore le titre fusionné et retient les vrais en-têtes', async () => {
    const a = await analyzeSample('modele_banque.xlsx', await classeurAvecTitre())
    expect(a.columns.map((c) => c.label)).toEqual(['COMPTE_BENEF', 'NOM_BENEF', 'MONTANT', 'LIBELLE'])
    expect(a.columns.map((c) => c.source)).toEqual([
      'employee.iban', 'employee.full_name', 'payslip.net_payable', 'literal',
    ])
  })

  it('crée le brouillon sans erreur (201) — c'.concat("'est la régression"), async () => {
    const a = await analyzeSample('modele_banque.xlsx', await classeurAvecTitre())
    const spec = {
      output: a.output, encoding: a.encoding, delimiter: a.delimiter ?? ';', lineEnding: 'crlf',
      filename: 'VIR_{banque}_{mois}.xlsx',
      header: { mode: 'labels', lines: [] }, columns: a.columns, footer: { enabled: false, lines: [] },
    }
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111', version: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/bank-transfer/templates',
      headers: { authorization: `Bearer ${token()}` },
      payload: { bank: 'SGCI', spec, sampleFilename: a.filename, label: `SGCI — ${a.filename}` },
    })
    expect(res.statusCode).toBe(201)
  })
})

describe('CSV commençant par une ligne de titre', () => {
  it('ignore le titre et retient la ligne d\'en-têtes', async () => {
    const csv = `Ordre de virement SGCI - mai 2026\r\n\r\nCOMPTE;NOM;MONTANT\r\nCI93;KOUAME;300000\r\n`
    const a = await analyzeSample('modele.csv', Buffer.from(csv, 'utf8'))
    expect(a.columns.map((c) => c.label)).toEqual(['COMPTE', 'NOM', 'MONTANT'])
  })
})

describe('intitulé démesuré', () => {
  it('est tronqué à l\'analyse plutôt que de faire échouer la création', async () => {
    const csv = `${'A'.repeat(300)};MONTANT\r\nx;1\r\n`
    const a = await analyzeSample('modele.csv', Buffer.from(csv, 'utf8'))
    expect(a.columns[0]!.label!.length).toBe(120)
  })
})

describe('message d\'erreur de validation', () => {
  it('nomme le problème au lieu de répondre « Validation »', async () => {
    const spec = {
      output: 'csv', encoding: 'utf8', delimiter: ';', lineEnding: 'crlf', filename: 'x.csv',
      header: { mode: 'labels', lines: [] },
      columns: [{ label: 'B'.repeat(300), source: 'employee.iban' }],
      footer: { enabled: false, lines: [] },
    }
    const res = await app.inject({
      method: 'POST', url: '/bank-transfer/templates',
      headers: { authorization: `Bearer ${token()}` }, payload: { bank: 'SGCI', spec },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).not.toBe('Validation')
    expect(body.error).toContain('intitulé')
    expect(body.error).toContain('120')
  })
})

describe('feuille ne démarrant pas en colonne A (modèle BNI réel)', () => {
  /**
   * Le modèle « DISQUETTE » de la BNI place ses en-têtes en B3 : la colonne A
   * et les deux premières lignes sont vides. ExcelJS renvoie alors un tableau
   * CREUX, et `.map()` saute les trous — la colonne A traversait tout le
   * traitement sans jamais devenir une chaîne, puis JSON.stringify la
   * sérialisait en `null`. Le serveur répondait 400 « Expected object,
   * received null », sans que rien ne soit visiblement anormal à l'écran.
   */
  async function classeurDemarrantEnB(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('BNI')
    const entetes = ['NUMERO CLIENT', 'NOM ET PRENOMS', 'COMPTE', 'CODE BANQUE', 'MONTANT', 'DATE', 'LIBELLE']
    entetes.forEach((h, i) => { ws.getCell(3, i + 2).value = h })   // colonne 2 = B, ligne 3
    ws.getCell(4, 3).value = 'TRAORE SIAKA'
    ws.getCell(4, 4).value = '009452932811'
    ws.getCell(4, 6).value = 1113959
    return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
  }

  it('ne produit aucune colonne nulle et rogne la colonne vide de gauche', async () => {
    const a = await analyzeSample('DISQUETTE EXEMPLE.XLSX', await classeurDemarrantEnB())
    // Le trou de la colonne A ressortait en null après sérialisation.
    expect(JSON.parse(JSON.stringify(a.columns)).some((c: unknown) => c === null)).toBe(false)
    expect(a.columns).toHaveLength(7)
    expect(a.columns[0]!.label).toBe('NUMERO CLIENT')
    // Le fichier éclate le RIB : « COMPTE » y désigne le NUMÉRO de compte, et
    // « CODE BANQUE » le code à 5 caractères, pas le libellé de la banque.
    expect(a.columns.map((c) => c.source)).toEqual([
      'unmapped', 'employee.full_name', 'employee.account_number', 'employee.bank_code',
      'payslip.net_payable', 'computed.value_date', 'literal',
    ])
  })

  it('crée le brouillon (201) au lieu de « Expected object, received null »', async () => {
    const a = await analyzeSample('DISQUETTE EXEMPLE.XLSX', await classeurDemarrantEnB())
    const spec = {
      output: a.output, encoding: a.encoding, delimiter: a.delimiter ?? ';', lineEnding: 'crlf',
      filename: 'VIR_{banque}_{mois}.xlsx',
      header: { mode: 'labels', lines: [] }, columns: a.columns, footer: { enabled: false, lines: [] },
    }
    queryMock
      .mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111', version: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'POST', url: '/bank-transfer/templates',
      headers: { authorization: `Bearer ${token()}` },
      payload: { bank: 'BNI', spec, sampleFilename: a.filename, label: `BNI — ${a.filename}` },
    })
    expect(res.statusCode).toBe(201)
    // Les deux colonnes non reconnues restent à mapper, comme attendu.
    expect(JSON.parse(res.body).data.issues).toContain('columns.unmapped[0]')
  })

  it('lit le texte enrichi et les formules sans produire « [object Object] »', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('F')
    ws.getCell('A1').value = { richText: [{ text: 'CODE ' }, { text: 'BANQUE' }] } as never
    ws.getCell('B1').value = { formula: 'CONCATENATE("MON","TANT")', result: 'MONTANT' } as never
    ws.getCell('A2').value = 'x'
    const a = await analyzeSample('f.xlsx', Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer))
    expect(a.columns.map((c) => c.label)).toEqual(['CODE BANQUE', 'MONTANT'])
  })
})
