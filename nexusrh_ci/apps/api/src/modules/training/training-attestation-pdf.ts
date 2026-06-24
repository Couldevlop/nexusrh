/**
 * Attestation de formation (FRM-007) — PDF généré « from scratch » via pdf-lib
 * (déjà dépendance : cf. payslip-pdf.ts). A4 portrait. pdf-lib a un repère
 * bas-gauche → on inverse l'axe Y. Helvetica n'encode que WinAnsi : pdfSafe
 * neutralise les caractères hors plage pour éviter une exception d'encodage.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export interface AttestationPdfData {
  tenantName:    string
  employeeName:  string
  trainingTitle: string
  duration?:     number | null
  durationUnit?: string | null
  sessionStart?: string | null   // YYYY-MM-DD
  sessionEnd?:   string | null
  location?:     string | null
  trainer?:      string | null
  completedAt?:  string | null    // ISO
  city?:         string | null
}

function pdfSafe(s: string): string {
  // Remplace les caractères hors WinAnsi par un équivalent ASCII proche.
  return (s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/€/g, 'EUR')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\xFF]/g, '?')
}

function fmtDate(d?: string | null): string {
  if (!d) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d
}

export async function renderAttestationPdf(data: AttestationPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89]) // A4 portrait
  const W = 595.28
  const H = 841.89
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ink = rgb(0.12, 0.12, 0.15)
  const accent = rgb(0.10, 0.40, 0.30)

  const toY = (yTop: number) => H - yTop
  const text = (s: string, x: number, yTop: number, size: number, f = font, color = ink) =>
    page.drawText(pdfSafe(s), { x, y: toY(yTop), size, font: f, color })
  const center = (s: string, yTop: number, size: number, f = font, color = ink) => {
    const safe = pdfSafe(s)
    const w = f.widthOfTextAtSize(safe, size)
    page.drawText(safe, { x: (W - w) / 2, y: toY(yTop), size, font: f, color })
  }

  // Cadre
  page.drawRectangle({ x: 28, y: 28, width: W - 56, height: H - 56, borderColor: accent, borderWidth: 1.5 })

  // En-tête
  center(data.tenantName, 90, 16, bold, accent)
  center('ATTESTATION DE FORMATION', 140, 22, bold, ink)
  page.drawLine({ start: { x: 150, y: toY(160) }, end: { x: W - 150, y: toY(160) }, thickness: 1, color: accent })

  // Corps
  let y = 220
  text('Nous attestons que :', 70, y, 12); y += 40
  center(data.employeeName, y, 18, bold, ink); y += 50
  text('a suivi avec succès la formation suivante :', 70, y, 12); y += 36
  center(`« ${data.trainingTitle} »`, y, 15, bold, accent); y += 50

  const dur = data.duration ? `${data.duration} ${data.durationUnit || 'heures'}` : '—'
  const period = data.sessionEnd && data.sessionEnd !== data.sessionStart
    ? `${fmtDate(data.sessionStart)} au ${fmtDate(data.sessionEnd)}`
    : fmtDate(data.sessionStart)
  const rows: Array<[string, string]> = [
    ['Durée', dur],
    ['Période', period],
    ['Lieu', data.location || '—'],
    ['Formateur', data.trainer || '—'],
    ['Date de fin', fmtDate((data.completedAt || '').slice(0, 10) || null)],
  ]
  for (const [k, v] of rows) {
    text(k, 90, y, 11, bold)
    text(v, 230, y, 11)
    y += 26
  }

  // Pied
  const issued = fmtDate(new Date().toISOString().slice(0, 10))
  text(`Fait à ${data.city || 'Abidjan'}, le ${issued}.`, 70, H - 150, 11)
  text('Le Responsable des Ressources Humaines', 70, H - 110, 11, bold)
  center('Document généré par NexusRH — propulsé par Claude AI', H - 60, 8, font, rgb(0.5, 0.5, 0.55))

  return doc.save()
}
