/**
 * Remplissage du formulaire officiel CNPS — Relevé Nominatif des Salaires
 * Réf. EN-GDAV-06 · Version 03
 *
 * Le PDF de référence (apps/api/src/assets/rns-template.pdf) est fourni par
 * la CNPS et NE DOIT PAS être recréé : on charge le template tel quel puis
 * on superpose les données aux coordonnées de chaque zone vierge.
 *
 * Stratégie anti-décalage :
 *  1. Si le template expose des champs AcroForm → on les remplit (alignement
 *     géré par le PDF lui-même). C'est la voie idéale.
 *  2. Sinon, on charge un fichier de coordonnées EXTERNE
 *     (apps/api/src/assets/rns-coords.json) qui décrit chaque zone (x, y,
 *     taille de police, bold, maxWidth). Si l'utilisateur observe un
 *     décalage, il ajuste ce JSON sans toucher au code.
 *  3. Outil de calibration : `pnpm --filter api run rns:calibrate` génère
 *     un PDF qui superpose une grille graduée (10pt) + le label de chaque
 *     zone par-dessus le template. L'admin imprime, mesure, ajuste le JSON.
 *
 * Pas de "vraie librairie" magique : aucun outil n'extrait automatiquement
 * les coordonnées d'un PDF non-AcroForm. Mais externaliser les coordonnées
 * dans un JSON éliminé le besoin de rebuild + facilite la maintenance.
 */
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS    = path.join(__dirname, '..', 'assets')
const TEMPLATE  = path.join(ASSETS, 'rns-template.pdf')
const COORDS    = path.join(ASSETS, 'rns-coords.json')

export interface RnsEmployee {
  lastName:     string
  firstName:    string
  cnpsNumber:   string
  hireDate:     string
  exitDate?:    string | null
  annualSalary: number
  monthsWorked: number
  year:         number
}

export interface RnsEmployer {
  name:             string
  address:          string
  cnpsNumber:       string
  affiliationDate?: string
  city:             string
  signatoryName?:   string
  signatoryTitle?:  string
}

// ─── Structure du JSON de coordonnées ───────────────────────────────────────
interface CoordSpec {
  x: number
  y: number
  size: number
  bold: boolean
  maxWidth?: number
  format?: 'fcfa' | 'date'
}
interface RnsCoords {
  employer: {
    name:        CoordSpec
    address:     CoordSpec
    cnpsNumber:  CoordSpec
    issuedAt:    CoordSpec
    affiliation: CoordSpec
  }
  employee: {
    lastNameFirstName: CoordSpec
    year:              CoordSpec
    matriculeCnps:     CoordSpec
    hireDate:          CoordSpec
    exitDate:          CoordSpec
    periodFrom:        CoordSpec
    periodTo:          CoordSpec
    monthsWorked:      CoordSpec
  }
  salary: {
    annualGross: CoordSpec
  }
  signature: {
    city:  CoordSpec
    name:  CoordSpec
    title: CoordSpec
  }
}

let cachedCoords: RnsCoords | null = null
function loadCoords(): RnsCoords {
  if (cachedCoords) return cachedCoords
  const raw = readFileSync(COORDS, 'utf8')
  cachedCoords = JSON.parse(raw) as RnsCoords
  return cachedCoords
}

// ─── AcroForm : mapping noms courants (si jamais le template en avait) ──────
function acroValues(employer: RnsEmployer, emp: RnsEmployee): Record<string, string> {
  const today  = new Date().toLocaleDateString('fr-CI')
  const salary = emp.annualSalary > 0
    ? `${emp.annualSalary.toLocaleString('fr-FR')} FCFA`
    : ''
  const hireStr = emp.hireDate ? new Date(emp.hireDate).toLocaleDateString('fr-CI') : ''
  const exitStr = emp.exitDate ? new Date(emp.exitDate).toLocaleDateString('fr-CI') : ''

  return {
    nom_employeur:       employer.name,
    adresse_employeur:   employer.address,
    numero_employeur:    employer.cnpsNumber,
    date_etablissement:  `${employer.city}, le ${today}`,
    date_affiliation:    employer.affiliationDate ?? '',
    nom_signataire:      employer.signatoryName  ?? '',
    qualite_signataire:  employer.signatoryTitle  ?? '',
    nom_salarie:         `${emp.lastName.toUpperCase()} ${emp.firstName}`,
    annee:               String(emp.year),
    salaire_brut_annuel: salary,
    nb_mois:             emp.monthsWorked > 0 ? String(emp.monthsWorked) : '',
    matricule_cnps:      emp.cnpsNumber,
    date_embauche:       hireStr,
    date_cessation:      exitStr,
    periode_du:          `01/01/${emp.year}`,
    periode_au:          `31/12/${emp.year}`,
  }
}

// ─── Overlay déclaratif (lit le JSON, dessine chaque zone) ──────────────────
function overlayFromCoords(
  page:     PDFPage,
  font:     PDFFont,
  fontBold: PDFFont,
  employer: RnsEmployer,
  emp:      RnsEmployee,
) {
  const c = loadCoords()
  const H = page.getHeight()

  const drawAt = (text: string | undefined | null, spec: CoordSpec) => {
    if (!text) return
    // Normalisation des espaces : `toLocaleString('fr-FR')` insère des
    // NARROW NO-BREAK SPACE (U+202F) entre les milliers ("3 600 000"),
    // que la police Helvetica WinAnsi (utilisée par pdf-lib en core font)
    // ne sait pas encoder → crash. On remplace tous les espaces unicode
    // par un espace ASCII standard avant dessin.
    const value = String(text)
      .replace(/[     ]/g, ' ')
      .trim()
    if (!value) return
    // pdf-lib utilise y depuis le BAS de la page. Le JSON est en y-depuis-le-haut.
    page.drawText(value, {
      x:        spec.x,
      y:        H - spec.y - spec.size,
      size:     spec.size,
      font:     spec.bold ? fontBold : font,
      color:    rgb(0, 0, 0),
      maxWidth: spec.maxWidth,
    })
  }

  const today = new Date().toLocaleDateString('fr-CI')
  const fmt   = (n: number) => n.toLocaleString('fr-FR')

  // Bloc employeur
  drawAt(employer.name,                                            c.employer.name)
  drawAt(employer.address,                                         c.employer.address)
  drawAt(employer.cnpsNumber,                                      c.employer.cnpsNumber)
  drawAt(`${employer.city}, le ${today}`,                          c.employer.issuedAt)
  drawAt(employer.affiliationDate ?? null,                         c.employer.affiliation)

  // Bloc salarié
  drawAt(`${emp.lastName.toUpperCase()} ${emp.firstName}`,         c.employee.lastNameFirstName)
  drawAt(String(emp.year),                                         c.employee.year)
  drawAt(emp.cnpsNumber || null,                                   c.employee.matriculeCnps)
  drawAt(emp.hireDate ? new Date(emp.hireDate).toLocaleDateString('fr-CI') : null, c.employee.hireDate)
  drawAt(emp.exitDate ? new Date(emp.exitDate).toLocaleDateString('fr-CI') : null, c.employee.exitDate)
  drawAt(`01/01/${emp.year}`,                                      c.employee.periodFrom)
  drawAt(`31/12/${emp.year}`,                                      c.employee.periodTo)
  drawAt(emp.monthsWorked > 0 ? String(emp.monthsWorked) : null,   c.employee.monthsWorked)

  // Salaire
  drawAt(emp.annualSalary > 0 ? `${fmt(emp.annualSalary)} FCFA` : null, c.salary.annualGross)

  // Signature
  drawAt(`${employer.city}, le ${today}`, c.signature.city)
  drawAt(employer.signatoryName  ?? null, c.signature.name)
  drawAt(employer.signatoryTitle ?? null, c.signature.title)
}

// ─── Export principal ────────────────────────────────────────────────────────
export async function generateRnsPdf(
  employer:  RnsEmployer,
  employees: RnsEmployee[],
): Promise<Buffer> {
  const templateBytes = readFileSync(TEMPLATE)
  const outDoc        = await PDFDocument.create()
  const font          = await outDoc.embedFont(StandardFonts.Helvetica)
  const fontBold      = await outDoc.embedFont(StandardFonts.HelveticaBold)

  for (const emp of employees) {
    // Recharge le template vierge pour chaque salarié
    const tplDoc   = await PDFDocument.load(templateBytes)
    let acroFilled = false

    // 1. Tentative AcroForm (idéal si le template en a)
    try {
      const form   = tplDoc.getForm()
      const values = acroValues(employer, emp)
      let matched  = 0
      for (const field of form.getFields()) {
        const val = values[field.getName()] ?? values[field.getName().toLowerCase()]
        if (val !== undefined) {
          try { (field as unknown as { setText: (s: string) => void }).setText(val); matched++ }
          catch { /* champ non-textuel */ }
        }
      }
      form.flatten()
      acroFilled = matched > 0
    } catch { /* PDF non-remplissable */ }

    const pages = await outDoc.copyPages(tplDoc, [0])
    const page  = pages[0]!
    outDoc.addPage(page)

    // 2. Fallback overlay déclaratif depuis le JSON de coordonnées
    if (!acroFilled) overlayFromCoords(page, font, fontBold, employer, emp)
  }

  return Buffer.from(await outDoc.save())
}

// ─── Outil de calibration (debug) ────────────────────────────────────────────
/**
 * Génère un PDF qui superpose au template :
 *  - Une grille graduée 10pt (coords en gris léger)
 *  - Un point rouge + label sur chaque zone définie dans le JSON
 *
 * Usage : appelé par `pnpm --filter api run rns:calibrate` (script CLI).
 * L'admin imprime le PDF, mesure visuellement les écarts entre les labels
 * affichés et les vraies zones du formulaire, puis ajuste rns-coords.json.
 */
export async function generateRnsCalibrationPdf(): Promise<Buffer> {
  const templateBytes = readFileSync(TEMPLATE)
  const outDoc       = await PDFDocument.create()
  const font         = await outDoc.embedFont(StandardFonts.Helvetica)
  const fontBold     = await outDoc.embedFont(StandardFonts.HelveticaBold)

  const tplDoc = await PDFDocument.load(templateBytes)
  const pages  = await outDoc.copyPages(tplDoc, [0])
  const page   = pages[0]!
  outDoc.addPage(page)

  const W = page.getWidth()
  const H = page.getHeight()

  // Grille 10pt en gris très clair
  const grid = rgb(0.85, 0.85, 0.95)
  for (let x = 0; x <= W; x += 10) {
    page.drawLine({ start: { x, y: 0 }, end: { x, y: H }, thickness: 0.2, color: grid })
    if (x % 50 === 0) {
      page.drawText(String(x), { x: x + 1, y: H - 8, size: 5, font, color: rgb(0.4, 0.4, 0.6) })
    }
  }
  for (let y = 0; y <= H; y += 10) {
    page.drawLine({ start: { x: 0, y }, end: { x: W, y }, thickness: 0.2, color: grid })
    if (y % 50 === 0) {
      // Labels en y-depuis-le-haut (cohérent avec le JSON)
      page.drawText(String(H - y), { x: 1, y: y - 4, size: 5, font, color: rgb(0.4, 0.4, 0.6) })
    }
  }

  // Marqueurs de chaque zone
  const c = loadCoords()
  const allZones: Array<{ name: string; spec: CoordSpec }> = [
    ...Object.entries(c.employer).map(([k, v]) => ({ name: `EMP/${k}`, spec: v })),
    ...Object.entries(c.employee).map(([k, v]) => ({ name: `SAL/${k}`, spec: v })),
    ...Object.entries(c.salary).map(([k, v])   => ({ name: `SAL/${k}`, spec: v })),
    ...Object.entries(c.signature).map(([k, v]) => ({ name: `SIG/${k}`, spec: v })),
  ]
  for (const { name, spec } of allZones) {
    const yPdf = H - spec.y - spec.size
    // Point rouge à la position
    page.drawCircle({ x: spec.x, y: yPdf + spec.size, size: 2, color: rgb(1, 0, 0) })
    // Cadre rouge de la maxWidth
    if (spec.maxWidth) {
      page.drawRectangle({
        x: spec.x, y: yPdf, width: spec.maxWidth, height: spec.size + 2,
        borderColor: rgb(1, 0.4, 0.4), borderWidth: 0.4,
      })
    }
    // Label en rouge à côté
    page.drawText(`${name} (${spec.x},${spec.y})`, {
      x: spec.x + 2, y: yPdf - 6, size: 5, font: fontBold, color: rgb(0.7, 0, 0),
    })
  }

  return Buffer.from(await outDoc.save())
}

// Utilitaire : liste les champs AcroForm du template (debug)
export async function listRnsFields(): Promise<string[]> {
  const doc = await PDFDocument.load(readFileSync(TEMPLATE))
  try   { return doc.getForm().getFields().map(f => f.getName()) }
  catch { return [] }
}
