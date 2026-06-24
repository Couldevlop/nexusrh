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

export async function renderHrDocumentPdf(markdown: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique)
  const ink = rgb(0.12, 0.12, 0.15)
  const accent = rgb(0.10, 0.40, 0.30)
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

  // Pied de page sur la dernière page
  ensure(30)
  yTop = H - BOTTOM + 18
  drawCentered('Document généré par NexusRH CI — propulsé par Claude AI', 8, font, grey)

  return doc.save()
}
