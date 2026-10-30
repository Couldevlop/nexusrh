/**
 * Rendu PDF d'un document RH (contrat OHADA CDI/CDD, certificat, attestation)
 * à partir du Markdown produit par hr-document-generator.service.ts (REC-007).
 *
 * Rendu « from scratch » via pdf-lib (déjà dépendance du projet — cf.
 * payslip-pdf.ts / training-attestation-pdf.ts). A4 portrait, multi-pages.
 * pdf-lib utilise un repère bas-gauche → on inverse l'axe Y. Helvetica n'encode
 * que WinAnsi : pdfSafe neutralise les caractères hors plage.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

function pdfSafe(s: string): string {
  return (s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/€/g, 'EUR')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\xFF]/g, '?')
}

/** Retire les marqueurs Markdown inline (gras/italique) d'une ligne. */
function stripInline(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '')
}

const W = 595.28
const H = 841.89
const MARGIN_X = 56
const TOP = 64
const BOTTOM = 56
const MAX_W = W - MARGIN_X * 2

/**
 * Découpe un texte en lignes tenant dans maxWidth pour la police/taille données.
 */
function wrap(font: PDFFont, size: number, text: string, maxWidth: number): string[] {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = candidate
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

/** Mentions légales de l'employeur (filiale de l'offre, sinon tenant). */
export interface HrDocumentLegalInfo {
  name: string
  legalForm?: string | null
  rccm?: string | null
  cnpsNumber?: string | null
  dgiNumber?: string | null
  address?: string | null
  city?: string | null
  collectiveAgreement?: string | null
}

/**
 * Habillage optionnel (proposition de contrat) : logo, couleur d'accent,
 * en-tête et pied de page de mentions légales, marque « PROPOSITION ». Sans ce
 * paramètre, le rendu historique est strictement inchangé.
 */
export interface HrDocumentBranding {
  logo?: { bytes: Uint8Array; mime: string } | null
  /** Couleur principale du tenant (#RRGGBB) ; invalide → accent historique. */
  primaryColor?: string | null
  legal?: HrDocumentLegalInfo | null
  /** Marque visible, ex. « PROPOSITION — document non signé ». */
  draftMark?: string | null
}

const HEX_RE = /^#([0-9a-f]{6})$/i
const DRAFT_RED = rgb(0.75, 0.1, 0.1)

/** #RRGGBB → composantes 0..1, ou null si invalide. */
function hexToRgb(hex: string | null | undefined): [number, number, number] | null {
  const m = HEX_RE.exec((hex ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

/** Ligne courte des mentions légales (pied de page). */
function legalShortLine(l: HrDocumentLegalInfo): string {
  return [
    l.legalForm ? `${l.name} (${l.legalForm})` : l.name,
    l.rccm ? `RCCM ${l.rccm}` : null,
    l.cnpsNumber ? `CNPS ${l.cnpsNumber}` : null,
    l.dgiNumber ? `CC ${l.dgiNumber}` : null,
    [l.address, l.city].filter(Boolean).join(', ') || null,
  ].filter(Boolean).join(' - ')
}

/** Lignes détaillées des mentions légales (bloc d'en-tête). */
function legalHeaderLines(l: HrDocumentLegalInfo): string[] {
  const lines: string[] = []
  if (l.legalForm) lines.push(`Forme juridique : ${l.legalForm}`)
  const ids = [
    l.rccm ? `RCCM : ${l.rccm}` : null,
    l.cnpsNumber ? `N° CNPS : ${l.cnpsNumber}` : null,
    l.dgiNumber ? `N° compte contribuable (DGI) : ${l.dgiNumber}` : null,
  ].filter(Boolean)
  if (ids.length) lines.push(ids.join('  |  '))
  const addr = [l.address, l.city].filter(Boolean).join(', ')
  if (addr) lines.push(`Adresse : ${addr}`)
  if (l.collectiveAgreement) lines.push(`Convention collective : ${l.collectiveAgreement}`)
  return lines
}

export async function renderHrDocumentPdf(markdown: string, branding?: HrDocumentBranding): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique)
  const ink = rgb(0.12, 0.12, 0.15)
  const custom = hexToRgb(branding?.primaryColor)
  const accent = custom ? rgb(custom[0], custom[1], custom[2]) : rgb(0.10, 0.40, 0.30)
  const grey = rgb(0.5, 0.5, 0.55)

  let page: PDFPage = doc.addPage([W, H])
  let yTop = TOP

  const newPage = () => { page = doc.addPage([W, H]); yTop = TOP }
  const ensure = (needed: number) => { if (yTop + needed > H - BOTTOM) newPage() }
  const drawLine = (s: string, x: number, size: number, f: PDFFont, color = ink) =>
    page.drawText(pdfSafe(s), { x, y: H - yTop, size, font: f, color })
  const drawCentered = (s: string, size: number, f: PDFFont, color = ink) => {
    const safe = pdfSafe(s)
    const w = f.widthOfTextAtSize(safe, size)
    page.drawText(safe, { x: (W - w) / 2, y: H - yTop, size, font: f, color })
  }

  const para = (text: string, size: number, f: PDFFont, color = ink, indent = 0) => {
    const lines = wrap(f, size, text, MAX_W - indent)
    for (const ln of lines) {
      ensure(size + 4)
      drawLine(ln, MARGIN_X + indent, size, f, color)
      yTop += size + 4
    }
  }

  // ── En-tête de marque (proposition) : logo + mentions légales + marque ──
  if (branding) {
    let logoImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null
    if (branding.logo?.bytes?.length) {
      try {
        if (/jpe?g/i.test(branding.logo.mime)) logoImg = await doc.embedJpg(branding.logo.bytes)
        else if (/png/i.test(branding.logo.mime)) logoImg = await doc.embedPng(branding.logo.bytes)
      } catch { logoImg = null } // logo illisible → en-tête texte seul
    }
    const headerTop = 28
    let textX = MARGIN_X
    let logoBottom = headerTop
    if (logoImg) {
      const lh = 44
      const lw = Math.min(130, (logoImg.width / logoImg.height) * lh)
      page.drawImage(logoImg, { x: MARGIN_X, y: H - headerTop - lh, width: lw, height: lh })
      textX = MARGIN_X + lw + 14
      logoBottom = headerTop + lh
    }
    let markWidth = 0
    if (branding.draftMark) {
      const mark = pdfSafe(branding.draftMark)
      markWidth = bold.widthOfTextAtSize(mark, 9) + 12
      page.drawRectangle({
        x: W - MARGIN_X - markWidth, y: H - headerTop - 12, width: markWidth, height: 16,
        borderColor: DRAFT_RED, borderWidth: 1,
      })
      page.drawText(mark, { x: W - MARGIN_X - markWidth + 6, y: H - headerTop - 7.5, size: 9, font: bold, color: DRAFT_RED })
    }
    let y = headerTop + 10
    const legal = branding.legal
    if (legal?.name) {
      const nameW = W - MARGIN_X - textX - (markWidth ? markWidth + 8 : 0)
      for (const ln of wrap(bold, 12, legal.name, nameW)) {
        page.drawText(ln, { x: textX, y: H - y, size: 12, font: bold, color: accent })
        y += 13
      }
      for (const l of legalHeaderLines(legal)) {
        for (const ln of wrap(font, 7.5, l, W - MARGIN_X - textX)) {
          page.drawText(ln, { x: textX, y: H - y, size: 7.5, font, color: grey })
          y += 9.5
        }
      }
    }
    const sep = Math.max(y, logoBottom) + 6
    page.drawLine({ start: { x: MARGIN_X, y: H - sep }, end: { x: W - MARGIN_X, y: H - sep }, thickness: 1.2, color: accent })
    yTop = Math.max(TOP, sep + 18)
  }

  const raw = markdown.replace(/\r\n/g, '\n').split('\n')

  for (const lineRaw of raw) {
    const line = lineRaw.replace(/\s+$/g, '')

    if (line.trim() === '') { yTop += 7; continue }

    // Séparateur horizontal
    if (/^---+$/.test(line.trim())) {
      ensure(14)
      page.drawLine({ start: { x: MARGIN_X, y: H - yTop }, end: { x: W - MARGIN_X, y: H - yTop }, thickness: 0.8, color: accent })
      yTop += 12
      continue
    }

    // Titres
    if (line.startsWith('### ')) {
      ensure(20)
      yTop += 4
      para(stripInline(line.slice(4)), 11.5, oblique, accent)
      continue
    }
    if (line.startsWith('## ')) {
      ensure(24)
      yTop += 8
      para(stripInline(line.slice(3)), 13, bold, ink)
      continue
    }
    if (line.startsWith('# ')) {
      ensure(30)
      yTop += 6
      const t = stripInline(line.slice(2))
      for (const ln of wrap(bold, 18, t, MAX_W)) {
        ensure(24)
        drawCentered(ln, 18, bold, ink)
        yTop += 24
      }
      yTop += 6
      continue
    }

    // Lignes de tableau Markdown : | a | b | — on saute les séparateurs |---|
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1)
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue // ligne de séparation
      const joined = cells.map((c) => stripInline(c)).filter(Boolean).join('     |     ')
      para(joined, 10.5, font)
      continue
    }

    // Paragraphe normal — détecte un gras « plein ligne » (**…**) pour le mettre en gras
    const fullBold = /^\*\*[^*]+\*\*$/.test(line.trim())
    para(stripInline(line), 10.5, fullBold ? bold : font)
  }

  if (branding) {
    // Pied de page de CHAQUE page : mentions légales courtes + pagination.
    const pages = doc.getPages()
    const footLegal = branding.legal?.name ? legalShortLine(branding.legal) : ''
    const mark = branding.draftMark ? pdfSafe(branding.draftMark) : ''
    pages.forEach((p, i) => {
      const num = `Page ${i + 1} / ${pages.length}`
      const nw = font.widthOfTextAtSize(num, 7.5)
      p.drawLine({ start: { x: MARGIN_X, y: 36 }, end: { x: W - MARGIN_X, y: 36 }, thickness: 0.5, color: grey })
      if (footLegal) {
        const ln = wrap(font, 7, footLegal, MAX_W - nw - 16)[0] ?? ''
        p.drawText(ln, { x: MARGIN_X, y: 26, size: 7, font, color: grey })
      }
      if (mark) p.drawText(mark, { x: MARGIN_X, y: 16, size: 7, font: oblique, color: DRAFT_RED })
      p.drawText(num, { x: W - MARGIN_X - nw, y: 26, size: 7.5, font, color: grey })
    })
    return doc.save()
  }

  // Pied de page sur la dernière page
  ensure(30)
  yTop = H - BOTTOM + 18
  drawCentered('Document généré par NexusRH CI — propulsé par Claude AI', 8, font, grey)

  return doc.save()
}
