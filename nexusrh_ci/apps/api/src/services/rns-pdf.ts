/**
 * Remplissage du formulaire officiel CNPS — Relevé Nominatif des Salaires
 * Réf. EN-GDAV-06 · Version 03
 *
 * Stratégie :
 *  1. Charge le PDF template original (design CNPS intact)
 *  2. Tente de remplir via AcroForm si le PDF a des champs remplissables
 *  3. Sinon, superpose le texte aux coordonnées des zones vierges du formulaire
 *  4. Génère une page par salarié, téléchargeable et déposable sur e-CNPS
 */
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE   = path.join(__dirname, '..', 'assets', 'rns-template.pdf')

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

// ─── AcroForm : mapping noms courants des champs CNPS → valeur ───────────────
function acroValues(employer: RnsEmployer, emp: RnsEmployee): Record<string, string> {
  const today  = new Date().toLocaleDateString('fr-CI')
  const salary = emp.annualSalary > 0
    ? `${emp.annualSalary.toLocaleString('fr-FR')} FCFA`
    : ''
  const hireStr = emp.hireDate
    ? new Date(emp.hireDate).toLocaleDateString('fr-CI')
    : ''
  const exitStr = emp.exitDate
    ? new Date(emp.exitDate).toLocaleDateString('fr-CI')
    : ''

  return {
    // Employeur
    'nom_employeur':       employer.name,
    'adresse_employeur':   employer.address,
    'numero_employeur':    employer.cnpsNumber,
    'date_etablissement':  `${employer.city}, le ${today}`,
    'date_affiliation':    employer.affiliationDate ?? '',
    'nom_signataire':      employer.signatoryName  ?? '',
    'qualite_signataire':  employer.signatoryTitle  ?? '',
    // Salarié
    'nom_salarie':         `${emp.lastName.toUpperCase()} ${emp.firstName}`,
    'annee':               String(emp.year),
    'salaire_brut_annuel': salary,
    'nb_mois':             emp.monthsWorked > 0 ? String(emp.monthsWorked) : '',
    'matricule_cnps':      emp.cnpsNumber,
    'date_embauche':       hireStr,
    'date_cessation':      exitStr,
    'periode_du':          `01/01/${emp.year}`,
    'periode_au':          `31/12/${emp.year}`,
  }
}

// ─── Superposition texte sur PDF plat (si non-remplissable) ──────────────────
// Coordonnées mesurées sur le formulaire EN-GDAV-06 v03 (A4 = 595 × 842 pt)
// y = distance depuis le HAUT de la page (converti en bas dans pdf-lib)
function overlayText(
  page:     PDFPage,
  font:     PDFFont,
  fontBold: PDFFont,
  employer: RnsEmployer,
  emp:      RnsEmployee,
) {
  const H   = page.getHeight()  // 841.89 pour A4
  const fmt = (n: number) => n.toLocaleString('fr-FR')

  // Dessine du texte ; y = distance depuis le haut
  const t = (
    text: string,
    xLeft: number,
    yTop:  number,
    size   = 7,
    bold   = false,
  ) => {
    if (!text?.trim()) return
    page.drawText(text, {
      x:     xLeft,
      y:     H - yTop - size,
      size,
      font:  bold ? fontBold : font,
      color: rgb(0, 0, 0),
    })
  }

  const today = new Date().toLocaleDateString('fr-CI')

  // ── Bloc employeur (zone ~128–158 pt depuis le haut) ─────────────────────
  t(employer.name,        33,  132, 7)
  t(employer.address,     33,  143, 6)
  t(employer.cnpsNumber,  190, 137, 7)
  t(`${employer.city}, le ${today}`, 463, 140, 6)

  // ── Ligne salarié (zone ~172–192 pt) ─────────────────────────────────────
  t(`${emp.lastName.toUpperCase()} ${emp.firstName}`, 33,  177, 8, true)
  t(String(emp.year),                                  219, 177, 8, true)
  if (emp.annualSalary > 0)
    t(`${fmt(emp.annualSalary)} FCFA`, 258, 177, 7)
  if (emp.monthsWorked > 0)
    t(String(emp.monthsWorked), 418, 177, 8)

  // ── Lignes informations (colonne 2, débute à y=192, pas=17 pt) ───────────
  const rowY = (n: number) => 192 + n * 17 + 5

  t(emp.cnpsNumber,                                     190, rowY(0), 7)
  if (emp.hireDate)
    t(new Date(emp.hireDate).toLocaleDateString('fr-CI'), 190, rowY(2), 7)
  if (emp.exitDate)
    t(new Date(emp.exitDate).toLocaleDateString('fr-CI'), 190, rowY(4), 7)
  t(`01/01/${emp.year}`, 190, rowY(7), 7)
  t(`31/12/${emp.year}`, 190, rowY(8), 7)
  if (employer.signatoryName)  t(employer.signatoryName,  190, rowY(9),  7)
  if (employer.signatoryTitle) t(employer.signatoryTitle, 190, rowY(10), 6)
  if (employer.affiliationDate) t(employer.affiliationDate, 190, rowY(13), 7)
}

// ─── Export principal ─────────────────────────────────────────────────────────
export async function generateRnsPdf(
  employer:  RnsEmployer,
  employees: RnsEmployee[],
): Promise<Buffer> {
  const templateBytes = readFileSync(TEMPLATE)
  const outDoc    = await PDFDocument.create()
  const font      = await outDoc.embedFont(StandardFonts.Helvetica)
  const fontBold  = await outDoc.embedFont(StandardFonts.HelveticaBold)

  for (const emp of employees) {
    // Recharge le template vierge pour chaque salarié
    const tplDoc    = await PDFDocument.load(templateBytes)
    let acroFilled  = false

    // Tentative AcroForm
    try {
      const form   = tplDoc.getForm()
      const values = acroValues(employer, emp)
      let matched  = 0
      for (const field of form.getFields()) {
        const val = values[field.getName()] ?? values[field.getName().toLowerCase()]
        if (val !== undefined) {
          try { (field as any).setText(val); matched++ } catch { /* non-textuel */ }
        }
      }
      form.flatten()
      acroFilled = matched > 0
    } catch { /* PDF non-remplissable */ }

    const pages = await outDoc.copyPages(tplDoc, [0])
    const page  = pages[0]!
    outDoc.addPage(page)

    if (!acroFilled) overlayText(page, font, fontBold, employer, emp)
  }

  return Buffer.from(await outDoc.save())
}

// Utilitaire : liste les champs AcroForm du template (debug)
export async function listRnsFields(): Promise<string[]> {
  const doc = await PDFDocument.load(readFileSync(TEMPLATE))
  try   { return doc.getForm().getFields().map(f => f.getName()) }
  catch { return [] }
}
