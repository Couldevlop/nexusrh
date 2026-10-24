/**
 * Champs personnalisés du dossier employé — logique PURE.
 *
 * L'admin du tenant définit ses champs (matricule interne, groupe sanguin,
 * n° de badge…) dans platform.tenants.employee_custom_fields ; les valeurs
 * vivent dans <tenant>.employees.custom_fields (jsonb { key: valeur }).
 *
 * OWASP A03 : toute valeur est validée contre sa définition (type, liste,
 * longueur) et toute clé non définie est refusée — le jsonb ne devient jamais
 * un fourre-tout écrit par le client.
 * OWASP A01 : un champ `sensitive` n'est montré qu'aux rôles RH et au salarié
 * lui-même (même règle que le NNI / l'IBAN).
 */
import { z } from 'zod'

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export const MAX_CUSTOM_FIELDS = 30
const MAX_TEXT_LENGTH = 500

const definitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/,
    'Clé invalide : minuscules, chiffres et _ (2 à 40 caractères, commence par une lettre)'),
  label: z.string().trim().min(1).max(80),
  type: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
}).strict().superRefine((d, ctx) => {
  if (d.type === 'select' && !d.options) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Une liste de choix exige au moins une option.' })
  }
  if (d.type !== 'select' && d.options) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Les options sont réservées au type « liste ».' })
  }
  if (d.options && new Set(d.options).size !== d.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Options en double.' })
  }
})

export const fieldDefinitionsSchema = z.array(definitionSchema).max(MAX_CUSTOM_FIELDS)
  .superRefine((defs, ctx) => {
    const seen = new Set<string>()
    for (const d of defs) {
      if (seen.has(d.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Clé en double : ${d.key}` })
        return
      }
      seen.add(d.key)
    }
  })

export type CustomFieldDefinition = z.infer<typeof definitionSchema>
export type CustomFieldValue = string | number | boolean
export type CustomFieldValues = Record<string, CustomFieldValue>

/** Lecture tolérante de la config en base : invalide ou absente → aucun champ. */
export function parseFieldDefinitions(raw: unknown): CustomFieldDefinition[] {
  const parsed = fieldDefinitionsSchema.safeParse(raw ?? [])
  return parsed.success ? parsed.data : []
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

function coerce(def: CustomFieldDefinition, v: unknown): { value?: CustomFieldValue; error?: string } {
  switch (def.type) {
    case 'text': {
      if (typeof v !== 'string') return { error: 'texte attendu' }
      const s = v.trim()
      return s.length > MAX_TEXT_LENGTH ? { error: `${MAX_TEXT_LENGTH} caractères maximum` } : { value: s }
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN
      return Number.isFinite(n) ? { value: n } : { error: 'nombre attendu' }
    }
    case 'date': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'date attendue (AAAA-MM-JJ)' }
      const d = new Date(`${v}T00:00:00Z`)
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? { value: v } : { error: 'date invalide' }
    }
    case 'select':
      return typeof v === 'string' && def.options?.includes(v) ? { value: v } : { error: 'valeur hors de la liste' }
    case 'boolean':
      return typeof v === 'boolean' ? { value: v } : { error: 'oui/non attendu' }
  }
}

export interface CustomFieldError { key: string; message: string }
export type CustomFieldValidation =
  | { ok: true; values: CustomFieldValues }
  | { ok: false; errors: CustomFieldError[] }

/**
 * Valide les valeurs saisies.
 *  - create : tous les champs obligatoires doivent être renseignés ;
 *  - update : fusion avec `existing` ; seul un champ obligatoire VIDÉ est
 *    refusé (un champ rendu obligatoire après coup ne bloque pas les autres
 *    modifications des dossiers anciens). Une valeur vide efface la clé.
 * Les valeurs existantes d'un champ supprimé de la config sont conservées
 * (pas de perte de données), mais aucune nouvelle écriture n'est acceptée.
 */
export function validateCustomFieldValues(
  defs: CustomFieldDefinition[],
  input: unknown,
  mode: 'create' | 'update',
  existing: unknown = {},
): CustomFieldValidation {
  if (input === undefined) input = {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ key: '_', message: 'Objet { clé: valeur } attendu' }] }
  }
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const errors: CustomFieldError[] = []
  const base: CustomFieldValues = mode === 'update' && existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as CustomFieldValues) } : {}

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = byKey.get(key)
    if (!def) { errors.push({ key, message: 'champ non défini pour ce tenant' }); continue }
    if (isEmpty(raw)) {
      if (def.required) errors.push({ key, message: `${def.label} est obligatoire` })
      else delete base[key]
      continue
    }
    const r = coerce(def, raw)
    if (r.error !== undefined) errors.push({ key, message: `${def.label} : ${r.error}` })
    else base[key] = r.value as CustomFieldValue
  }

  if (mode === 'create') {
    for (const d of defs) {
      if (d.required && isEmpty(base[d.key]) && !errors.some((e) => e.key === d.key)) {
        errors.push({ key: d.key, message: `${d.label} est obligatoire` })
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values: base }
}

/**
 * Valeurs visibles pour un lecteur sans accès aux données sensibles : seuls
 * les champs définis et non sensibles (une clé orpheline peut être sensible).
 */
export function redactCustomFields(defs: CustomFieldDefinition[], values: unknown): CustomFieldValues {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {}
  const visible = new Set(defs.filter((d) => !d.sensitive).map((d) => d.key))
  const out: CustomFieldValues = {}
  for (const [k, v] of Object.entries(values as CustomFieldValues)) {
    if (visible.has(k)) out[k] = v
  }
  return out
}
