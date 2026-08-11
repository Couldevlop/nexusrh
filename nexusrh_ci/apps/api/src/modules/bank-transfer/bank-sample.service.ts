/**
 * Import assisté — analyse du fichier exemple fourni par la banque.
 *
 * Le fichier sert à DEVINER la structure (en-têtes d'un tableur/CSV, positions
 * d'un texte à format fixe) et à PROPOSER un mapping. Il ne génère jamais rien
 * et n'est jamais conservé : on en extrait la structure, on jette les octets.
 *
 * SÉCURITÉ : un fichier fourni par l'utilisateur est la surface d'attaque la
 * plus exposée de cette feature.
 *  - Allowlist d'extensions (.xlsx/.csv/.txt), taille bornée, fichier vide refusé.
 *  - .xlsx = archive ZIP de XML : signature vérifiée avant ouverture, taille
 *    bornée en amont (bombe de décompression), toute erreur du parseur convertie
 *    en refus explicite plutôt qu'en 500.
 *  - Lecture bornée en lignes ET en colonnes (déni de service par fichier large).
 *  - AUCUN contenu de cellule n'est renvoyé au client : uniquement la structure.
 */
import ExcelJS from 'exceljs'
import {
  MAX_COLUMNS, type BankFileSegment, type OutputKind, type FileEncoding,
} from './bank-file.service.js'

export const MAX_SAMPLE_BYTES = 1024 * 1024 // 1 Mo
export const MAX_SAMPLE_LINES = 200
export const ALLOWED_SAMPLE_EXTENSIONS = ['xlsx', 'csv', 'txt'] as const
/** Longueur maximale d'un intitulé de colonne (alignée sur la validation des routes). */
export const MAX_LABEL_LENGTH = 120

/** Refus explicite d'un fichier exemple (→ 400, jamais 500). */
export class SampleRejectedError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'SampleRejectedError'
  }
}

// ── Proposition de mapping ───────────────────────────────────────────────────

/** Normalise un intitulé pour la comparaison : sans accent, sans ponctuation, en majuscules. */
function normalizeHeader(header: string): string {
  return header.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

/**
 * Règles de rapprochement, ORDONNÉES : la première qui correspond gagne.
 * L'ordre compte — « COMPTE_BENEF » désigne le compte, pas le bénéficiaire.
 */
const HEADER_RULES: Array<{ source: string; patterns: string[] }> = [
  { source: 'employee.iban', patterns: ['IBAN', 'RIB', 'COMPTE', 'CPTE', 'NUM COMPTE'] },
  { source: 'payslip.net_payable', patterns: ['MONTANT', 'NET A PAYER', 'NET PAYABLE', 'NET', 'SOMME', 'MNT'] },
  { source: 'employee.nni', patterns: ['NNI', 'CNI', 'IDENTITE NATIONALE'] },
  { source: 'employee.employee_number', patterns: ['MATRICULE', 'MATR'] },
  { source: 'employee.full_name', patterns: ['BENEFICIAIRE', 'BENEF', 'NOM COMPLET', 'NOM'] },
  { source: 'employee.first_name', patterns: ['PRENOM'] },
  { source: 'employee.bank_name', patterns: ['BANQUE', 'BANK', 'ETABLISSEMENT'] },
  { source: 'computed.value_date', patterns: ['DATE VALEUR', 'DATE DE VALEUR', 'DATE'] },
  { source: 'payslip.month', patterns: ['PERIODE', 'MOIS'] },
  { source: 'literal', patterns: ['LIBELLE', 'MOTIF', 'OBJET'] },
]

/**
 * Intitulés de zones techniques : « ZONE_RESERVEE_BANQUE » contient le mot
 * « BANQUE » sans désigner la banque. Sans cette liste, la comparaison par
 * mots proposerait un mapping faux — et un mapping faux fait rejeter le
 * fichier par la banque, ce qui est pire que « à mapper ».
 */
const RESERVED_HEAD_WORDS = ['ZONE', 'RESERVE', 'RESERVEE', 'RESERVED', 'FILLER', 'LIBRE', 'BLANC', 'VIDE', 'SPARE']

/** Le motif apparaît-il comme suite de MOTS entiers dans l'intitulé ? */
function matchesWords(headerWords: string[], pattern: string): boolean {
  const p = pattern.split(' ')
  for (let i = 0; i + p.length <= headerWords.length; i++) {
    if (p.every((w, j) => headerWords[i + j] === w)) return true
  }
  return false
}

/** Propose une source pour un intitulé, ou 'unmapped' — jamais de devinette silencieuse. */
export function suggestSourceForHeader(header: string): BankFileSegment['source'] {
  const norm = normalizeHeader(header ?? '')
  if (!norm) return 'unmapped'
  const words = norm.split(' ')
  if (RESERVED_HEAD_WORDS.includes(words[0]!)) return 'unmapped'
  for (const rule of HEADER_RULES) {
    if (rule.patterns.some((p) => matchesWords(words, p))) return rule.source
  }
  return 'unmapped'
}

// ── Détection de structure ───────────────────────────────────────────────────

const CANDIDATE_DELIMITERS = [';', ',', '\t', '|'] as const

/** Séparateur majoritaire sur les premières lignes ; point-virgule par défaut (usage CI). */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 10)
  let best = ';'
  let bestCount = 0
  for (const d of CANDIDATE_DELIMITERS) {
    const count = lines.reduce((s, l) => s + l.split(d).length - 1, 0)
    if (count > bestCount) { best = d; bestCount = count }
  }
  return bestCount > 0 ? best : ';'
}

export interface FixedColumn { start: number; width: number }

/**
 * Déduit les colonnes d'un texte à format fixe : une position est un séparateur
 * si elle est vide sur TOUTES les lignes. Les tranches restantes sont les champs.
 */
export function detectFixedColumns(lines: string[]): FixedColumn[] {
  const rows = lines.filter((l) => l.trim().length > 0)
  if (rows.length === 0) return []
  const width = Math.max(...rows.map((l) => l.length))
  const isSeparator: boolean[] = []
  for (let i = 0; i < width; i++) {
    isSeparator[i] = rows.every((l) => (l[i] ?? ' ') === ' ')
  }
  const cols: FixedColumn[] = []
  let start = -1
  for (let i = 0; i < width; i++) {
    if (!isSeparator[i] && start < 0) start = i
    if (isSeparator[i] && start >= 0) { cols.push({ start, width: i - start }); start = -1 }
  }
  if (start >= 0) cols.push({ start, width: width - start })
  return cols
}

// ── Analyse complète ─────────────────────────────────────────────────────────

export interface SampleAnalysis {
  filename: string
  output: OutputKind
  encoding: FileEncoding
  delimiter?: string
  /** Colonnes proposées — structure uniquement, aucune donnée de cellule. */
  columns: BankFileSegment[]
  unmappedCount: number
  linesRead: number
  truncated: boolean
}

/**
 * Décode un fichier texte : UTF-8 si les octets en sont (BOM retiré), sinon
 * ISO-8859-1. Le caractère de remplacement U+FFFD signale un décodage UTF-8
 * qui a échoué — c'est le seul indice fiable sans en-tête d'encodage.
 */
export function decodeText(buffer: Buffer): { text: string; encoding: FileEncoding } {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('�')) return { text: utf8.replace(/^﻿/, ''), encoding: 'utf8' }
  return { text: buffer.toString('latin1'), encoding: 'latin1' }
}

function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename ?? '')
  return (m?.[1] ?? '').toLowerCase()
}

/** Segment de remplissage reproduisant les espaces entre deux champs à positions fixes. */
function fillerSegment(width: number): BankFileSegment {
  return { label: '', source: 'literal', literal: ' ', pad: { width, align: 'left', char: ' ' } }
}

/** Une ligne d'en-tête porte au moins DEUX libellés distincts (cf. analyzeXlsx). */
function estLigneEntete(champs: string[]): boolean {
  const remplis = champs.map((c) => c.trim()).filter((c) => c.length > 0)
  return remplis.length >= 2 && new Set(remplis).size >= 2
}

function analyzeDelimited(text: string, output: OutputKind, encoding: FileEncoding, filename: string): SampleAnalysis {
  const lines = text.split(/\r?\n/).slice(0, MAX_SAMPLE_LINES)
  const delimiter = detectDelimiter(text)
  const decoupe = (l: string): string[] => l.split(delimiter).map((h) => h.replace(/^"|"$/g, '').trim())
  // Un modèle bancaire peut commencer par une ligne de titre (« Ordre de
  // virement — SGCI — mai 2026 ») : elle ne produit qu'un seul champ rempli et
  // ne doit pas être prise pour les en-têtes.
  const headerLine = lines.find((l) => l.trim().length > 0 && estLigneEntete(decoupe(l)))
    ?? lines.find((l) => l.trim().length > 0)
    ?? ''
  const rawHeaders = decoupe(headerLine)
  const truncated = rawHeaders.length > MAX_COLUMNS
  const headers = rawHeaders.slice(0, MAX_COLUMNS)
  const columns: BankFileSegment[] = headers.map((h) => {
    const source = suggestSourceForHeader(h)
    const seg: BankFileSegment = { label: h.slice(0, MAX_LABEL_LENGTH), source }
    if (source === 'literal') seg.literal = 'SALAIRE {mois}'
    return seg
  })
  return {
    filename, output, encoding, delimiter, columns,
    unmappedCount: columns.filter((c) => c.source === 'unmapped').length,
    linesRead: lines.length, truncated,
  }
}

function analyzeFixed(text: string, encoding: FileEncoding, filename: string): SampleAnalysis {
  const lines = text.split(/\r?\n/).slice(0, MAX_SAMPLE_LINES)
  const detected = detectFixedColumns(lines)
  const truncated = detected.length > MAX_COLUMNS
  const fields = detected.slice(0, MAX_COLUMNS)

  // Les espaces séparant les champs font partie du format : sans elles, toutes
  // les positions du fichier régénéré se décalent.
  const columns: BankFileSegment[] = []
  let cursor = 0
  fields.forEach((f, i) => {
    if (f.start > cursor) columns.push(fillerSegment(f.start - cursor))
    columns.push({
      label: `Colonne ${i + 1}`, source: 'unmapped',
      pad: { width: f.width, align: 'left', char: ' ' },
    })
    cursor = f.start + f.width
  })

  return {
    filename, output: 'fixed', encoding, columns,
    unmappedCount: columns.filter((c) => c.source === 'unmapped').length,
    linesRead: lines.length, truncated,
  }
}

async function analyzeXlsx(buffer: Buffer, filename: string): Promise<SampleAnalysis> {
  // Signature ZIP ("PK\x03\x04") : un .xlsx qui n'en est pas un est refusé avant
  // d'atteindre le parseur.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new SampleRejectedError('Ce fichier n\'est pas un classeur Excel valide.')
  }
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    throw new SampleRejectedError('Classeur illisible. Enregistrez-le au format .xlsx et réessayez.')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new SampleRejectedError('Le classeur ne contient aucune feuille.')

  // Les modèles bancaires commencent presque toujours par une ligne de TITRE
  // (« Ordre de virement — Banque — Période… »), souvent dans une cellule
  // fusionnée. ExcelJS restitue alors la même valeur dans TOUTES les cellules
  // de la fusion : prendre la première ligne non vide fabriquerait autant de
  // colonnes que la fusion en couvre, toutes intitulées avec le titre entier.
  // Une vraie ligne d'en-tête porte au moins DEUX libellés DISTINCTS.
  const estLigneEntete = (cells: string[]): boolean => {
    const remplies = cells.map((c) => c.trim()).filter((c) => c.length > 0)
    return remplies.length >= 2 && new Set(remplies).size >= 2
  }
  const lireLigne = (r: number): string[] => {
    const values = ws.getRow(r).values
    return Array.isArray(values) ? values.slice(1).map((v) => (v === null || v === undefined ? '' : String(v))) : []
  }

  let headers: string[] = []
  let repli: string[] = []
  let linesRead = 0
  for (let r = 1; r <= Math.min(ws.rowCount, MAX_SAMPLE_LINES); r++) {
    linesRead++
    const cells = lireLigne(r)
    if (repli.length === 0 && cells.some((c) => c.trim().length > 0)) repli = cells
    if (estLigneEntete(cells)) { headers = cells; break }
  }
  // Repli : classeur à une seule colonne, ou en-tête atypique.
  if (headers.length === 0) headers = repli
  if (headers.length === 0) throw new SampleRejectedError('Aucune ligne d\'en-tête trouvée dans le classeur.')

  const truncated = headers.length > MAX_COLUMNS
  const columns: BankFileSegment[] = headers.slice(0, MAX_COLUMNS).map((h) => {
    const source = suggestSourceForHeader(h)
    const seg: BankFileSegment = { label: h.trim().slice(0, MAX_LABEL_LENGTH), source }
    if (source === 'literal') seg.literal = 'SALAIRE {mois}'
    return seg
  })
  return {
    filename, output: 'xlsx', encoding: 'utf8', columns,
    unmappedCount: columns.filter((c) => c.source === 'unmapped').length,
    linesRead, truncated,
  }
}

/** Point d'entrée : analyse le fichier exemple et propose une structure. */
export async function analyzeSample(filename: string, buffer: Buffer): Promise<SampleAnalysis> {
  const ext = extensionOf(filename)
  if (!(ALLOWED_SAMPLE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new SampleRejectedError('Format non autorisé. Accepté : .xlsx, .csv, .txt.')
  }
  if (buffer.byteLength === 0) throw new SampleRejectedError('Fichier vide.')
  if (buffer.byteLength > MAX_SAMPLE_BYTES) {
    throw new SampleRejectedError(`Fichier trop volumineux (max ${Math.round(MAX_SAMPLE_BYTES / 1024)} Ko).`)
  }

  const safeName = (filename ?? '').replace(/[^A-Za-z0-9_.-]+/g, '').slice(0, 120)
  if (ext === 'xlsx') return analyzeXlsx(buffer, safeName)

  if (ext === 'csv') {
    // Les intitulés portent des accents (« Bénéficiaire », « Libellé ») et
    // servent au rapprochement : un décodage à l'aveugle en ISO-8859-1 d'un
    // fichier UTF-8 les transforme en mojibake et fait échouer TOUT le mapping.
    const { text, encoding } = decodeText(buffer)
    return analyzeDelimited(text, 'csv', encoding, safeName)
  }
  // Un .txt à positions fixes est ORIENTÉ OCTETS : les largeurs déclarées par la
  // banque comptent des octets, pas des caractères. On lit donc en ISO-8859-1
  // (1 octet = 1 caractère), sans quoi un accent en UTF-8 décalerait toutes les
  // positions détectées.
  return analyzeFixed(buffer.toString('latin1'), 'latin1', safeName)
}
