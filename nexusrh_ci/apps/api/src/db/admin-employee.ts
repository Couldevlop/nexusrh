/**
 * Fiche employé « à compléter » de l'administrateur d'un tenant.
 *
 * À la création d'un tenant, l'admin n'avait qu'un compte `users` : absent de
 * la liste des employés, sans bulletin, sans soldes de congés, « Mon espace »
 * vide. On lui associe une fiche `employees` minimale (salaire 0 → hors paie
 * tant qu'elle n'est pas complétée, cf. filtre base_salary > 0 des chemins de
 * paie) et on renseigne le lien explicite `users.employee_id`.
 *
 * Une seule source SQL, utilisée par :
 *  - la création de tenant (tenant-provisioning.service.ts) ;
 *  - le mode réparation reset-admin (platform.routes.ts) ;
 *  - la reprise des tenants existants (utils/schema-migrations.ts).
 *
 * Idempotent : ne touche que les admins dont `employee_id` est NULL.
 */
import { assertValidSchemaName } from '../utils/schema-name.js'

/** Intitulé de poste par défaut de la fiche « à compléter ». */
export const ADMIN_EMPLOYEE_JOB_TITLE = 'Administrateur RH'

/**
 * 1) Lien par email : une fiche NON supprimée portant le même email
 *    (insensible à la casse) et non liée à un autre compte.
 * 2) Sinon création de la fiche « à compléter » puis lien.
 *
 * `scopedToEmail` : restreint à l'admin dont l'email vaut `$1` (création de
 * tenant / réparation) ; sinon tous les admins non liés (reprise).
 */
export function adminEmployeeLinkStatements(schemaName: string, scopedToEmail = false): string[] {
  assertValidSchemaName(schemaName)
  const s = `"${schemaName}"`
  const scope = scopedToEmail ? 'AND lower(u.email) = lower($1)' : ''
  return [
    `UPDATE ${s}.users u
        SET employee_id = e.id, updated_at = now()
       FROM ${s}.employees e
      WHERE u.role = 'admin'
        AND u.employee_id IS NULL
        ${scope}
        AND e.deleted_at IS NULL
        AND e.email IS NOT NULL
        AND lower(e.email) = lower(u.email)
        AND NOT EXISTS (SELECT 1 FROM ${s}.users u2 WHERE u2.employee_id = e.id)`,
    `WITH todo AS (
       SELECT u.id, u.email, u.first_name, u.last_name
         FROM ${s}.users u
        WHERE u.role = 'admin'
          AND u.employee_id IS NULL
          ${scope}
          AND NOT EXISTS (SELECT 1 FROM ${s}.employees e
                           WHERE e.email IS NOT NULL AND lower(e.email) = lower(u.email))
     ), ins AS (
       INSERT INTO ${s}.employees
         (user_id, first_name, last_name, email, job_title, hire_date, base_salary, is_active)
       SELECT id, first_name, last_name, email, '${ADMIN_EMPLOYEE_JOB_TITLE}', CURRENT_DATE, 0, true
         FROM todo
       ON CONFLICT DO NOTHING
       RETURNING id, user_id
     )
     UPDATE ${s}.users u
        SET employee_id = ins.id, updated_at = now()
       FROM ins
      WHERE u.id = ins.user_id`,
  ]
}

interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

/**
 * Crée (ou retrouve par email) la fiche employé de l'admin `adminEmail` et la
 * lie à son compte. Ne lève pas d'erreur métier : à l'appelant de décider si
 * un échec est bloquant.
 */
export async function ensureAdminEmployeeRecord(
  db: Queryable,
  schemaName: string,
  adminEmail: string,
): Promise<void> {
  for (const sql of adminEmployeeLinkStatements(schemaName, true)) {
    await db.query(sql, [adminEmail])
  }
}
