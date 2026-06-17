/**
 * Classification des données à 4 niveaux — logique PURE (contrôle d'accès/export).
 *
 * Niveaux : 1 Public · 2 Interne · 3 Confidentiel · 4 Restreint. Les règles
 * (rôles autorisés, export, chiffrement, audit) sont configurables par tenant ;
 * ce service applique la décision d'accès à partir de ces règles. Aucune
 * dépendance (Fastify/DB) → testable.
 */

export const LEVELS = [1, 2, 3, 4] as const
export type Level = (typeof LEVELS)[number]

// Clés i18n des niveaux (libellés rendus côté frontend).
export const LEVEL_KEYS: Record<number, string> = {
  1: 'public', 2: 'internal', 3: 'confidential', 4: 'restricted',
}

export function isValidLevel(n: unknown): n is Level {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 4
}

export interface LevelRule {
  level: number
  allowedRoles: string[]
  exportAllowed: boolean
  encryptionRequired: boolean
  auditRequired: boolean
}

/** Un rôle peut-il ACCÉDER à une donnée de ce niveau ? (super_admin n'accède jamais aux données RH). */
export function roleCanAccess(rule: LevelRule | undefined, role: string): boolean {
  if (!rule) return false
  if (role === 'super_admin') return false
  return rule.allowedRoles.includes(role)
}

/** Un rôle peut-il EXPORTER une donnée de ce niveau ? (accès + export autorisé sur le niveau). */
export function roleCanExport(rule: LevelRule | undefined, role: string): boolean {
  if (!roleCanAccess(rule, role)) return false
  return rule!.exportAllowed
}

/** L'accès à ce niveau doit-il être journalisé (piste d'audit) ? */
export function accessRequiresAudit(rule: LevelRule | undefined): boolean {
  return !!rule?.auditRequired
}
