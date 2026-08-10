/**
 * Moteur de génération des fichiers de virement bancaire — logique PURE.
 *
 * Chaque banque impose son propre format (tableur à colonnes variables, ou
 * fichier texte à positions fixes). Plutôt qu'un gabarit figé, le tenant décrit
 * le format de SA banque dans un « profil » (données JSON en base) que ce
 * service applique. Aucune dépendance Fastify/DB → intégralement testable.
 *
 * SÉCURITÉ (le paramétrage est une surface d'attaque à part entière) :
 *  - Catalogue de sources FERMÉ : aucune expression n'est évaluée (pas d'eval,
 *    pas de moteur de gabarit Turing-complet), et aucune regex n'est fournie
 *    par l'utilisateur (ce serait un ReDoS offert au rôle admin).
 *  - Injection de formule CSV neutralisée (OWASP) — sauf en format fixe, où
 *    préfixer une apostrophe décalerait toutes les positions : on tronque à la
 *    largeur déclarée, ce qui neutralise tout autant côté tableur.
 *  - Nom de fichier durci : jetons résolus puis filtrage strict (ni traversée
 *    de chemin, ni injection d'en-tête Content-Disposition).
 *  - Montants FCFA ENTIERS (règle CI : zéro décimale).
 */
import ExcelJS from 'exceljs'

// ── Formats de sortie ────────────────────────────────────────────────────────

export const OUTPUT_KINDS = ['xlsx', 'csv', 'fixed'] as const
export type OutputKind = (typeof OUTPUT_KINDS)[number]

export const ENCODINGS = ['utf8', 'latin1'] as const
export type FileEncoding = (typeof ENCODINGS)[number]

export const DELIMITERS = [';', ',', '\t', '|'] as const
export const LINE_ENDINGS = ['crlf', 'lf'] as const
export const DATE_FORMATS = ['DDMMYYYY', 'YYYYMMDD', 'DD/MM/YYYY'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]
export const TRANSFORMS = ['trim', 'upper', 'lower', 'stripAccents', 'digitsOnly', 'alnum'] as const
export type Transform = (typeof TRANSFORMS)[number]

export const MIME_BY_OUTPUT: Record<OutputKind, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  fixed: 'text/plain',
}
export const EXTENSION_BY_OUTPUT: Record<OutputKind, string> = { xlsx: 'xlsx', csv: 'csv', fixed: 'txt' }

// Bornes dures (déni de service par configuration).
export const MAX_COLUMNS = 200
export const MAX_TOTAL_WIDTH = 4000
export const MAX_FILENAME_LENGTH = 120

// ── Catalogue de sources (FERMÉ) ─────────────────────────────────────────────

export interface SourceEntry { value: string; group: string; label: string }

export const SOURCE_CATALOG: SourceEntry[] = [
  { value: 'employee.last_name', group: 'employee', label: 'Nom' },
  { value: 'employee.first_name', group: 'employee', label: 'Prénom' },
  { value: 'employee.full_name', group: 'employee', label: 'Nom complet' },
  { value: 'employee.employee_number', group: 'employee', label: 'Matricule' },
  { value: 'employee.nni', group: 'employee', label: 'NNI' },
  { value: 'employee.iban', group: 'employee', label: 'IBAN / RIB' },
  { value: 'employee.bank_name', group: 'employee', label: 'Banque' },
  { value: 'employee.department', group: 'employee', label: 'Département' },
  { value: 'employee.job_title', group: 'employee', label: 'Poste' },
  { value: 'payslip.net_payable', group: 'payslip', label: 'Net à payer' },
  { value: 'payslip.gross_salary', group: 'payslip', label: 'Salaire brut' },
  { value: 'payslip.month', group: 'payslip', label: 'Période (AAAA-MM)' },
  { value: 'orderer.company_name', group: 'orderer', label: 'Raison sociale' },
  { value: 'orderer.account', group: 'orderer', label: 'Compte donneur d\'ordre' },
  { value: 'orderer.label', group: 'orderer', label: 'Libellé donneur d\'ordre' },
  { value: 'computed.row_index', group: 'computed', label: 'N° de ligne' },
  { value: 'computed.row_count', group: 'computed', label: 'Nombre de virements' },
  { value: 'computed.total_amount', group: 'computed', label: 'Montant total' },
  { value: 'computed.value_date', group: 'computed', label: 'Date de valeur' },
  { value: 'literal', group: 'literal', label: 'Texte fixe' },
]

const SOURCE_KEYS = new Set(SOURCE_CATALOG.map((s) => s.value))
export type SourceKey = string
export function isSourceKey(value: unknown): value is SourceKey {
  return typeof value === 'string' && SOURCE_KEYS.has(value)
}

/** Sources dont la valeur est un montant (échelle applicable, jamais de décimale). */
const AMOUNT_SOURCES = new Set(['payslip.net_payable', 'payslip.gross_salary', 'computed.total_amount'])
/** Sources numériques (écrites comme nombres dans un classeur Excel). */
const NUMERIC_SOURCES = new Set([...AMOUNT_SOURCES, 'computed.row_index', 'computed.row_count'])

// ── Le profil ────────────────────────────────────────────────────────────────

export interface BankFilePad { width: number; align: 'left' | 'right'; char: string }

export interface BankFileSegment {
  label?: string
  /** Clé du catalogue, ou 'unmapped' tant que l'admin n'a pas choisi. */
  source: SourceKey | 'unmapped'
  literal?: string
  transform?: Transform[]
  pad?: BankFilePad
  truncate?: number
  dateFormat?: DateFormat
  amountScale?: number
}

export interface BankFileSpec {
  output: OutputKind
  encoding: FileEncoding
  delimiter: string
  lineEnding: 'crlf' | 'lf'
  filename: string
  header: { mode: 'none' | 'labels' | 'custom'; lines: BankFileSegment[][] }
  columns: BankFileSegment[]
  footer: { enabled: boolean; lines: BankFileSegment[][] }
}

export interface BankFileRow {
  lastName: string
  firstName: string
  fullName: string
  employeeNumber: string
  nni: string
  iban: string
  bankName: string
  department: string
  jobTitle: string
  netPayable: number
  grossSalary: number
}

export interface BankFileContext {
  bank: string
  month: string
  tenantName: string
  orderingAccount?: string | null
  orderingLabel?: string | null
  valueDate?: string | null
  totalAmount: number
  rowCount: number
}

// ── Rendu d'un segment ───────────────────────────────────────────────────────

function rawValue(seg: BankFileSegment, row: BankFileRow | null, ctx: BankFileContext, index: number): string | number | null {
  switch (seg.source) {
    case 'employee.last_name': return row?.lastName ?? null
    case 'employee.first_name': return row?.firstName ?? null
    case 'employee.full_name': return row?.fullName ?? null
    case 'employee.employee_number': return row?.employeeNumber ?? null
    case 'employee.nni': return row?.nni ?? null
    case 'employee.iban': return row?.iban ?? null
    case 'employee.bank_name': return row?.bankName ?? ctx.bank
    case 'employee.department': return row?.department ?? null
    case 'employee.job_title': return row?.jobTitle ?? null
    case 'payslip.net_payable': return row?.netPayable ?? null
    case 'payslip.gross_salary': return row?.grossSalary ?? null
    case 'payslip.month': return ctx.month
    case 'orderer.company_name': return ctx.tenantName
    case 'orderer.account': return ctx.orderingAccount ?? null
    case 'orderer.label': return ctx.orderingLabel ?? null
    case 'computed.row_index': return index + 1
    case 'computed.row_count': return ctx.rowCount
    case 'computed.total_amount': return ctx.totalAmount
    case 'computed.value_date': return ctx.valueDate ?? null
    case 'literal': return substituteTokens(seg.literal ?? '', ctx)
    default: return null // 'unmapped' et toute source inconnue
  }
}

/** Jetons autorisés dans un texte fixe — substitution littérale, sans évaluation. */
function substituteTokens(text: string, ctx: BankFileContext): string {
  return text
    .replace(/\{mois\}/g, ctx.month)
    .replace(/\{annee\}/g, ctx.month.slice(0, 4))
    .replace(/\{banque\}/g, ctx.bank)
    .replace(/\{tenant\}/g, ctx.tenantName)
}

function formatDate(value: string, format: DateFormat | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m || !format) return value
  const [, y, mo, d] = m
  switch (format) {
    case 'DDMMYYYY': return `${d}${mo}${y}`
    case 'YYYYMMDD': return `${y}${mo}${d}`
    case 'DD/MM/YYYY': return `${d}/${mo}/${y}`
    default: return value
  }
}

function applyTransforms(text: string, transforms: Transform[] | undefined): string {
  let out = text
  for (const t of transforms ?? []) {
    switch (t) {
      case 'trim': out = out.trim(); break
      case 'upper': out = out.toUpperCase(); break
      case 'lower': out = out.toLowerCase(); break
      // Décomposition Unicode puis retrait des diacritiques — beaucoup de
      // formats bancaires historiques n'acceptent que l'ASCII.
      case 'stripAccents': out = out.normalize('NFD').replace(/[̀-ͯ]/g, ''); break
      case 'digitsOnly': out = out.replace(/\D+/g, ''); break
      case 'alnum': out = out.replace(/[^\p{L}\p{N}]+/gu, ''); break
    }
  }
  return out
}

/** Rend un segment en texte : valeur → date/montant → transformations → troncature → largeur. */
export function renderSegment(seg: BankFileSegment, row: BankFileRow | null, ctx: BankFileContext, index: number): string {
  const raw = rawValue(seg, row, ctx, index)
  if (raw === null || raw === undefined) return padTo('', seg.pad)

  let text: string
  if (AMOUNT_SOURCES.has(seg.source)) {
    // FCFA entiers : l'échelle sert aux banques qui attendent des centimes.
    text = String(Math.round(Number(raw) * (seg.amountScale ?? 1)))
  } else if (seg.source === 'computed.value_date') {
    text = formatDate(String(raw), seg.dateFormat)
  } else {
    text = String(raw)
  }

  text = applyTransforms(text, seg.transform)
  if (seg.truncate && seg.truncate > 0) text = text.slice(0, seg.truncate)
  return padTo(text, seg.pad)
}

/** Complète OU tronque à la largeur exacte : en format fixe, un débordement décale tout le fichier. */
function padTo(text: string, pad: BankFilePad | undefined): string {
  if (!pad || !pad.width || pad.width <= 0) return text
  const char = (pad.char && pad.char.length > 0 ? pad.char[0]! : ' ')
  if (text.length > pad.width) return text.slice(0, pad.width)
  return pad.align === 'right' ? text.padStart(pad.width, char) : text.padEnd(pad.width, char)
}

// ── Rendu CSV ────────────────────────────────────────────────────────────────

/** Neutralise une injection de formule (OWASP CSV/Formula Injection). */
export function sanitizeCsvField(value: string): string {
  if (value.length > 0 && '=+-@\t\r'.includes(value[0]!)) return `'${value}`
  return value
}

/**
 * Neutralisation en format FIXE. L'apostrophe des formats délimités est ici
 * interdite : elle décalerait d'un caractère toutes les positions de la ligne.
 * On remplace donc le caractère d'amorce par une espace — la largeur est
 * conservée au caractère près, et le tableur qui ouvrirait le .txt ne voit
 * plus une formule. Seuls `=` et `@` sont visés : `+` et `-` ouvrent aussi une
 * formule mais préfixent légitimement une valeur numérique signée, et un
 * fichier de virement corrompu est pire qu'un tableur mal ouvert.
 */
export function neutralizeFixedField(value: string): string {
  if (value.length > 0 && (value[0] === '=' || value[0] === '@')) return ` ${value.slice(1)}`
  return value
}

function encodeCsvField(value: string, delimiter: string): string {
  const s = sanitizeCsvField(value)
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

// ── Nom de fichier ───────────────────────────────────────────────────────────

/**
 * Résout les jetons puis DURCIT le nom : caractères hors [A-Za-z0-9_.-] retirés
 * (ni séparateur de chemin, ni `..`, ni guillemet/CRLF exploitables dans
 * Content-Disposition), longueur bornée, extension imposée par le format.
 */
export function resolveFilename(pattern: string, output: OutputKind, ctx: BankFileContext): string {
  const ext = EXTENSION_BY_OUTPUT[output]
  let name = substituteTokens(pattern ?? '', ctx)
    .replace(/[^A-Za-z0-9_.-]+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/\.(xlsx|csv|txt)$/i, '')
  if (!name) {
    name = `virements_${ctx.bank}_${ctx.month}`.replace(/[^A-Za-z0-9_.-]+/g, '')
  }
  const max = MAX_FILENAME_LENGTH - (ext.length + 1)
  if (name.length > max) name = name.slice(0, max)
  return `${name}.${ext}`
}

// ── Contrôle du profil avant activation ──────────────────────────────────────

/**
 * Retourne la liste des problèmes bloquants. Un mapping faux passe le contrôle
 * de NexusRH mais fait rejeter le fichier par la banque : on refuse donc
 * d'activer un profil incomplet plutôt que de deviner en silence.
 */
export function specIssues(spec: BankFileSpec): string[] {
  const issues: string[] = []
  if (!OUTPUT_KINDS.includes(spec.output)) issues.push('output.invalid')
  if (spec.columns.length === 0) issues.push('columns.empty')
  if (spec.columns.length > MAX_COLUMNS) issues.push('columns.tooMany')

  const allSegments = [...spec.columns, ...spec.header.lines.flat(), ...spec.footer.lines.flat()]
  allSegments.forEach((seg, i) => {
    if (seg.source === 'unmapped') issues.push(`columns.unmapped[${i}]`)
    else if (!isSourceKey(seg.source)) issues.push(`columns.unknownSource[${i}]`)
    // Un texte fixe d'espaces est légitime (remplissage d'un format fixe) ;
    // c'est l'absence de texte qui est une colonne oubliée.
    if (seg.source === 'literal' && (seg.literal ?? '').length === 0) issues.push(`columns.emptyLiteral[${i}]`)
  })

  if (spec.output === 'fixed') {
    spec.columns.forEach((seg, i) => {
      if (!seg.pad || !seg.pad.width || seg.pad.width <= 0) issues.push(`columns.missingWidth[${i}]`)
    })
    const total = spec.columns.reduce((s, c) => s + (c.pad?.width ?? 0), 0)
    if (total > MAX_TOTAL_WIDTH) issues.push('columns.tooWide')
  }
  if (spec.output === 'csv' && !DELIMITERS.includes(spec.delimiter as typeof DELIMITERS[number])) {
    issues.push('delimiter.invalid')
  }
  return issues
}

export function isSpecComplete(spec: BankFileSpec): boolean {
  return specIssues(spec).length === 0
}

// ── Génération ───────────────────────────────────────────────────────────────

export interface BuiltBankFile { buffer: Buffer; filename: string; mime: string }

function headerSegments(spec: BankFileSpec): BankFileSegment[][] {
  if (spec.header.mode === 'none') return []
  if (spec.header.mode === 'custom') return spec.header.lines
  // 'labels' : une ligne d'intitulés, calée sur la largeur des colonnes.
  return [spec.columns.map((c) => ({
    source: 'literal' as const, literal: c.label ?? '', pad: c.pad,
  }))]
}

function buildTextFile(spec: BankFileSpec, rows: BankFileRow[], ctx: BankFileContext): Buffer {
  const eol = spec.lineEnding === 'lf' ? '\n' : '\r\n'
  const isFixed = spec.output === 'fixed'
  const joinLine = (segments: BankFileSegment[], row: BankFileRow | null, index: number): string => {
    const cells = segments.map((s) => renderSegment(s, row, ctx, index))
    return isFixed
      ? cells.map(neutralizeFixedField).join('')
      : cells.map((c) => encodeCsvField(c, spec.delimiter)).join(spec.delimiter)
  }

  const lines: string[] = []
  for (const line of headerSegments(spec)) lines.push(joinLine(line, null, 0))
  rows.forEach((row, i) => lines.push(joinLine(spec.columns, row, i)))
  if (spec.footer.enabled) for (const line of spec.footer.lines) lines.push(joinLine(line, null, rows.length))

  return Buffer.from(lines.join(eol), spec.encoding === 'latin1' ? 'latin1' : 'utf8')
}

async function buildXlsxFile(spec: BankFileSpec, rows: BankFileRow[], ctx: BankFileContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'NexusRH CI'
  const ws = wb.addWorksheet(`Virements ${ctx.month}`)

  // Valeur de cellule : nombre pour les montants bruts, texte neutralisé sinon.
  const cellValue = (seg: BankFileSegment, row: BankFileRow | null, index: number): string | number => {
    const text = renderSegment(seg, row, ctx, index)
    if (NUMERIC_SOURCES.has(seg.source) && !seg.pad && !seg.transform?.length && text !== '') {
      const n = Number(text)
      if (Number.isFinite(n)) return n
    }
    return sanitizeCsvField(text)
  }

  for (const line of headerSegments(spec)) {
    ws.addRow(line.map((s) => cellValue(s, null, 0))).font = { bold: true }
  }
  rows.forEach((row, i) => { ws.addRow(spec.columns.map((s) => cellValue(s, row, i))) })
  if (spec.footer.enabled) {
    for (const line of spec.footer.lines) ws.addRow(line.map((s) => cellValue(s, null, rows.length))).font = { bold: true }
  }
  spec.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(Math.max((c.label?.length ?? 10) + 4, 12), 40) })

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

/**
 * Construit le fichier de virement. Synchrone pour les formats texte ; le XLSX
 * passe par ExcelJS (asynchrone) — d'où la variante `buildBankFileAsync`.
 */
export function buildBankFile(spec: BankFileSpec, rows: BankFileRow[], ctx: BankFileContext): BuiltBankFile {
  if (spec.output === 'xlsx') {
    throw new Error('Format xlsx : utiliser buildBankFileAsync (ExcelJS est asynchrone)')
  }
  return {
    buffer: buildTextFile(spec, rows, ctx),
    filename: resolveFilename(spec.filename, spec.output, ctx),
    mime: MIME_BY_OUTPUT[spec.output],
  }
}

export async function buildBankFileAsync(spec: BankFileSpec, rows: BankFileRow[], ctx: BankFileContext): Promise<BuiltBankFile> {
  if (spec.output !== 'xlsx') return buildBankFile(spec, rows, ctx)
  return {
    buffer: await buildXlsxFile(spec, rows, ctx),
    filename: resolveFilename(spec.filename, 'xlsx', ctx),
    mime: MIME_BY_OUTPUT.xlsx,
  }
}

/**
 * Rendu tabulaire pour l'aperçu écran (en-tête, lignes, pied). Sert aussi au
 * format xlsx, qu'on ne peut pas montrer comme du texte.
 */
export function previewTable(spec: BankFileSpec, rows: BankFileRow[], ctx: BankFileContext): string[][] {
  const table: string[][] = []
  for (const line of headerSegments(spec)) table.push(line.map((s) => renderSegment(s, null, ctx, 0)))
  rows.forEach((row, i) => table.push(spec.columns.map((s) => renderSegment(s, row, ctx, i))))
  if (spec.footer.enabled) {
    for (const line of spec.footer.lines) table.push(line.map((s) => renderSegment(s, null, ctx, rows.length)))
  }
  return table
}

// ── Modèles de départ (livrés dans le code, clonables par le tenant) ─────────

export interface StarterPreset { key: string; label: string; description: string; spec: BankFileSpec }

export const STARTER_PRESETS: StarterPreset[] = [
  {
    key: 'xlsx_standard',
    label: 'Tableur Excel (format NexusRH)',
    description: 'Le gabarit historique : bénéficiaire, NNI, IBAN, montant, libellé, avec ligne totalisatrice.',
    spec: {
      output: 'xlsx', encoding: 'utf8', delimiter: ';', lineEnding: 'crlf',
      filename: 'Virements_{banque}_{mois}.xlsx',
      header: { mode: 'labels', lines: [] },
      columns: [
        { label: 'N°', source: 'computed.row_index' },
        { label: 'Bénéficiaire', source: 'employee.full_name', transform: ['upper'] },
        { label: 'NNI', source: 'employee.nni' },
        { label: 'IBAN / RIB', source: 'employee.iban' },
        { label: 'Banque', source: 'employee.bank_name' },
        { label: 'Montant (FCFA)', source: 'payslip.net_payable' },
        { label: 'Libellé', source: 'literal', literal: 'Salaire {mois}' },
      ],
      footer: { enabled: true, lines: [[
        { source: 'literal', literal: 'TOTAL' },
        { source: 'literal', literal: '-' },
        { source: 'literal', literal: '-' },
        { source: 'literal', literal: '-' },
        { source: 'literal', literal: '-' },
        { source: 'computed.total_amount' },
        { source: 'literal', literal: '-' },
      ]] },
    },
  },
  {
    key: 'csv_delimite',
    label: 'Fichier délimité (CSV)',
    description: 'Colonnes séparées par un point-virgule, en-tête d\'intitulés. À adapter aux colonnes de votre banque.',
    spec: {
      output: 'csv', encoding: 'utf8', delimiter: ';', lineEnding: 'crlf',
      filename: 'VIR_{banque}_{mois}.csv',
      header: { mode: 'labels', lines: [] },
      columns: [
        { label: 'COMPTE_BENEF', source: 'employee.iban' },
        { label: 'NOM_BENEF', source: 'employee.full_name', transform: ['stripAccents', 'upper'], truncate: 35 },
        { label: 'MONTANT', source: 'payslip.net_payable' },
        { label: 'LIBELLE', source: 'literal', literal: 'SALAIRE {mois}' },
      ],
      footer: { enabled: false, lines: [] },
    },
  },
  {
    key: 'txt_fixe',
    label: 'Texte à format fixe',
    description: 'Enregistrements à positions fixes avec en-tête donneur d\'ordre et ligne totalisatrice. À caler sur le cahier des charges de votre banque.',
    spec: {
      output: 'fixed', encoding: 'latin1', delimiter: ';', lineEnding: 'crlf',
      filename: 'VIR_{banque}_{mois}.txt',
      header: { mode: 'custom', lines: [[
        { source: 'literal', literal: '01', pad: { width: 2, align: 'left', char: ' ' } },
        { source: 'orderer.account', transform: ['alnum', 'upper'], pad: { width: 28, align: 'left', char: ' ' } },
        { source: 'computed.value_date', dateFormat: 'DDMMYYYY', pad: { width: 8, align: 'left', char: ' ' } },
        { source: 'orderer.company_name', transform: ['stripAccents', 'upper'], pad: { width: 30, align: 'left', char: ' ' } },
      ]] },
      columns: [
        { label: 'Type', source: 'literal', literal: '02', pad: { width: 2, align: 'left', char: ' ' } },
        { label: 'Compte bénéficiaire', source: 'employee.iban', transform: ['alnum', 'upper'], pad: { width: 28, align: 'left', char: ' ' } },
        { label: 'Bénéficiaire', source: 'employee.full_name', transform: ['stripAccents', 'upper'], pad: { width: 30, align: 'left', char: ' ' } },
        { label: 'Montant', source: 'payslip.net_payable', pad: { width: 13, align: 'right', char: '0' } },
        { label: 'Libellé', source: 'literal', literal: 'SALAIRE {mois}', pad: { width: 20, align: 'left', char: ' ' } },
      ],
      footer: { enabled: true, lines: [[
        { source: 'literal', literal: '09', pad: { width: 2, align: 'left', char: ' ' } },
        { source: 'computed.row_count', pad: { width: 6, align: 'right', char: '0' } },
        { source: 'computed.total_amount', pad: { width: 15, align: 'right', char: '0' } },
      ]] },
    },
  },
]
