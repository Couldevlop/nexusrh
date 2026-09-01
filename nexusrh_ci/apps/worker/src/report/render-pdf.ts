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
 *
 * ⚠️ ENCODAGE : Helvetica (police standard PDF) n'encode que WinAnsi. Un nom
 * d'entreprise contenant `ɛ`, `ɔ` ou `ŋ` (orthographes baoulé et dioula), un
 * emoji ou un idéogramme faisait LEVER pdf-lib au premier `drawText` — donc
 * échouer `renderPdf`, donc ne JAMAIS envoyer le rapport, à cause d'un seul
 * nom saisi par un client. Toute chaîne venant de la base passe donc par
 * `texte()`, qui assainit ET borne la longueur (patron déjà en place dans
 * l'API : payroll/payslip-pdf.ts, org-chart/org-chart-pdf.ts,
 * recruitment/hr-document-pdf.ts).
 */
const A4 = { w: 595.28, h: 841.89 }
const MARGE = 40
const MAX_DETAIL = 50 // borne du détail par entreprise (spec)

const NAVY = rgb(0x0f / 255, 0x2a / 255, 0x44 / 255)
const ORANGE = rgb(0xe8 / 255, 0x5d / 255, 0x04 / 255)
const SLATE = rgb(0x47 / 255, 0x55 / 255, 0x69 / 255)
const ROUGE = rgb(0xb9 / 255, 0x1c / 255, 0x1c / 255)
const PALETTE: Color[] = [
  ORANGE, rgb(0.12, 0.5, 0.72), rgb(0.18, 0.65, 0.4), rgb(0.6, 0.35, 0.71),
  rgb(0.9, 0.75, 0.2), rgb(0.85, 0.33, 0.35), rgb(0.4, 0.45, 0.5),
]

/**
 * Assainit et borne une chaîne venant de la base avant tout `drawText`.
 *
 * 1. Les caractères typographiques usuels sont ramenés à leur équivalent
 *    ASCII (tirets, guillemets, points de suspension) plutôt que remplacés
 *    par un `?` qui abîmerait la lecture.
 * 2. Tout ce qui reste hors WinAnsi (code > 0xFF) devient `?` : c'est ce qui
 *    empêche pdf-lib de lever et donc le rapport d'être perdu.
 * 3. La longueur est bornée DANS LA MÊME PASSE : un nom d'entreprise très
 *    long débordait de la page et venait chevaucher la colonne voisine.
 */
export function texte(s: string, max = 60): string {
  const mappe = (s ?? '')
    .replace(/[—–]/g, '-')
    .replace(/[’‘‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/…/g, '...')
  let out = ''
  for (const ch of mappe) out += ch.charCodeAt(0) <= 0xff ? ch : '?'
  return out.length > max ? `${out.slice(0, max - 1)}.` : out
}

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
    // Légende bornée court : elle est collée au camembert, un libellé long
    // sortirait de la page.
    page.drawText(texte(`${s.label} (${s.value})`, 28), { x: x + r + 30, y: ly, size: 9, font, color: SLATE })
  })
}

/** Libellé d'axe par défaut : 'YYYY-MM-DD' → 'MM-DD' (les séries de jours). */
function libelleJour(s: Slice): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.label) ? s.label.slice(5) : s.label
}

function barres(
  page: PDFPage, font: PDFFont, x: number, y: number, w: number, h: number, slices: Slice[],
  libelle: (s: Slice) => string = libelleJour,
): void {
  if (slices.length === 0) {
    page.drawText('Aucune donnée', { x, y: y + h / 2, size: 10, font, color: SLATE })
    return
  }
  const max = Math.max(...slices.map((s) => s.value), 1)
  const pas = w / slices.length
  // Un libellé plus large que le pas chevaucherait le voisin : on le borne au
  // nombre de caractères que la colonne peut porter à cette taille de police.
  const maxCar = Math.max(3, Math.floor(pas / 4))
  slices.forEach((s, i) => {
    const hb = Math.max(1, (s.value / max) * h)
    page.drawRectangle({ x: x + i * pas + 2, y, width: pas - 4, height: hb, color: ORANGE })
    page.drawText(String(s.value), { x: x + i * pas + 2, y: y + hb + 3, size: 7, font, color: SLATE })
    page.drawText(texte(libelle(s), maxCar), { x: x + i * pas + 2, y: y - 10, size: 7, font, color: SLATE })
  })
}

/** Variation signée : « +3 » et « -3 » ne doivent pas se lire pareil. */
function signe(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function dateCourte(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : 'jamais'
}

export async function renderPdf(data: ReportData, a: Analysis): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let page = doc.addPage([A4.w, A4.h])
  let y = A4.h - MARGE

  const titre = data.period.type === 'weekly' ? 'Rapport hebdomadaire' : 'Rapport mensuel'
  page.drawText(texte(`${titre} — ${data.period.label}`, 80), { x: MARGE, y, size: 16, font: bold, color: NAVY })
  y -= 18
  page.drawText('NexusRH CI · OpenLab Consulting', { x: MARGE, y, size: 9, font, color: SLATE })
  y -= 30

  const t = a.totals
  for (const ligne of [
    `Entreprises : ${t.tenants} (${t.active} actives, ${t.trial} en essai, ${t.suspended} suspendues)`,
    `Nouvelles sur la période : ${t.newTenants}`,
    `Effectif consolidé : ${t.headcount} — variation ${signe(t.headcountChange)} `
      + `(${t.hires} arrivées, ${t.departures} départs)`,
    `Connexions réussies : ${t.loginSuccess} · comptes connectés ${t.usersLoggedIn}/${t.activeUsers}`,
    // Libellé explicite : ces échecs viennent de l'audit PLATEFORME et ne sont
    // pas attribuables à une entreprise (voir collect.collectPlatformAuth).
    `Échecs de connexion, ensemble de la plateforme : ${t.loginFailed} échecs, `
      + `${t.loginLocked} verrouillages`,
    `Refus « entreprise hors ligne » : ${t.blockedOffline} · MFA requise : ${t.mfaRequired}`,
    `Volume d'activité : ${t.auditWrites} écritures d'audit`,
  ]) {
    page.drawText(texte(ligne, 110), { x: MARGE, y, size: 10, font, color: NAVY })
    y -= 15
  }

  y -= 20
  page.drawText('Répartition par plan', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, MARGE + 70, y - 80, 55, a.byPlan)
  page.drawText('Part des cabinets', { x: A4.w / 2, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, A4.w / 2 + 70, y - 80, 55, a.agencyShare)
  y -= 190

  page.drawText('Répartition par secteur', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, MARGE + 70, y - 80, 55, a.bySector)
  page.drawText('Arrivées par type de contrat', { x: A4.w / 2, y, size: 11, font: bold, color: NAVY })
  barres(page, font, A4.w / 2, y - 90, A4.w / 2 - MARGE, 70, a.byContract, (s) => s.label)
  y -= 190

  page.drawText('Connexions réussies par jour', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70, a.loginsByDay)

  // Évolution sur 12 périodes — deux séries seulement (arrivées, connexions
  // réussies) : ce sont les seules reconstituables exactement depuis
  // employees.hire_date et audit_log. L'effectif historique n'est pas
  // conservé et son estimation produirait un graphique faux avec l'apparence
  // du vrai — il n'est donc pas affiché ici.
  page = doc.addPage([A4.w, A4.h])
  y = A4.h - MARGE
  page.drawText('Arrivées sur 12 périodes', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70,
    data.trend.map((p) => ({ label: p.label, value: p.hires })))
  y -= 130
  page.drawText('Connexions réussies sur 12 périodes', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70,
    data.trend.map((p) => ({ label: p.label, value: p.logins })))
  y -= 150

  // Signaux d'attention : ils figuraient dans le mail mais pas dans le PDF —
  // or c'est le PDF qui est archivé et relu plus tard.
  page.drawText('Points d\'attention', { x: MARGE, y, size: 14, font: bold, color: NAVY })
  y -= 20
  if (a.alerts.length === 0) {
    page.drawText('Aucun point d\'attention sur la période.', { x: MARGE, y, size: 10, font, color: SLATE })
  }
  for (const al of a.alerts) {
    if (y < MARGE + 20) { page = doc.addPage([A4.w, A4.h]); y = A4.h - MARGE }
    page.drawText(texte(`• ${al.tenant} — ${al.detail}`, 100), {
      x: MARGE, y, size: 9, font, color: al.severity === 'high' ? ROUGE : SLATE,
    })
    y -= 13
  }

  // Détail par entreprise, borné.
  const detail = [...data.tenants].sort((x, z) => z.headcount - x.headcount).slice(0, MAX_DETAIL)
  page = doc.addPage([A4.w, A4.h])
  y = A4.h - MARGE
  page.drawText('Détail par entreprise', { x: MARGE, y, size: 14, font: bold, color: NAVY })
  y -= 24
  for (const x of detail) {
    if (y < MARGE + 30) { page = doc.addPage([A4.w, A4.h]); y = A4.h - MARGE }
    const suffixe = x.collected ? '' : '  (données indisponibles)'
    page.drawText(texte(`${x.name}${suffixe}`, 70), { x: MARGE, y, size: 10, font: bold, color: NAVY })
    y -= 13
    page.drawText(
      texte(
        `effectif ${x.headcount} · arrivées ${x.hires} · départs ${x.departures} · `
        + `connectés ${x.usersLoggedIn}/${x.activeUsers} · dernière connexion ${dateCourte(x.lastLoginAt)} · `
        + `${x.auditWrites} écritures`,
        120,
      ),
      { x: MARGE + 10, y, size: 9, font, color: SLATE },
    )
    y -= 18
  }
  if (data.tenants.length > MAX_DETAIL) {
    page.drawText(
      texte(`… et ${data.tenants.length - MAX_DETAIL} autres entreprises (agrégées dans la vue plateforme).`, 100),
      { x: MARGE, y, size: 9, font, color: SLATE },
    )
  }

  return doc.save()
}
