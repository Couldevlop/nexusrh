import { assertValidSchemaName } from './schema-name.js'

/**
 * Résolution « utilisateur connecté → fiche employé ».
 *
 * Le lien EXPLICITE `users.employee_id` (renseigné à la création/modification
 * du compte, ou par la migration de reprise) prime ; l'égalité d'email
 * `employees.email = users.email` n'est plus qu'un repli pour l'existant.
 *
 * Requête paramétrée : `$1` = email de l'utilisateur (claim JWT). Elle renvoie
 * toujours une ligne `{ id }` (id NULL si aucune fiche) — les appelants lisent
 * `rows[0]?.id ?? null`, comme avec l'ancienne requête par email.
 */
export function actorEmployeeSql(schema: string): string {
  assertValidSchemaName(schema)
  return `SELECT COALESCE(
      (SELECT u.employee_id FROM "${schema}".users u
        WHERE u.email = $1 AND u.employee_id IS NOT NULL LIMIT 1),
      (SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1)
    ) AS id`
}
