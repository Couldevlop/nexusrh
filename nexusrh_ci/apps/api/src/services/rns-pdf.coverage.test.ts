/**
 * Tests de couverture ciblée — rns-pdf.
 *
 * Le template CNPS réel (rns-template.pdf) n'expose AUCUN champ AcroForm : la
 * voie « remplissage de formulaire » (lignes 243-248) et le catch de
 * `listRnsFields` (ligne 336) ne sont jamais exercés par les golden, qui
 * empruntent toujours le fallback overlay déclaratif.
 *
 * Ici on MOCKE `pdf-lib` pour simuler :
 *   - un template AcroForm avec champs textuels nommés (pour couvrir la boucle
 *     de remplissage : match par nom exact, par minuscule, champ non-textuel,
 *     champ inconnu, puis flatten + acroFilled = matched > 0) ;
 *   - un template dont `getForm()` lève (pour couvrir le catch → []).
 *
 * Aucun fichier golden n'est modifié ; ce fichier est totalement isolé via son
 * propre mock de module.
 */
import { describe, it, expect, vi } from 'vitest'

// ─── Mock pdf-lib : on contrôle entièrement les documents produits ───────────
const { state } = vi.hoisted(() => ({
  state: {
    formThrows: false,            // getForm() lève (couvre le catch)
    fields: [] as Array<{ name: string; setThrows?: boolean }>,
    flattenCalls: 0,
    drawnTexts: [] as string[],
  },
}))

function makeFakePage() {
  return {
    getHeight: () => 842,
    getWidth: () => 595,
    drawText: (t: string) => { state.drawnTexts.push(t) },
    drawLine: vi.fn(),
    drawCircle: vi.fn(),
    drawRectangle: vi.fn(),
  }
}

function makeFakeForm() {
  return {
    getFields: () => state.fields.map(f => ({
      getName: () => f.name,
      setText: (_s: string) => { if (f.setThrows) throw new Error('champ non-textuel') },
    })),
    flatten: () => { state.flattenCalls++ },
  }
}

function makeFakeDoc() {
  return {
    getForm: () => { if (state.formThrows) throw new Error('PDF non-remplissable'); return makeFakeForm() },
    copyPages: async () => [makeFakePage()],
    addPage: vi.fn(),
    embedFont: async () => ({ widthOfTextAtSize: () => 10 }),
    save: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), // "%PDF-"
  }
}

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    create: async () => makeFakeDoc(),
    load:   async () => makeFakeDoc(),
  },
  StandardFonts: { Helvetica: 'Helvetica', HelveticaBold: 'HelveticaBold' },
  rgb: (r: number, g: number, b: number) => ({ r, g, b }),
}))

// readFileSync mocké : le template PDF est simulé (mock pdf-lib), mais le
// fallback overlay lit rns-coords.json → on renvoie un JSON minimal valide
// couvrant toutes les zones attendues par overlayFromCoords.
const FAKE_COORDS = {
  employer: {
    name:        { x: 50, y: 50, size: 10, bold: false, maxWidth: 200 },
    address:     { x: 50, y: 70, size: 10, bold: false },
    cnpsNumber:  { x: 50, y: 90, size: 10, bold: false },
    issuedAt:    { x: 50, y: 110, size: 10, bold: false },
    affiliation: { x: 50, y: 130, size: 10, bold: false },
  },
  employee: {
    lastNameFirstName: { x: 50, y: 200, size: 10, bold: true },
    year:              { x: 50, y: 220, size: 10, bold: false },
    matriculeCnps:     { x: 50, y: 240, size: 10, bold: false },
    hireDate:          { x: 50, y: 260, size: 10, bold: false },
    exitDate:          { x: 50, y: 280, size: 10, bold: false },
    periodFrom:        { x: 50, y: 300, size: 10, bold: false },
    periodTo:          { x: 50, y: 320, size: 10, bold: false },
    monthsWorked:      { x: 50, y: 340, size: 10, bold: false },
  },
  salary: {
    annualGross: { x: 300, y: 360, size: 10, bold: true, format: 'fcfa', maxWidth: 150 },
  },
  signature: {
    city:  { x: 50, y: 400, size: 10, bold: false },
    name:  { x: 50, y: 420, size: 10, bold: false },
    title: { x: 50, y: 440, size: 10, bold: false },
  },
}
vi.mock('fs', () => ({
  readFileSync: (p: unknown) => {
    if (String(p).endsWith('.json')) return JSON.stringify(FAKE_COORDS)
    return Buffer.from('FAKE-PDF')
  },
}))

import {
  generateRnsPdf,
  listRnsFields,
  type RnsEmployer,
  type RnsEmployee,
} from './rns-pdf.js'

const EMPLOYER: RnsEmployer = {
  name: 'SOTRA SA', address: 'BP 2222 Treichville, Abidjan', cnpsNumber: 'CI-00123456-X',
  affiliationDate: '01/01/2005', city: 'Abidjan',
  signatoryName: 'Jean Kouassi', signatoryTitle: 'DRH',
}
const EMP: RnsEmployee = {
  lastName: 'Diallo', firstName: 'Aïcha', cnpsNumber: 'CI-EMP-1',
  hireDate: '2020-03-15', exitDate: null, annualSalary: 3_600_000, monthsWorked: 12, year: 2024,
}

describe('generateRnsPdf — voie AcroForm (template avec champs)', () => {
  it('remplit les champs reconnus, ignore les inconnus / non-textuels, puis flatten', async () => {
    state.formThrows = false
    state.flattenCalls = 0
    state.drawnTexts = []
    state.fields = [
      { name: 'nom_employeur' },                 // match exact → setText OK
      { name: 'NOM_SALARIE' },                   // match via .toLowerCase()
      { name: 'champ_inconnu' },                 // pas dans acroValues → ignoré
      { name: 'numero_employeur', setThrows: true }, // setText lève → catch interne
    ]
    const buf = await generateRnsPdf(EMPLOYER, [EMP])
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
    expect(state.flattenCalls).toBe(1)
    // acroFilled = matched > 0 → l'overlay déclaratif n'est PAS appelé
    expect(state.drawnTexts.length).toBe(0)
  })

  it('aucun champ ne matche → acroFilled false → overlay déclaratif dessiné', async () => {
    state.formThrows = false
    state.flattenCalls = 0
    state.drawnTexts = []
    state.fields = [{ name: 'aucun_match_du_tout' }]
    await generateRnsPdf(EMPLOYER, [EMP])
    // matched = 0 → fallback overlay → des textes sont dessinés
    expect(state.drawnTexts.length).toBeGreaterThan(0)
  })

  it('getForm() lève → catch, overlay déclaratif utilisé', async () => {
    state.formThrows = true
    state.drawnTexts = []
    await generateRnsPdf(EMPLOYER, [EMP])
    expect(state.drawnTexts.length).toBeGreaterThan(0)
    state.formThrows = false
  })
})

describe('listRnsFields — branches', () => {
  it('template avec champs → retourne les noms', async () => {
    state.formThrows = false
    state.fields = [{ name: 'nom_employeur' }, { name: 'annee' }]
    const fields = await listRnsFields()
    expect(fields).toEqual(['nom_employeur', 'annee'])
  })

  it('getForm() lève → retourne [] (catch)', async () => {
    state.formThrows = true
    const fields = await listRnsFields()
    expect(fields).toEqual([])
    state.formThrows = false
  })
})
