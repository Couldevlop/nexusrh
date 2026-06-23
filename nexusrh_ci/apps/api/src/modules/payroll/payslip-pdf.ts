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
  // Libellés locaux (multi-pays) : caisse sociale + impôt. Défaut CNPS / ITS (CI).
  caisseLabel?:      string | null   // ex: 'CNPS', 'IPRES + CSS', 'CNSS'
  impotLabel?:       string | null   // ex: 'ITS', 'IR — Impôt sur le Revenu', 'IRPP'
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
  // Constructeur par blocs : ordre + activation. `text` porte le contenu d'un bloc
  // freeText. Si absent, ordre par défaut (identité→tableau→récap→net→…).
  blocks?:      Array<{ id: string; enabled?: boolean; text?: string }>
}

/**
 * Résout le modèle effectif pour un pays donné : config « Groupe » (champs de
 * premier niveau) fusionnée avec la surcharge `byCountry[country]` si elle existe.
 * En mono-pays, `byCountry` est généralement vide → on obtient la config Groupe.
 */
export function resolvePayslipTemplateConfig(payslipConfig: unknown, country: string): Record<string, unknown> {
  const cfg = (payslipConfig && typeof payslipConfig === 'object') ? payslipConfig as Record<string, unknown> : {}
  const byCountry = (cfg.byCountry && typeof cfg.byCountry === 'object') ? cfg.byCountry as Record<string, unknown> : {}
  const override = (byCountry[country] && typeof byCountry[country] === 'object') ? byCountry[country] as Record<string, unknown> : {}
  const { byCountry: _omit, ...group } = cfg
  return { ...group, ...override }
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
  // Libellés locaux (multi-pays) ; version courte pour les champs compacts.
  const caisse = data.caisseLabel || 'CNPS'
  const caisseShort = (caisse.split(/[ +]/)[0] || 'CNPS')
  const impotLbl = data.impotLabel || 'ITS'
  const impotShort = (impotLbl.split(/[ —-]/)[0] || 'ITS').trim()
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

  // Colonnes du tableau des rubriques (constantes, indépendantes de y).
  const cLabel = ML + 6
  const cBase = ML + contentW * 0.55
  const cGain = ML + contentW * 0.78
  const cRet = W - MR - 6
  const rowH = 16
  const isDeduction = (t: string) => t === 'deduction' || t === 'employee_contribution'

  // ── Blocs (chaque fonction dessine à partir de `y` et renvoie le nouveau y) ──
  // Bloc identité : employeur + salarié
  function drawIdentity(y0: number): number {
    const colW = contentW / 2
    const boxH = 86
    page.drawRectangle({ x: ML, y: toY(y0 + boxH), width: colW - 6, height: boxH, color: LIGHT })
    page.drawRectangle({ x: ML + colW + 6, y: toY(y0 + boxH), width: colW - 6, height: boxH, color: LIGHT })
    text('EMPLOYEUR', ML + 10, y0 + 16, 8, { bold: true, color: accent })
    text(data.tenantName || '-', ML + 10, y0 + 32, 9, { bold: true })
    if (data.employer?.address) text(data.employer.address, ML + 10, y0 + 46, 8, { color: SLATE })
    if (data.employer?.city) text(data.employer.city, ML + 10, y0 + 58, 8, { color: SLATE })
    if (data.employer?.cnpsNumber) text(`N° ${caisseShort} employeur : ${data.employer.cnpsNumber}`, ML + 10, y0 + 72, 8, { color: SLATE })
    const x2 = ML + colW + 16
    const empName = `${data.employee.firstName ?? ''} ${data.employee.lastName ?? ''}`.trim()
    text('SALARIÉ', x2, y0 + 16, 8, { bold: true, color: accent })
    text(empName || '-', x2, y0 + 32, 9, { bold: true })
    if (data.employee.jobTitle) text(data.employee.jobTitle, x2, y0 + 46, 8, { color: SLATE })
    if (data.employee.cnpsNumber) text(`N° CNPS : ${data.employee.cnpsNumber}`, x2, y0 + 58, 8, { color: SLATE })
    if (data.employee.nni) text(`NNI : ${data.employee.nni}`, x2, y0 + 72, 8, { color: SLATE })
    return y0 + boxH + 22
  }
  // Bloc tableau des rubriques
  function drawTable(y0: number): number {
    let yy = y0
    page.drawRectangle({ x: ML, y: toY(yy + rowH), width: contentW, height: rowH, color: NAVY })
    text('Rubrique', cLabel, yy + 11.5, 8.5, { bold: true, color: WHITE })
    if (showBase) textRight('Base', cBase, yy + 11.5, 8.5, { bold: true, color: WHITE })
    textRight('Gain', cGain, yy + 11.5, 8.5, { bold: true, color: WHITE })
    textRight('Retenue', cRet, yy + 11.5, 8.5, { bold: true, color: WHITE })
    yy += rowH
    let zebra = false
    for (const l of data.lines) {
      if (l.type === 'employer_contribution') continue // patronales : récap en pied
      if (zebra) page.drawRectangle({ x: ML, y: toY(yy + rowH), width: contentW, height: rowH, color: rgb(0xfa / 255, 0xfb / 255, 0xfc / 255) })
      zebra = !zebra
      const labelTxt = showCode && l.code ? `${l.code}  ${l.label}` : l.label
      text(labelTxt.length > 52 ? labelTxt.slice(0, 51) + '…' : labelTxt, cLabel, yy + 11, 8, { color: SLATE })
      if (showBase && l.base != null && l.base > 0) textRight(formatMoney(l.base, data.currency), cBase, yy + 11, 8, { color: SLATE })
      if (isDeduction(l.type)) textRight(formatMoney(Math.abs(l.amount), data.currency), cRet, yy + 11, 8, { color: rgb(0x91 / 255, 0x20 / 255, 0x18 / 255) })
      else textRight(formatMoney(l.amount, data.currency), cGain, yy + 11, 8, { color: NAVY })
      yy += rowH
    }
    page.drawLine({ start: { x: ML, y: toY(yy) }, end: { x: W - MR, y: toY(yy) }, thickness: 0.6, color: LINE })
    return yy + 14
  }
  // Bloc récapitulatif
  function drawRecap(y0: number): number {
    let yy = y0
    const recap: Array<[string, number]> = [
      ['Salaire brut', data.grossSalary],
      [`Total cotisations salariales (${caisseShort})`, -data.totalCnpsSal],
      [`${impotLbl}`, -data.its],
      ['Total des retenues', -data.totalDeductions],
    ]
    for (const [label, val] of recap) {
      text(label, cLabel, yy + 11, 9, { color: SLATE })
      textRight(formatMoney(val, data.currency), cRet, yy + 11, 9, { color: val < 0 ? rgb(0x91 / 255, 0x20 / 255, 0x18 / 255) : NAVY })
      yy += rowH
    }
    return yy + 6
  }
  // Bloc net à payer
  function drawNet(y0: number): number {
    const netH = 28
    page.drawRectangle({ x: ML, y: toY(y0 + netH), width: contentW, height: netH, color: rgb(0xd1 / 255, 0xfa / 255, 0xdf / 255) })
    text('NET À PAYER', cLabel, y0 + 18.5, 11, { bold: true, color: GREEN })
    textRight(formatMoney(data.netPayable, data.currency), cRet, y0 + 18.5, 13, { bold: true, color: GREEN })
    return y0 + netH + 14
  }
  function drawEmployerCost(y0: number): number {
    text(`Coût total employeur : ${formatMoney(data.employerCost, data.currency)}`, cLabel, y0 + 10, 8.5, { color: SLATE })
    return y0 + 16
  }
  function drawPayment(y0: number): number {
    if (!data.paymentMethod) return y0
    const ref = data.paymentReference ? ` · réf. ${data.paymentReference}` : ''
    text(`Mode de paiement : ${data.paymentMethod}${ref}`, cLabel, y0 + 10, 8.5, { color: SLATE })
    return y0 + 16
  }
  // Bloc cumuls annuels (YTD) — PAY-025
  function drawCumuls(y0: number): number {
    if (!data.annualCumuls) return y0
    let yy = y0 + 4
    const cum = data.annualCumuls
    page.drawRectangle({ x: ML, y: toY(yy + 16), width: contentW, height: 16, color: LIGHT })
    text(`Cumuls annuels ${data.month.slice(0, 4)} (à fin ${formatMonthFr(data.month)})`, cLabel, yy + 11.5, 8, { bold: true, color: NAVY })
    yy += 16
    const cumLines: Array<[string, number]> = [
      ['Cumul salaire brut', cum.grossSalary],
      [`Cumul cotisations salariales (${caisseShort})`, cum.totalCnpsSal],
      [`Cumul ${impotShort}`, cum.its],
      ['Cumul net payé', cum.netPayable],
    ]
    for (const [label, val] of cumLines) {
      text(label, cLabel, yy + 10.5, 8, { color: SLATE })
      textRight(formatMoney(val, data.currency), cRet, yy + 10.5, 8, { color: NAVY })
      yy += 14
    }
    return yy + 6
  }
  // Bloc texte libre (mention personnalisée, multi-lignes auto)
  function drawFreeText(content: string, y0: number): number {
    const clean = (content ?? '').trim()
    if (!clean) return y0
    let yy = y0
    for (const para of clean.split('\n')) {
      const words = para.split(/\s+/)
      let line = ''
      for (const w of words) {
        if ((line + ' ' + w).trim().length > 95) { text(line, cLabel, yy + 10, 8, { color: SLATE }); yy += 12; line = w }
        else line = line ? `${line} ${w}` : w
      }
      if (line) { text(line, cLabel, yy + 10, 8, { color: SLATE }); yy += 12 }
    }
    return yy + 6
  }

  // Ordre des blocs : config tenant si fournie, sinon ordre par défaut. Les blocs
  // légaux obligatoires (identité, tableau, récap, net) restent présents même si
  // omis de la config. `text` sur un bloc freeText = mention personnalisée.
  const DEFAULT_BLOCKS: Array<{ id: string; enabled?: boolean; text?: string }> = [
    { id: 'identity', enabled: true },
    { id: 'table', enabled: true },
    { id: 'recap', enabled: true },
    { id: 'net', enabled: true },
    { id: 'employerCost', enabled: cfg.showEmployerCost !== false },
    { id: 'payment', enabled: true },
    { id: 'cumuls', enabled: cfg.showAnnualCumuls !== false },
  ]
  const blocks: Array<{ id: string; enabled?: boolean; text?: string }> =
    Array.isArray(cfg.blocks) && cfg.blocks.length ? cfg.blocks : DEFAULT_BLOCKS

  let y = 96
  for (const blk of blocks) {
    if (blk.enabled === false) continue
    switch (blk.id) {
      case 'identity':     y = drawIdentity(y); break
      case 'table':        y = drawTable(y); break
      case 'recap':        y = drawRecap(y); break
      case 'net':          y = drawNet(y); break
      case 'employerCost': y = drawEmployerCost(y); break
      case 'payment':      y = drawPayment(y); break
      case 'cumuls':       y = drawCumuls(y); break
      case 'freeText':     y = drawFreeText(blk.text ?? '', y); break
      default: break
    }
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
