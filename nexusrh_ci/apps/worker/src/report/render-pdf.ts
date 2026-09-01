import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont, type Color } from 'pdf-lib'
import type { ReportData } from './types.js'
import type { Analysis, Slice } from './analyze.js'

/**
 * PDF joint : les vrais graphiques et le détail complet.
 *
 * `pdf-lib` est la bibliothèque déjà utilisée par l'API (bulletins,
 * organigramme, attestations). Les camemberts sont dessinés en chemins SVG :
 * pdf-lib n'a pas de primitive de secteur, `drawSvgPath` est la voie prévue.
 *
 * ⚠️ CONVENTION DE COORDONNÉES DE `drawSvgPath` (vérifié dans les sources
 * installées, `node_modules/pdf-lib/es/api/operations.js`) : l'appel
 * translate(x, y) PUIS scale(1, -1) est appliqué AVANT de tracer le chemin
 * (commentaire du fichier source : « SVG path Y axis is opposite pdf-lib's »).
 * Concrètement, un point local (px, py) du chemin atterrit sur la page en
 * (x + px, y - py) — le Y du chemin est donc inversé par rapport à l'espace
 * PDF (qui va vers le HAUT) et translaté par les options {x, y}, jamais par
 * des coordonnées absolues écrites dans le chemin lui-même.
 *
 * Le brief fournissait un chemin en coordonnées ABSOLUES de page (cx, cy déjà
 * égaux à la position visée) sans passer {x, y} à `drawSvgPath` — l'ancrage
 * retombe alors sur (page.x, page.y) = (0, 0), et le tracé se retrouve donc
 * en (0 + cx, 0 - cy) = (cx, -cy) : hors de la page (Y négatif), inversé.
 *
 * Correction retenue : le chemin du secteur est construit en coordonnées
 * LOCALES centrées sur l'origine (0,0), avec le Y local = -r·sin(angle) —
 * c'est-à-dire pré-inversé pour compenser le flip que `drawSvgPath` va
 * appliquer — et le centre réel (cx, cy) du camembert est fourni via les
 * options {x, y} de l'appel, qui subissent la translation SANS l'inversion.
 * Ainsi (x + px, y - py) = (cx + r·cosθ, cy - (-r·sinθ)) = (cx + r·cosθ,
 * cy + r·sinθ), soit exactement le point attendu en espace PDF standard.
 *
 * Le flag de balayage (« sweep-flag », dernier paramètre de la commande
 * elliptique `A`) dépend lui aussi de ce sens local : la spec SVG définit le
 * sweep=1 comme un angle croissant au sens mathématique usuel DANS L'ESPACE
 * DES COORDONNÉES ÉCRITES DANS LE CHEMIN (indépendamment de ce que ces
 * coordonnées représentent visuellement). Comme notre Y local est l'opposé
 * de l'angle réel (Y_local = -r·sinθ, soit un point situé à l'angle -θ dans
 * ce repère local), un angle θ croissant correspond à un angle LOCAL
 * décroissant → il faut donc sweep=0 (et non 1 comme dans le brief non
 * corrigé) pour obtenir un secteur qui balaye bien de `from` vers `to` dans
 * le sens trigonométrique une fois replacé en espace PDF. Vérifié
 * empiriquement en rendant un PDF d'essai et en l'inspectant (voir rapport
 * de tâche) : sweep=1 produisait un camembert à l'envers/déformé, sweep=0
 * produit des secteurs corrects, jointifs et dans le bon sens.
 */
const A4 = { w: 595.28, h: 841.89 }
const MARGE = 40
const MAX_DETAIL = 50 // borne du détail par entreprise (spec)

const NAVY = rgb(0x0f / 255, 0x2a / 255, 0x44 / 255)
const ORANGE = rgb(0xe8 / 255, 0x5d / 255, 0x04 / 255)
const SLATE = rgb(0x47 / 255, 0x55 / 255, 0x69 / 255)
const PALETTE: Color[] = [
  ORANGE, rgb(0.12, 0.5, 0.72), rgb(0.18, 0.65, 0.4), rgb(0.6, 0.35, 0.71),
  rgb(0.9, 0.75, 0.2), rgb(0.85, 0.33, 0.35), rgb(0.4, 0.45, 0.5),
]

/** Couleur de la palette pour l'index i, avec repli sûr (noUncheckedIndexedAccess). */
function couleur(i: number): Color {
  return PALETTE[i % PALETTE.length] ?? SLATE
}

/**
 * Secteur de camembert en chemin SVG, en coordonnées LOCALES centrées sur
 * l'origine (voir note de convention en tête de fichier). Le centre réel du
 * camembert est fourni séparément, via les options {x, y} de `drawSvgPath`.
 */
function secteurPath(r: number, from: number, to: number): string {
  const x1 = r * Math.cos(from)
  const y1 = -r * Math.sin(from) // Y local pré-inversé pour compenser le scale(1,-1) de drawSvgPath
  const x2 = r * Math.cos(to)
  const y2 = -r * Math.sin(to)
  const grand = to - from > Math.PI ? 1 : 0
  // sweep=0 : voir note de convention en tête de fichier (Y local inversé → sens de balayage inversé).
  return `M 0 0 L ${x1} ${y1} A ${r} ${r} 0 ${grand} 0 ${x2} ${y2} Z`
}

function camembert(page: PDFPage, font: PDFFont, x: number, y: number, r: number, slices: Slice[]): void {
  const total = slices.reduce((s, v) => s + v.value, 0)
  if (total === 0) {
    page.drawText('Aucune donnée', { x: x - r, y, size: 10, font, color: SLATE })
    return
  }
  let angle = -Math.PI / 2
  slices.forEach((s, i) => {
    const part = (s.value / total) * 2 * Math.PI
    page.drawSvgPath(secteurPath(r, angle, angle + part), {
      x, y, color: couleur(i), borderWidth: 0,
    })
    angle += part
  })
  slices.forEach((s, i) => {
    const ly = y + r - i * 14
    page.drawRectangle({ x: x + r + 16, y: ly, width: 9, height: 9, color: couleur(i) })
    page.drawText(`${s.label} (${s.value})`, { x: x + r + 30, y: ly, size: 9, font, color: SLATE })
  })
}

function barres(page: PDFPage, font: PDFFont, x: number, y: number, w: number, h: number, slices: Slice[]): void {
  if (slices.length === 0) {
    page.drawText('Aucune donnée', { x, y: y + h / 2, size: 10, font, color: SLATE })
    return
  }
  const max = Math.max(...slices.map((s) => s.value), 1)
  const pas = w / slices.length
  slices.forEach((s, i) => {
    const hb = Math.max(1, (s.value / max) * h)
    page.drawRectangle({ x: x + i * pas + 2, y, width: pas - 4, height: hb, color: ORANGE })
    page.drawText(String(s.value), { x: x + i * pas + 2, y: y + hb + 3, size: 7, font, color: SLATE })
    page.drawText(s.label.slice(5), { x: x + i * pas + 2, y: y - 10, size: 7, font, color: SLATE })
  })
}

export async function renderPdf(data: ReportData, a: Analysis): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let page = doc.addPage([A4.w, A4.h])
  let y = A4.h - MARGE

  const titre = data.period.type === 'weekly' ? 'Rapport hebdomadaire' : 'Rapport mensuel'
  page.drawText(`${titre} — ${data.period.label}`, { x: MARGE, y, size: 16, font: bold, color: NAVY })
  y -= 18
  page.drawText('NexusRH CI · OpenLab Consulting', { x: MARGE, y, size: 9, font, color: SLATE })
  y -= 30

  const t = a.totals
  for (const ligne of [
    `Entreprises : ${t.tenants} (${t.active} actives, ${t.trial} en essai, ${t.suspended} suspendues)`,
    `Nouvelles sur la période : ${t.newTenants}`,
    `Effectif consolidé : ${t.headcount} — ${t.hires} arrivées, ${t.departures} départs`,
    `Connexions : ${t.loginSuccess} réussies, ${t.loginFailed} échouées, ${t.loginLocked} verrouillages`,
  ]) {
    page.drawText(ligne, { x: MARGE, y, size: 10, font, color: NAVY })
    y -= 15
  }

  y -= 20
  page.drawText('Répartition par plan', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, MARGE + 70, y - 80, 55, a.byPlan)
  page.drawText('Part des cabinets', { x: A4.w / 2, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, A4.w / 2 + 70, y - 80, 55, a.agencyShare)
  y -= 190

  page.drawText('Connexions réussies par jour', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70, a.loginsByDay)
  y -= 130

  // Évolution sur 12 périodes — deux séries seulement (arrivées, connexions
  // réussies) : ce sont les seules reconstituables exactement depuis
  // employees.created_at et audit_log. L'effectif historique n'est pas
  // conservé et son estimation produirait un graphique faux avec l'apparence
  // du vrai — il n'est donc pas affiché ici.
  y -= 40
  page.drawText('Arrivées sur 12 périodes', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70,
    data.trend.map((p) => ({ label: p.label, value: p.hires })))
  y -= 130
  page.drawText('Connexions réussies sur 12 périodes', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70,
    data.trend.map((p) => ({ label: p.label, value: p.logins })))

  // Détail par entreprise, borné.
  const detail = [...data.tenants].sort((x, z) => z.headcount - x.headcount).slice(0, MAX_DETAIL)
  page = doc.addPage([A4.w, A4.h])
  y = A4.h - MARGE
  page.drawText('Détail par entreprise', { x: MARGE, y, size: 14, font: bold, color: NAVY })
  y -= 24
  for (const x of detail) {
    if (y < MARGE + 30) { page = doc.addPage([A4.w, A4.h]); y = A4.h - MARGE }
    const suffixe = x.collected ? '' : '  (données indisponibles)'
    page.drawText(`${x.name}${suffixe}`, { x: MARGE, y, size: 10, font: bold, color: NAVY })
    y -= 13
    page.drawText(
      `effectif ${x.headcount} · arrivées ${x.hires} · départs ${x.departures} · `
      + `connectés ${x.usersLoggedIn}/${x.activeUsers} · échecs ${x.loginFailed}`,
      { x: MARGE + 10, y, size: 9, font, color: SLATE },
    )
    y -= 18
  }
  if (data.tenants.length > MAX_DETAIL) {
    page.drawText(`… et ${data.tenants.length - MAX_DETAIL} autres entreprises (agrégées dans la vue plateforme).`,
      { x: MARGE, y, size: 9, font, color: SLATE })
  }

  return doc.save()
}
