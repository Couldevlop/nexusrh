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
/**
 * Champs masqués pendant la requête courante, recensés PAR CONTEXTE
 * d'habilitation.
 *
 * Le contexte (`request.hab`) est créé une fois par requête : une table faible
 * indexée par ce contexte donne donc un recensement à la durée de vie de la
 * requête, sans ajouter de paramètre à `maskFields` ni de champ à `HabContext`.
 * La piste d'audit (tâche 13) s'en sert pour écrire `result: 'masked'` avec les
 * NOMS des champs cachés — jamais leurs valeurs.
 */
const MASKED_TRACE = new WeakMap<HabContext, Set<string>>()

function recordMasked(ctx: HabContext | null, keys: readonly string[]): void {
  if (ctx === null || keys.length === 0) return
  const set = MASKED_TRACE.get(ctx) ?? new Set<string>()
  for (const k of keys) set.add(k)
  MASKED_TRACE.set(ctx, set)
}

/** Noms des champs masqués pour ce contexte depuis le début de la requête. */
export function maskedFieldsFor(ctx: HabContext | null): string[] {
  if (ctx === null) return []
  return [...(MASKED_TRACE.get(ctx) ?? [])]
}

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
  recordMasked(ctx, hidden)
  const prev = Array.isArray(out.maskedFields) ? (out.maskedFields as string[]) : []
  out.maskedFields = [...new Set([...prev, ...hidden])]
  return out as Masked<T>
}

/** Cellule d'export : « Réservé » si le contexte masque, sinon la valeur. */
export function csvCell(value: unknown, ctx: HabContext | null): unknown {
  return isMasked(ctx) ? MASKED_CELL : value
}

/** Les motifs de pré-tri sur la prétention salariale citent le montant du candidat. */
const SALARY_RULE_RE = /^Prétention salariale/
export const SALARY_RULE_MASKED = 'Prétention salariale hors plafond'

/** Motifs de pré-tri sans montant (contexte masquant) ; sinon inchangés. */
export function redactRuleTexts(rules: readonly string[], ctx: HabContext | null): string[] {
  return isMasked(ctx) ? rules.map((r) => (SALARY_RULE_RE.test(r) ? SALARY_RULE_MASKED : r)) : [...rules]
}

export function maskSensitive<T extends Record<string, unknown>>(row: T, ctx: HabContext | null): Masked<T> {
  if (!isMasked(ctx)) return row
  const out = maskFields(row, Object.keys(row).filter((k) => MASKED_KEYS.has(k)), ctx)
  const rules = (out as Record<string, unknown>).screening_failed_rules
  if (!Array.isArray(rules) || !rules.some((r) => typeof r === 'string' && SALARY_RULE_RE.test(r))) return out
  // screening_failed_rules : le texte « Prétention salariale … : X FCFA » révèle expected_salary.
  const prev = Array.isArray(out.maskedFields) ? out.maskedFields : []
  recordMasked(ctx, ['screening_failed_rules'])
  return {
    ...out,
    screening_failed_rules: redactRuleTexts(rules as string[], ctx),
    maskedFields: [...new Set([...prev, 'screening_failed_rules'])],
  } as Masked<T>
}

export function maskSensitiveRows<T extends Record<string, unknown>>(rows: T[], ctx: HabContext | null): Array<Masked<T>> {
  return isMasked(ctx) ? rows.map((r) => maskSensitive(r, ctx)) : rows
}

const SETTLEMENT_AMOUNT_KEYS = ['indemniteConges', 'indemnitePreavis', 'indemniteLicenciement', 'total', 'severanceBase'] as const

/**
 * Solde de tout compte : les montants (congés, préavis, licenciement, total,
 * assiette, lignes, candidats d'indemnité de congés) reflètent le salaire de
 * l'employé ; masqués hors case dédiée. Libellés, durées et alertes restent.
 */
export function maskSettlement<T extends Record<string, unknown>>(settlement: T, ctx: HabContext | null): Masked<T> {
  if (!isMasked(ctx)) return settlement
  const out: Record<string, unknown> = { ...maskFields(settlement, SETTLEMENT_AMOUNT_KEYS, ctx) }
  const hidden: string[] = Array.isArray(out.maskedFields) ? [...(out.maskedFields as string[])] : []
  if (Array.isArray(out.lines)) {
    out.lines = (out.lines as Array<Record<string, unknown>>).map((l) => ({ ...l, amount: null }))
    hidden.push('lines')
  }
  const allowance = out.congesAllowance
  if (allowance && typeof allowance === 'object') {
    out.congesAllowance = { ...(allowance as Record<string, unknown>), candidates: null }
    hidden.push('congesAllowance')
  }
  if (hidden.length > 0) {
    recordMasked(ctx, hidden)
    out.maskedFields = [...new Set(hidden)]
  }
  return out as Masked<T>
}

/** Ligne d'un dossier de sortie (offboarding_cases) : masque son `settlement` jsonb. */
export function maskOffboardingCase<T extends Record<string, unknown>>(row: T, ctx: HabContext | null): Masked<T> {
  const st = row.settlement
  if (!isMasked(ctx) || !st || typeof st !== 'object' || Array.isArray(st)) return row
  const out: Record<string, unknown> = { ...row, settlement: maskSettlement(st as Record<string, unknown>, ctx) }
  recordMasked(ctx, ['settlement'])
  out.maskedFields = [...new Set([...(Array.isArray(row.maskedFields) ? row.maskedFields as string[] : []), 'settlement'])]
  return out as Masked<T>
}
