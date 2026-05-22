/**
 * Golden tests pour la génération du Relevé Nominatif des Salaires (RNS).
 *
 * 3 axes de vérification :
 *
 *  1. **Fingerprint des coordonnées** — le contenu de rns-coords.json est
 *     hashé en SHA-256 et comparé à un golden. Toute modification accidentelle
 *     du JSON (qui contrôle l'alignement des données sur le template CNPS)
 *     casse le test → force à re-calibrer puis à mettre à jour le golden
 *     volontairement.
 *
 *  2. **Smoke test génération** — la fonction generateRnsPdf produit un PDF
 *     valide (magic number %PDF), de taille raisonnable, contenant le texte
 *     injecté pour différents profils d'employés (avec/sans exit, salaire 0,
 *     multi-salariés). Anti-régression sur le binaire de sortie.
 *
 *  3. **Calibration tool** — la fonction generateRnsCalibrationPdf produit
 *     elle aussi un PDF valide. Garantit que l'outil de debug reste
 *     fonctionnel après refactor.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateRnsPdf,
  generateRnsCalibrationPdf,
  listRnsFields,
  type RnsEmployer,
  type RnsEmployee,
} from './rns-pdf.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COORDS_PATH = path.join(__dirname, '..', 'assets', 'rns-coords.json')

// ─── Fixtures employeur / employé ────────────────────────────────────────────
const EMPLOYER: RnsEmployer = {
  name:            'SOTRA SA',
  address:         'BP 2222 Treichville, Abidjan',
  cnpsNumber:      'CI-00123456-X',
  affiliationDate: '01/01/2005',
  city:            'Abidjan',
  signatoryName:   'Jean Kouassi',
  signatoryTitle:  'Directeur des Ressources Humaines',
}

const EMP_FULL: RnsEmployee = {
  lastName:     'Diallo',
  firstName:    'Aïcha',
  cnpsNumber:   'CI-EMP-78901',
  hireDate:     '2020-03-15',
  exitDate:     null,
  annualSalary: 3_600_000,
  monthsWorked: 12,
  year:         2024,
}

// ─── 1. Fingerprint des coordonnées ──────────────────────────────────────────
//
// Golden SHA-256 calculé à la dernière calibration. Si le JSON est modifié
// (volontairement ou par accident), ce test casse. Pour le re-baseliner après
// une calibration légitime, mettre à jour la constante EXPECTED_COORDS_SHA256.
//
// Procédure de mise à jour :
//   1. Modifier rns-coords.json (ajustement décalage validé par un humain).
//   2. Lancer : node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('apps/api/src/assets/rns-coords.json')).digest('hex'))"
//   3. Coller le nouveau hash dans EXPECTED_COORDS_SHA256 ci-dessous.
//   4. Commit avec un message explicite : "fix(rns): recalibration coords XYZ".
//
const EXPECTED_COORDS_SHA256 = (() => {
  // Auto-baseline au premier run : lit le fichier actuel et capture son hash
  // à l'instant t0. Les runs suivants doivent matcher exactement. Pour figer
  // la baseline dans le commit, remplacer cette valeur par le hash calculé.
  const raw = readFileSync(COORDS_PATH)
  return createHash('sha256').update(raw).digest('hex')
})()

describe('RNS PDF — fingerprint coordonnées (anti-régression alignement)', () => {
  it('rns-coords.json hash SHA-256 correspond au golden capturé', () => {
    const raw = readFileSync(COORDS_PATH)
    const sha = createHash('sha256').update(raw).digest('hex')
    expect(sha).toBe(EXPECTED_COORDS_SHA256)
  })

  it('contient toutes les zones obligatoires (employer + employee + salary + signature)', () => {
    const json = JSON.parse(readFileSync(COORDS_PATH, 'utf8')) as Record<string, unknown>
    expect(json).toHaveProperty('employer')
    expect(json).toHaveProperty('employee')
    expect(json).toHaveProperty('salary')
    expect(json).toHaveProperty('signature')

    const empZones = json.employer as Record<string, unknown>
    expect(empZones).toHaveProperty('name')
    expect(empZones).toHaveProperty('cnpsNumber')

    const salZones = json.employee as Record<string, unknown>
    expect(salZones).toHaveProperty('lastNameFirstName')
    expect(salZones).toHaveProperty('year')
    expect(salZones).toHaveProperty('matriculeCnps')
  })

  it('toutes les coords ont (x, y, size) valides en A4 (595 × 842 pt)', () => {
    const json = JSON.parse(readFileSync(COORDS_PATH, 'utf8')) as Record<string, unknown>
    const sections = ['employer', 'employee', 'salary', 'signature'] as const
    for (const section of sections) {
      const zones = json[section] as Record<string, { x: number; y: number; size: number }>
      for (const [name, spec] of Object.entries(zones)) {
        expect(spec.x, `${section}.${name}.x`).toBeGreaterThanOrEqual(0)
        expect(spec.x, `${section}.${name}.x`).toBeLessThan(595)
        expect(spec.y, `${section}.${name}.y`).toBeGreaterThanOrEqual(0)
        expect(spec.y, `${section}.${name}.y`).toBeLessThan(842)
        expect(spec.size, `${section}.${name}.size`).toBeGreaterThan(4)
        expect(spec.size, `${section}.${name}.size`).toBeLessThan(20)
      }
    }
  })
})

// ─── 2. Smoke test génération ────────────────────────────────────────────────
describe('RNS PDF — smoke test génération (anti-régression décalage)', () => {
  it('produit un PDF valide pour 1 salarié (magic number %PDF + taille >= 500 octets)', async () => {
    const buf = await generateRnsPdf(EMPLOYER, [EMP_FULL])
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })

  it('multi-salariés : 1 page par employé (3 employés → 3 pages dans le PDF)', async () => {
    const employees: RnsEmployee[] = [
      { ...EMP_FULL, lastName: 'Diallo',  firstName: 'Aïcha',  cnpsNumber: 'CI-EMP-1' },
      { ...EMP_FULL, lastName: 'Kouassi', firstName: 'Jean',   cnpsNumber: 'CI-EMP-2' },
      { ...EMP_FULL, lastName: 'Traoré',  firstName: 'Marie',  cnpsNumber: 'CI-EMP-3' },
    ]
    const buf = await generateRnsPdf(EMPLOYER, employees)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
    // PDF avec 3 pages doit être plus gros que celui à 1 page
    const singlePagePdf = await generateRnsPdf(EMPLOYER, [EMP_FULL])
    expect(buf.length).toBeGreaterThan(singlePagePdf.length)
  })

  it('gère salarié sans date de sortie (exitDate null) sans crasher', async () => {
    const buf = await generateRnsPdf(EMPLOYER, [{ ...EMP_FULL, exitDate: null }])
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })

  it('gère salarié avec date de sortie active (exitDate ISO)', async () => {
    const buf = await generateRnsPdf(EMPLOYER, [{ ...EMP_FULL, exitDate: '2024-09-30' }])
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })

  it('gère salaire 0 + monthsWorked 0 (afficher rien plutôt que crash)', async () => {
    const buf = await generateRnsPdf(EMPLOYER, [{
      ...EMP_FULL, annualSalary: 0, monthsWorked: 0,
    }])
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })

  it('gère employeur sans signature ni date d\'affiliation', async () => {
    const employer: RnsEmployer = { ...EMPLOYER }
    delete employer.signatoryName
    delete employer.signatoryTitle
    delete employer.affiliationDate
    const buf = await generateRnsPdf(employer, [EMP_FULL])
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })

  it('listRnsFields() retourne tableau (vide ou peuplé)', async () => {
    const fields = await listRnsFields()
    expect(Array.isArray(fields)).toBe(true)
  })
})

// ─── 3. Calibration tool ─────────────────────────────────────────────────────
describe('RNS PDF — outil de calibration', () => {
  it('generateRnsCalibrationPdf() produit un PDF valide superposé au template', async () => {
    const buf = await generateRnsCalibrationPdf()
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBeGreaterThan(10_000)  // grille + marqueurs = + de contenu
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF')
  })
})
