/**
 * Interface SAGE — logique PURE (génération de fichiers d'échange amont-paie).
 *
 * Exigence DAO (option B) : NexusRH peut servir de SOURCE amont à un logiciel de
 * paie SAGE (en complément du moteur de paie natif — jamais imposé). Ce service
 * construit les fichiers d'export (employés, éléments variables, paie) dans un
 * format délimité paramétrable, sans dépendance Fastify/DB → testable.
 *
 * SÉCURITÉ : neutralisation des injections de formules CSV (OWASP — un champ
 * commençant par = + - @ est préfixé d'une apostrophe avant ouverture dans un
 * tableur). Montants en FCFA entiers (règle CI : pas de décimales).
 */

export const EXPORT_KINDS = ['employees', 'variable_elements', 'payroll'] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]
export function isValidExportKind(k: unknown): k is ExportKind {
  return typeof k === 'string' && (EXPORT_KINDS as readonly string[]).includes(k)
}

// Séparateurs autorisés (SAGE FR/CI : point-virgule par défaut).
export const SEPARATORS: Record<string, string> = { semicolon: ';', comma: ',', tab: '\t', pipe: '|' }
export const SEPARATOR_KEYS = Object.keys(SEPARATORS)
export function resolveSeparator(key: string | null | undefined): string {
  return (key && SEPARATORS[key]) || ';'
}

export interface SageColumn { header: string; field: string }

// Définition des colonnes par type d'export (en-têtes lisibles côté SAGE).
export const SAGE_COLUMNS: Record<ExportKind, SageColumn[]> = {
  employees: [
    { header: 'Matricule', field: 'matricule' },
    { header: 'Nom', field: 'last_name' },
    { header: 'Prenom', field: 'first_name' },
    { header: 'DateNaissance', field: 'birth_date' },
    { header: 'Sexe', field: 'gender' },
    { header: 'DateEmbauche', field: 'hire_date' },
    { header: 'Fonction', field: 'job_title' },
    { header: 'Categorie', field: 'professional_category' },
    { header: 'TypeContrat', field: 'contract_type' },
    { header: 'SalaireBase', field: 'base_salary' },
    { header: 'Devise', field: 'currency' },
    { header: 'NumeroCNPS', field: 'cnps_number' },
    { header: 'NNI', field: 'nni' },
    { header: 'SituationFamiliale', field: 'marital_status' },
    { header: 'NbEnfants', field: 'children_count' },
    { header: 'ModePaiement', field: 'payment_mode' },
    { header: 'Banque', field: 'bank_name' },
    { header: 'IBAN', field: 'iban' },
  ],
  variable_elements: [
    { header: 'Matricule', field: 'matricule' },
    { header: 'Periode', field: 'month' },
    { header: 'CodeRubrique', field: 'rule_code' },
    { header: 'Libelle', field: 'label' },
    { header: 'Montant', field: 'amount' },
  ],
  payroll: [
    { header: 'Matricule', field: 'matricule' },
    { header: 'Periode', field: 'month' },
    { header: 'SalaireBase', field: 'base_salary' },
    { header: 'Brut', field: 'gross_salary' },
    { header: 'CotisationsSalariales', field: 'total_cnps_sal' },
    { header: 'ITS', field: 'its' },
    { header: 'TotalRetenues', field: 'total_deductions' },
    { header: 'NetAPayer', field: 'net_payable' },
    { header: 'CoutEmployeur', field: 'employer_cost' },
  ],
}

/** Neutralise une injection de formule CSV (OWASP CSV/Formula Injection). */
export function sanitizeCsvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.length > 0 && '=+-@\t\r'.includes(s[0]!)) return `'${s}`
  return s
}

/** Encode un champ : neutralise l'injection puis quote si nécessaire. */
export function encodeField(value: unknown, separator: string): string {
  const s = sanitizeCsvField(value)
  if (s.includes(separator) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export interface BuildOptions { separator?: string; includeHeader?: boolean }

/**
 * Construit un fichier délimité à partir de colonnes ordonnées et d'objets.
 * Lignes séparées par CRLF (attendu par les imports Windows/SAGE).
 */
export function buildSageCsv(columns: SageColumn[], records: Record<string, unknown>[], opts: BuildOptions = {}): string {
  const sep = opts.separator ?? ';'
  const includeHeader = opts.includeHeader !== false
  const lines: string[] = []
  if (includeHeader) lines.push(columns.map((c) => encodeField(c.header, sep)).join(sep))
  for (const rec of records) {
    lines.push(columns.map((c) => encodeField(rec[c.field], sep)).join(sep))
  }
  return lines.join('\r\n')
}

/** Nom de fichier d'export normalisé. */
export function exportFilename(kind: ExportKind, period?: string | null): string {
  const suffix = period ? `_${period}` : ''
  return `sage_${kind}${suffix}.csv`
}
