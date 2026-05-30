/**
 * Validation centralisée du nom de schéma PostgreSQL (OWASP A03 — Injection).
 *
 * Architecture multi-tenant schema-per-tenant : le nom de schéma provient du JWT
 * (`request.user.schemaName`) puis est interpolé tel quel dans des identifiants
 * SQL — `"${schema}".table`, `SET search_path = "${schema}"`, `CREATE SCHEMA`,
 * `ALTER TABLE`. Les identifiants ne peuvent PAS être paramétrés ($1) en SQL :
 * la seule défense est une whitelist stricte de caractères AVANT interpolation.
 *
 * Tant que `JWT_SECRET` reste confidentiel, un attaquant ne peut pas forger un
 * schemaName malveillant ; cette validation est une défense en profondeur qui
 * neutralise tout vecteur résiduel (JWT compromis, appel interne avec valeur non
 * fiable, régression future). Elle est volontairement appliquée à TOUS les points
 * d'interpolation, pas seulement ponctuellement.
 *
 * Schémas acceptés :
 *   - 'platform'                (schéma global super_admin)
 *   - 'tenant_<slug>'           (schémas tenant)
 *   - tout identifiant Postgres sûr : minuscule initiale, [a-z0-9_], ≤ 63 car.
 */

/** Identifiant Postgres sûr : commence par une lettre minuscule, puis [a-z0-9_], max 63 caractères. */
export const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/

export function isValidSchemaName(name: unknown): name is string {
  return typeof name === 'string' && SCHEMA_NAME_RE.test(name)
}

/**
 * Lève une erreur si le nom de schéma n'est pas sûr à interpoler dans du SQL.
 * À appeler au point d'entrée de toute fonction qui interpole un nom de schéma.
 */
export function assertValidSchemaName(name: unknown): asserts name is string {
  if (!isValidSchemaName(name)) {
    throw new Error(`Nom de schéma invalide (rejeté avant interpolation SQL) : ${String(name)}`)
  }
}
