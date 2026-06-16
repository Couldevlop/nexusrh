/**
 * Rendu PDF de l'organigramme via pdf-lib (déjà dépendance du projet — cf.
 * services/rns-pdf.ts). Séparé du service « domain » pour garder ce dernier
 * pur et sans dépendance (tests unitaires rapides).
 *
 * pdf-lib a un repère bas-gauche : on inverse l'axe Y (pdfY = H - y).
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Layout } from './org-chart.service.js'

const HEADER_H = 44

/** pdf-lib (police standard Helvetica) n'encode que WinAnsi : on neutralise
 *  tout caractère hors plage pour éviter une exception d'encodage. */
function pdfSafe(s: string): string {
  let out = ''
  for (const ch of s) {
    out += ch.charCodeAt(0) <= 0xff ? ch : '?'
  }
  return out
}

export async function renderOrgChartPdf(layout: Layout, title: string): Promise<Uint8Array> {
  const { nodes, edges, width, height } = layout
  const totalH = height + HEADER_H

  const doc = await PDFDocument.create()
  const page = doc.addPage([width, totalH])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

  const navy = rgb(0x0f / 255, 0x2a / 255, 0x44 / 255)
  const accent = rgb(0xe8 / 255, 0x5d / 255, 0x04 / 255)
  const boxFill = rgb(0xf8 / 255, 0xfa / 255, 0xfc / 255)
  const slate = rgb(0x47 / 255, 0x55 / 255, 0x69 / 255)
  const line = rgb(0x94 / 255, 0xa3 / 255, 0xb8 / 255)

  // Repère : on convertit une coordonnée "haut-gauche" (y vers le bas) en
  // coordonnée pdf-lib (y vers le haut). off décale sous l'en-tête.
  const off = HEADER_H
  const toPdfY = (yTop: number) => totalH - yTop

  // Titre
  page.drawText(pdfSafe(title), { x: 28, y: totalH - 28, size: 16, font: fontBold, color: navy })

  // Liens parent → enfant
  for (const e of edges) {
    page.drawLine({
      start: { x: e.x1, y: toPdfY(e.y1 + off) },
      end: { x: e.x2, y: toPdfY(e.y2 + off) },
      thickness: 1.2,
      color: line,
    })
  }

  // Boîtes + textes
  for (const n of nodes) {
    page.drawRectangle({
      x: n.x,
      y: toPdfY(n.y + off + n.h),
      width: n.w,
      height: n.h,
      color: boxFill,
      borderColor: accent,
      borderWidth: 1.2,
    })
    n.lines.forEach((rawLine, i) => {
      const fy = toPdfY(n.y + off + 18 + i * 14)
      page.drawText(pdfSafe(rawLine), {
        x: n.x + 10,
        y: fy,
        size: i === 0 ? 10.5 : 9,
        font: i === 0 ? fontBold : font,
        color: i === 0 ? navy : slate,
      })
    })
  }

  return doc.save()
}
