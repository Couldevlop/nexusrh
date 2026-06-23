/**
 * Rendu PDF d'un bulletin de paie CI via pdf-lib (déjà dépendance du projet —
 * cf. services/rns-pdf.ts et modules/org-chart/org-chart-pdf.ts). Généré « from
 * scratch » (pas de template) : mise en page A4 portrait, mentions légales CI.
 *
 * pdf-lib a un repère bas-gauche → on inverse l'axe Y (toY = H - yTop).
 * La police standard Helvetica n'encode que WinAnsi : on neutralise tout
 * caractère hors plage (pdfSafe) pour éviter une exception d'encodage.
 */
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib'

export interface PayslipPdfLine {
  code?:  string | null
  label:  string
  type:   'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution' | string
  base?:  number | null
  amount: number
}

export interface PayslipPdfData {
  tenantName:   string
  employer?:    { cnpsNumber?: string | null; address?: string | null; city?: string | null }
  employee:     {
    firstName: string; lastName: string; jobTitle?: string | null
    cnpsNumber?: string | null; nni?: string | null; matricule?: string | null
  }
  month:        string   // YYYY-MM
  lines:        PayslipPdfLine[]
  grossSalary:  number
  totalCnpsSal: number
  its:          number
  totalDeductions: number
  netPayable:   number
  employerCost: number
  currency:     string
  paymentMethod?:    string | null
  paymentReference?: string | null
  generatedAt?:      string | null
  // PAY-025 — cumuls annuels (YTD) : somme des bulletins de l'année jusqu'au mois courant
  annualCumuls?:     { grossSalary: number; totalCnpsSal: number; its: number; netPayable: number } | null
  // Bulletin personnalisable à la convenance du tenant (logo, colonnes, sections, couleur)
  template?:         PayslipTemplateConfig | null
}

/**
 * Personnalisation du bulletin par tenant. Tout est optionnel : des valeurs par
 * défaut sont appliquées (rétro-compatibilité = rendu historique inchangé).
 */
export interface PayslipTemplateConfig {
  // Couleur d'accent (bandeau d'en-tête + libellés). Hex « #RRGGBB ».
  accentColor?: string | null
  // Logo raster (PNG/JPG) embarqué dans l'en-tête. Le SVG n'est pas supporté par pdf-lib.
  logo?:        { bytes: Uint8Array; mime: string } | null
  // Colonnes du tableau des rubriques (Gain/Retenue toujours affichées).
  showBaseColumn?:   boolean   // colonne « Base » (défaut true)
  showCodeColumn?:   boolean   // préfixe code rubrique dans le libellé (défaut true)
  // Sections optionnelles
  showEmployerCost?: boolean   // ligne « Coût total employeur » (défaut true)
  showAnnualCumuls?: boolean   // bloc cumuls annuels YTD (défaut true)
  // Mention légale de pied de page personnalisée (sinon mention CI par défaut)
  footerText?:  string | null
}

function hexToRgb(hex: string | null | undefined, fallback: ReturnType<typeof rgb>): ReturnType<typeof rgb> {
  if (!hex) return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  const n = parseInt(m[1]!, 16)
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255)
}

const NAVY = rgb(0x0f / 255, 0x2a / 255, 0x44 / 255)
const ACCENT = rgb(0xe8 / 255, 0x5d / 255, 0x04 / 255)
const SLATE = rgb(0x47 / 255, 0x55 / 255, 0x69 / 255)
const LINE = rgb(0xcb / 255, 0xd5 / 255, 0xe1 / 255)
const LIGHT = rgb(0xf2 / 255, 0xf4 / 255, 0xf7 / 255)
const WHITE = rgb(1, 1, 1)
const GREEN = rgb(0x05 / 255, 0x60 / 255, 0x3a / 255)

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

function pdfSafe(s: string): string {
  // Map les caractères typographiques courants hors WinAnsi vers leur équivalent
  // ASCII (tirets, guillemets, points de suspension) avant le filtrage.
  const mapped = (s ?? '')
    .replace(/[—–]/g, '-').replace(/[''‚]/g, "'").replace(/[""„]/g, '"').replace(/…/g, '...')
  let out = ''
  for (const ch of mapped) out += ch.charCodeAt(0) <= 0xff ? ch : '?'
  return out
}

function formatMonthFr(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return month
  const idx = parseInt(m[2]!, 10) - 1
  return `${MONTHS_FR[idx] ?? m[2]} ${m[1]}`
}

function formatMoney(n: number, currency: string): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(Math.round(n))
  const grouped = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${grouped} ${currency}`
}

export async function renderPayslipPdf(data: PayslipPdfData): Promise<Uint8Array> {
  const W = 595.28, H = 841.89 // A4 portrait
  const doc = await PDFDocument.create()
  const page: PDFPage = doc.addPage([W, H])
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold)

  const ML = 36, MR = 36
  const contentW = W - ML - MR
  const toY = (yTop: number) => H - yTop

  // Personnalisation tenant (valeurs par défaut = rendu historique).
  const cfg = data.template ?? {}
  const accent = hexToRgb(cfg.accentColor, ACCENT)
  const showBase = cfg.showBaseColumn !== false
  const showCode = cfg.showCodeColumn !== false
  let logoImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null
  if (cfg.logo?.bytes?.length) {
    try {
      logoImg = /jpe?g/i.test(cfg.logo.mime)
        ? await doc.embedJpg(cfg.logo.bytes)
        : await doc.embedPng(cfg.logo.bytes)
    } catch { logoImg = null } // logo illisible/SVG → repli sur le nom
  }

  const text = (s: string, x: number, yTop: number, size: number, opts?: { bold?: boolean; color?: ReturnType<typeof rgb> }) => {
    page.drawText(pdfSafe(s), { x, y: toY(yTop), size, font: opts?.bold ? fontBold : font, color: opts?.color ?? NAVY })
  }
  const textRight = (s: string, xRight: number, yTop: number, size: number, opts?: { bold?: boolean; color?: ReturnType<typeof rgb> }) => {
    const f = opts?.bold ? fontBold : font
    const w = f.widthOfTextAtSize(pdfSafe(s), size)
    page.drawText(pdfSafe(s), { x: xRight - w, y: toY(yTop), size, font: f, color: opts?.color ?? NAVY })
  }

  // ── En-tête ───────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: NAVY })
  page.drawRectangle({ x: 0, y: H - 70, width: 6, height: 70, color: accent })
  // Logo tenant (raster) à gauche, sinon le nom occupe la place.
  let nameX = ML
  if (logoImg) {
    const lh = 42
    const lw = Math.min(120, (logoImg.width / logoImg.height) * lh)
    page.drawImage(logoImg, { x: ML, y: H - 14 - lh, width: lw, height: lh })
    nameX = ML + lw + 12
  }
  text(data.tenantName || 'Employeur', nameX, 30, 16, { bold: true, color: WHITE })
  text('Bulletin de paie', nameX, 50, 10, { color: rgb(0xc7 / 255, 0xd2 / 255, 0xdd / 255) })
  textRight(formatMonthFr(data.month), W - MR, 34, 13, { bold: true, color: WHITE })
  textRight('Période', W - MR, 50, 9, { color: rgb(0xc7 / 255, 0xd2 / 255, 0xdd / 255) })

  let y = 96

  // ── Bloc employeur / salarié ────────────────────────────────────────────────
  const colW = contentW / 2
  const boxH = 86
  page.drawRectangle({ x: ML, y: toY(y + boxH), width: colW - 6, height: boxH, color: LIGHT })
  page.drawRectangle({ x: ML + colW + 6, y: toY(y + boxH), width: colW - 6, height: boxH, color: LIGHT })

  text('EMPLOYEUR', ML + 10, y + 16, 8, { bold: true, color: accent })
  text(data.tenantName || '-', ML + 10, y + 32, 9, { bold: true })
  if (data.employer?.address) text(data.employer.address, ML + 10, y + 46, 8, { color: SLATE })
  if (data.employer?.city) text(data.employer.city, ML + 10, y + 58, 8, { color: SLATE })
  if (data.employer?.cnpsNumber) text(`N° CNPS employeur : ${data.employer.cnpsNumber}`, ML + 10, y + 72, 8, { color: SLATE })

  const x2 = ML + colW + 16
  const empName = `${data.employee.firstName ?? ''} ${data.employee.lastName ?? ''}`.trim()
  text('SALARIÉ', x2, y + 16, 8, { bold: true, color: accent })
  text(empName || '-', x2, y + 32, 9, { bold: true })
  if (data.employee.jobTitle) text(data.employee.jobTitle, x2, y + 46, 8, { color: SLATE })
  if (data.employee.cnpsNumber) text(`N° CNPS : ${data.employee.cnpsNumber}`, x2, y + 58, 8, { color: SLATE })
  if (data.employee.nni) text(`NNI : ${data.employee.nni}`, x2, y + 72, 8, { color: SLATE })

  y += boxH + 22

  // ── Tableau des rubriques ───────────────────────────────────────────────────
  // Colonnes : Libellé | Base | Gain | Retenue
  const cLabel = ML + 6
  const cBase = ML + contentW * 0.55
  const cGain = ML + contentW * 0.78
  const cRet = W - MR - 6
  const rowH = 16

  page.drawRectangle({ x: ML, y: toY(y + rowH), width: contentW, height: rowH, color: NAVY })
  text('Rubrique', cLabel, y + 11.5, 8.5, { bold: true, color: WHITE })
  if (showBase) textRight('Base', cBase, y + 11.5, 8.5, { bold: true, color: WHITE })
  textRight('Gain', cGain, y + 11.5, 8.5, { bold: true, color: WHITE })
  textRight('Retenue', cRet, y + 11.5, 8.5, { bold: true, color: WHITE })
  y += rowH

  const isDeduction = (t: string) => t === 'deduction' || t === 'employee_contribution'
  let zebra = false
  for (const l of data.lines) {
    // n'affiche pas les contributions patronales dans le corps (récap en pied)
    if (l.type === 'employer_contribution') continue
    if (zebra) page.drawRectangle({ x: ML, y: toY(y + rowH), width: contentW, height: rowH, color: rgb(0xfa / 255, 0xfb / 255, 0xfc / 255) })
    zebra = !zebra
    const labelTxt = showCode && l.code ? `${l.code}  ${l.label}` : l.label
    text(labelTxt.length > 52 ? labelTxt.slice(0, 51) + '…' : labelTxt, cLabel, y + 11, 8, { color: SLATE })
    if (showBase && l.base != null && l.base > 0) textRight(formatMoney(l.base, data.currency), cBase, y + 11, 8, { color: SLATE })
    if (isDeduction(l.type)) textRight(formatMoney(Math.abs(l.amount), data.currency), cRet, y + 11, 8, { color: rgb(0x91 / 255, 0x20 / 255, 0x18 / 255) })
    else textRight(formatMoney(l.amount, data.currency), cGain, y + 11, 8, { color: NAVY })
    y += rowH
  }
  page.drawLine({ start: { x: ML, y: toY(y) }, end: { x: W - MR, y: toY(y) }, thickness: 0.6, color: LINE })
  y += 14

  // ── Récapitulatif ───────────────────────────────────────────────────────────
  const recap: Array<[string, number, boolean]> = [
    ['Salaire brut', data.grossSalary, false],
    ['Total cotisations salariales (CNPS)', -data.totalCnpsSal, false],
    ['ITS (Impôt sur traitements et salaires)', -data.its, false],
    ['Total des retenues', -data.totalDeductions, false],
  ]
  for (const [label, val] of recap) {
    text(label, cLabel, y + 11, 9, { color: SLATE })
    textRight(formatMoney(val, data.currency), cRet, y + 11, 9, { color: val < 0 ? rgb(0x91 / 255, 0x20 / 255, 0x18 / 255) : NAVY })
    y += rowH
  }
  y += 6

  // Net à payer (bandeau)
  const netH = 28
  page.drawRectangle({ x: ML, y: toY(y + netH), width: contentW, height: netH, color: rgb(0xd1 / 255, 0xfa / 255, 0xdf / 255) })
  text('NET À PAYER', cLabel, y + 18.5, 11, { bold: true, color: GREEN })
  textRight(formatMoney(data.netPayable, data.currency), cRet, y + 18.5, 13, { bold: true, color: GREEN })
  y += netH + 14

  if (cfg.showEmployerCost !== false) {
    text(`Coût total employeur : ${formatMoney(data.employerCost, data.currency)}`, cLabel, y + 10, 8.5, { color: SLATE })
    y += 16
  }
  if (data.paymentMethod) {
    const ref = data.paymentReference ? ` · réf. ${data.paymentReference}` : ''
    text(`Mode de paiement : ${data.paymentMethod}${ref}`, cLabel, y + 10, 8.5, { color: SLATE })
    y += 16
  }

  // ── Cumuls annuels (YTD) — PAY-025 ──────────────────────────────────────────
  if (data.annualCumuls && cfg.showAnnualCumuls !== false) {
    y += 4
    const cum = data.annualCumuls
    page.drawRectangle({ x: ML, y: toY(y + 16), width: contentW, height: 16, color: LIGHT })
    text(`Cumuls annuels ${data.month.slice(0, 4)} (à fin ${formatMonthFr(data.month)})`, cLabel, y + 11.5, 8, { bold: true, color: NAVY })
    y += 16
    const cumLines: Array<[string, number]> = [
      ['Cumul salaire brut', cum.grossSalary],
      ['Cumul cotisations salariales (CNPS)', cum.totalCnpsSal],
      ['Cumul ITS', cum.its],
      ['Cumul net payé', cum.netPayable],
    ]
    for (const [label, val] of cumLines) {
      text(label, cLabel, y + 10.5, 8, { color: SLATE })
      textRight(formatMoney(val, data.currency), cRet, y + 10.5, 8, { color: NAVY })
      y += 14
    }
    y += 6
  }

  // ── Pied de page (mentions légales) ─ origine pdf-lib = bas-gauche : y bas ────
  const footY = 40
  page.drawLine({ start: { x: ML, y: footY + 16 }, end: { x: W - MR, y: footY + 16 }, thickness: 0.5, color: LINE })
  const gen = data.generatedAt ? new Date(data.generatedAt).toLocaleDateString('fr-FR') : ''
  page.drawText(pdfSafe(cfg.footerText ||
    'Bulletin établi conformément au Code du travail ivoirien et à la réglementation CNPS. ' +
    'À conserver sans limitation de durée.'),
    { x: ML, y: footY, size: 7, font, color: SLATE })
  page.drawText(pdfSafe(`Document généré le ${gen} — NexusRH CI · OpenLab Consulting`),
    { x: ML, y: footY - 11, size: 7, font, color: SLATE })

  return doc.save()
}
