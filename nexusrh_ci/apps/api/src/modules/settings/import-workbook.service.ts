/**
 * Lecture d'un classeur Excel déposé pour la reprise de données.
 *
 * Le client renvoie souvent le modèle « enregistré sous » depuis Excel, donc en
 * .xlsx — un format que le navigateur ne sait pas lire sans embarquer une
 * bibliothèque entière. Le classeur est donc lu ICI, puis rendu sous la MÊME
 * forme qu'un CSV (`{ headers, rows }`) : le chemin d'écriture de l'import,
 * avec sa liste blanche de types, sa validation et sa piste d'audit, ne change
 * pas d'une ligne et ne voit jamais la différence.
 *
 * Le fichier n'est jamais conservé : on en extrait les cellules, on jette les
 * octets.
 */
import ExcelJS from 'exceljs'

/** Classeur refusé pour une raison que l'utilisateur peut corriger lui-même. */
export class WorkbookRejectedError extends Error {}

/** Mêmes plafonds que l'import CSV : un .xlsx ne doit pas ouvrir une porte plus large. */
export const WORKBOOK_MAX_HEADERS = 50
export const WORKBOOK_MAX_ROWS = 10_000

export interface WorkbookTable {
  headers: string[]
  rows: string[][]
}

/**
 * Rend une cellule en texte, comme le ferait un CSV.
 *
 * Excel typé est un piège de reprise : une date y est un objet, un montant un
 * nombre, un email une formule d'hyperlien. Le handler d'import, lui, attend
 * des chaînes et fait ses propres conversions — lui rendre autre chose
 * déplacerait la conversion dans deux endroits à la fois.
 */
function celluleEnTexte(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return ''
  if (valeur instanceof Date) {
    // Format ISO court : c'est ce que le handler attend (`toDate`) et ce que
    // porte le modèle CSV. L'heure n'a pas de sens pour une date d'embauche.
    return valeur.toISOString().slice(0, 10)
  }
  if (typeof valeur === 'object') {
    const o = valeur as { text?: unknown; result?: unknown; richText?: { text?: string }[]; hyperlink?: unknown }
    // Hyperlien : Excel transforme un email saisi en lien. `text` porte le
    // libellé affiché, qui est l'adresse elle-même.
    if (typeof o.text === 'string') return o.text.trim()
    if (Array.isArray(o.richText)) return o.richText.map((p) => p.text ?? '').join('').trim()
    // Formule : seul le résultat calculé nous intéresse.
    if (o.result !== undefined && o.result !== null) return celluleEnTexte(o.result)
    return ''
  }
  return String(valeur).trim()
}

/**
 * Lit la première feuille d'un classeur et la rend comme un CSV.
 *
 * La première ligne non vide fait l'en-tête : contrairement aux modèles
 * bancaires, le fichier attendu ici est le modèle TÉLÉCHARGÉ depuis
 * l'application, dont la première ligne est l'en-tête. On ne devine rien.
 */
export async function lireClasseurImport(buffer: Buffer): Promise<WorkbookTable> {
  // Signature ZIP (« PK\x03\x04 ») : un .xlsx qui n'en est pas un est écarté
  // avant d'atteindre le parseur.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new WorkbookRejectedError('Ce fichier n\'est pas un classeur Excel valide.')
  }

  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    throw new WorkbookRejectedError('Classeur illisible. Enregistrez-le au format .xlsx et réessayez.')
  }

  const ws = wb.worksheets[0]
  if (!ws) throw new WorkbookRejectedError('Le classeur ne contient aucune feuille.')

  const lireLigne = (r: number): string[] => {
    const values = ws.getRow(r).values
    const brut = Array.isArray(values) ? values.slice(1) : []
    // Array.from() DENSIFIE : ExcelJS rend un tableau CREUX dès qu'une cellule
    // est vide, et `.map()` saute les trous — les colonnes suivantes se
    // décaleraient alors d'un cran, ce qui mettrait la ville dans le matricule.
    return Array.from({ length: brut.length }, (_, i) => celluleEnTexte(brut[i]))
  }

  // En-tête : la première ligne qui porte au moins une cellule remplie.
  let entete: string[] = []
  let ligneEntete = 0
  const dernière = Math.min(ws.rowCount, WORKBOOK_MAX_ROWS + 1)
  for (let r = 1; r <= dernière; r++) {
    const cells = lireLigne(r)
    if (cells.some((c) => c.length > 0)) { entete = cells; ligneEntete = r; break }
  }
  if (entete.length === 0) throw new WorkbookRejectedError('Le classeur est vide.')

  // Une colonne sans intitulé ne peut correspondre à rien : la garder
  // décalerait la lecture des suivantes côté handler.
  while (entete.length > 0 && entete[entete.length - 1] === '') entete.pop()
  if (entete.length > WORKBOOK_MAX_HEADERS) {
    throw new WorkbookRejectedError(`Trop de colonnes (max ${WORKBOOK_MAX_HEADERS}).`)
  }

  const rows: string[][] = []
  for (let r = ligneEntete + 1; r <= ws.rowCount; r++) {
    if (rows.length >= WORKBOOK_MAX_ROWS) {
      throw new WorkbookRejectedError(`Trop de lignes (max ${WORKBOOK_MAX_ROWS}).`)
    }
    const cells = lireLigne(r).slice(0, entete.length)
    // Ligne entièrement vide : Excel en laisse traîner sous les données.
    if (!cells.some((c) => c.length > 0)) continue
    // Aligne sur l'en-tête : le handler lit par index de colonne.
    while (cells.length < entete.length) cells.push('')
    rows.push(cells)
  }
  if (rows.length === 0) throw new WorkbookRejectedError('Le classeur ne contient aucune ligne de données.')

  return { headers: entete, rows }
}
