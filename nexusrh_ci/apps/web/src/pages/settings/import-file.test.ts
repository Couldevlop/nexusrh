/**
 * Lecture du fichier de reprise — les deux chemins doivent être indiscernables.
 *
 * Le client télécharge un modèle CSV, l'ouvre dans Excel, le remplit et
 * l'enregistre en .xlsx : c'est le geste naturel, et l'application le refusait.
 * Ce banc fige le contrat : quel que soit le format déposé, l'appelant reçoit
 * la même structure, et un classeur illisible dit POURQUOI au lieu d'échouer
 * en silence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseCSV, lireFichierImport, extensionAcceptee, estClasseur,
  ImportFileError, IMPORT_ACCEPT_ATTR,
} from './import-file'

const post = vi.fn()
vi.mock('@/lib/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }))

/**
 * Un vrai File : il doit être un Blob, sinon `FormData.append` le refuse —
 * ce que ce banc a d'ailleurs attrapé avant la production.
 * `text()` est posé à la main, jsdom ne l'implémentant pas partout.
 */
function fichier(nom: string, contenu = ''): File {
  const f = new File([contenu], nom)
  Object.defineProperty(f, 'text', { value: async () => contenu })
  return f
}

const TABLE = { headers: ['prenom', 'nom'], rows: [['Kouamé', 'Konan']] }

beforeEach(() => post.mockReset())

describe('Formats acceptés', () => {
  it('le .xlsx est accepté au même titre que le .csv', () => {
    expect(extensionAcceptee('reprise.xlsx')).toBe(true)
    expect(extensionAcceptee('reprise.csv')).toBe(true)
    expect(IMPORT_ACCEPT_ATTR).toContain('.xlsx')
  })

  it('refuse les formats qui ne sont ni CSV ni classeur', () => {
    // .xls (ancien format binaire) n'est PAS .xlsx : l'accepter ferait échouer
    // la lecture côté serveur avec un message obscur.
    expect(extensionAcceptee('reprise.xls')).toBe(false)
    expect(extensionAcceptee('reprise.pdf')).toBe(false)
    expect(extensionAcceptee('reprise.txt')).toBe(false)
  })

  it('l’extension est reconnue quelle que soit la casse', () => {
    expect(estClasseur('REPRISE.XLSX')).toBe(true)
    expect(extensionAcceptee('Reprise.CSV')).toBe(true)
  })
})

describe('Lecture d’un CSV', () => {
  it('se lit dans le navigateur, sans appeler le serveur', async () => {
    const t = await lireFichierImport(fichier('r.csv', 'prenom;nom\r\nKouamé;Konan\r\n'))
    expect(t).toEqual(TABLE)
    expect(post).not.toHaveBeenCalled()
  })

  it('le BOM des modèles n’est pas pris pour une partie du premier intitulé', () => {
    // Sans cela, la colonne s'appelle « ﻿prenom » et ne correspond à rien.
    expect(parseCSV('﻿prenom;nom\nA;B').headers[0]).toBe('prenom')
  })

  it('accepte la virgule quand le fichier n’utilise pas le point-virgule', () => {
    expect(parseCSV('prenom,nom\nA,B').headers).toEqual(['prenom', 'nom'])
  })
})

describe('Lecture d’un classeur', () => {
  it('est confiée au serveur, en multipart', async () => {
    post.mockResolvedValueOnce({ data: { data: TABLE } })
    const t = await lireFichierImport(fichier('r.xlsx'))
    expect(t).toEqual(TABLE)
    const [url, corps] = post.mock.calls[0]!
    expect(url).toBe('/settings/import/parse')
    // FormData et non JSON : les octets du classeur ne passent pas en base64.
    expect(corps).toBeInstanceOf(FormData)
    expect((corps as FormData).get('file')).toBeTruthy()
  })

  it('pose l’en-tête multipart, sans quoi axios sérialise le FormData en JSON', async () => {
    // Constaté en production : l'instance axios pose 'application/json' par
    // défaut, axios v1 sérialise alors le FormData, et @fastify/multipart
    // répond 406 « the request is not multipart ». Le fichier n'arrive jamais.
    post.mockResolvedValueOnce({ data: { data: TABLE } })
    await lireFichierImport(fichier('r.xlsx'))
    const [, , options] = post.mock.calls[0]!
    expect((options as { headers?: Record<string, string> })?.headers?.['Content-Type'])
      .toBe('multipart/form-data')
  })

  it('reprend TEL QUEL le motif de refus du serveur', async () => {
    // « Trop de colonnes (max 50) » est actionnable ; « échec » ne l'est pas.
    post.mockRejectedValueOnce({ response: { data: { error: 'Trop de colonnes (max 50).' } } })
    await expect(lireFichierImport(fichier('r.xlsx')))
      .rejects.toThrow('Trop de colonnes (max 50).')
  })

  it('une panne sans message reste une erreur explicite, pas un silence', async () => {
    post.mockRejectedValueOnce(new Error('network'))
    await expect(lireFichierImport(fichier('r.xlsx'))).rejects.toBeInstanceOf(ImportFileError)
  })
})
