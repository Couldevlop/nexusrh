/**
 * Habilitations RH — masquage des données sensibles (salaire, NNI, RIB/IBAN,
 * compte bancaire, téléphone Mobile Money, n° CNPS) pour les utilisateurs RH
 * qui n'ont pas la case dédiée (HabContext.sensitive).
 *
 * Masquer = mettre la valeur à `null` (+ `maskedFields` listant les clés cachées) : le contrat
 * d'interface ne change pas. Contexte `null` = comportement historique (tenant
 * non contrôlé, admin, sans affectation, self-service) : rien n'est modifié.
 */
import type { HabContext } from './habilitation.service.js'

/** Ligne masquée : `maskedFields` n'existe que si une valeur renseignée a été cachée. */
export type Masked<T> = T & { maskedFields?: string[] }

export const SENSITIVE_FIELDS = ['base_salary', 'salary', 'nni', 'iban', 'rib', 'bank_account', 'mobile_money_phone', 'cnps_number']

/**
 * Formes réellement servies par l'API pour les champs de SENSITIVE_FIELDS :
 * camelCase, alias SQL des jointures (contrats) et valeurs dérivées (RIB
 * partiellement masqué, prétention salariale d'un candidat).
 */
const RESPONSE_ALIASES: Readonly<Record<string, string>> = {
  baseSalary: 'base_salary',
  cnpsNumber: 'cnps_number',
  employee_cnps: 'cnps_number',
  mobileMoneyPhone: 'mobile_money_phone',
  mobile_money_number: 'mobile_money_phone',
  mm_phone: 'mobile_money_phone',
  bankAccount: 'bank_account',
  iban_masked: 'iban',
  ibanMasked: 'iban',
  expected_salary: 'salary',
  expectedSalary: 'salary',
}

const MASKED_KEYS: ReadonlySet<string> = new Set([...SENSITIVE_FIELDS, ...Object.keys(RESPONSE_ALIASES)])

/** Le contexte impose-t-il le masquage ? (null = historique : non) */
export function isMasked(ctx: HabContext | null): boolean {
  return ctx !== null && !ctx.sensitive
}

/** Contenu d'une cellule CSV masquée : explicite, jamais lisible comme une valeur absente. */
export const MASKED_CELL = 'Réservé'

/**
 * Met à null les clés listées dont la valeur est renseignée quand le contexte
 * masque, et les recense dans `maskedFields` (noms des clés de la réponse). Si
 * rien n'est masqué, la ligne est rendue telle quelle (aucune clé ajoutée).
 */
export function maskFields<T extends Record<string, unknown>>(row: T, keys: readonly string[], ctx: HabContext | null): Masked<T> {
  if (!isMasked(ctx)) return row
  const out: Record<string, unknown> = { ...row }
  const hidden: string[] = []
  for (const k of keys) {
    if (k in out && out[k] != null) { out[k] = null; hidden.push(k) }
    else if (k in out) out[k] = null
  }
  if (hidden.length === 0) return out as Masked<T>
  const prev = Array.isArray(out.maskedFields) ? (out.maskedFields as string[]) : []
  out.maskedFields = [...new Set([...prev, ...hidden])]
  return out as Masked<T>
}

/** Cellule d'export : « Réservé » si le contexte masque, sinon la valeur. */
export function csvCell(value: unknown, ctx: HabContext | null): unknown {
  return isMasked(ctx) ? MASKED_CELL : value
}

export function maskSensitive<T extends Record<string, unknown>>(row: T, ctx: HabContext | null): Masked<T> {
  if (!isMasked(ctx)) return row
  return maskFields(row, Object.keys(row).filter((k) => MASKED_KEYS.has(k)), ctx)
}

export function maskSensitiveRows<T extends Record<string, unknown>>(rows: T[], ctx: HabContext | null): Array<Masked<T>> {
  return isMasked(ctx) ? rows.map((r) => maskSensitive(r, ctx)) : rows
}
