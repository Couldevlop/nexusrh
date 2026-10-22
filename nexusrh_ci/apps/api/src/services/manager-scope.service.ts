/**
 * Périmètre d'un manager (OWASP A01) — source UNIQUE de la règle « quels
 * employés un manager voit et sur lesquels il peut agir ».
 *
 * Deux modes, réglés par tenant (platform.tenants.manager_scope, admin) :
 *  - 'direct'    (défaut) : uniquement les subordonnés directs (manager_id = lui) ;
 *  - 'hierarchy' : toute sa branche (N-1, N-2, …) — consultation ET approbation.
 *
 * Tous les modules (employés, absences, frais, pointage, carrières, onboarding,
 * formation, IA) passent par ce service : la règle ne doit exister qu'à un seul
 * endroit, sinon un module oublié élargit ou rétrécit le périmètre en silence.
 *
 * Le réglage est lu DANS la requête SQL (sous-requête sur platform.tenants) :
 * aucun cache à invalider, un changement s'applique immédiatement sur tous les
 * pods. Le manager lui-même n'est JAMAIS dans son périmètre (anti
 * auto-approbation) ; consulter son propre dossier reste géré par chaque route.
 */
import type { Pool } from 'pg'

export const MANAGER_SCOPES = ['direct', 'hierarchy'] as const
export type ManagerScope = (typeof MANAGER_SCOPES)[number]

// Le nom de schéma vient du token, mais il est ici interpolé comme LITTÉRAL
// (et pas seulement comme identifiant) : on le borne strictement.
const SCHEMA_NAME_RE = /^[a-z_][a-z0-9_]*$/i

function branchSql(schema: string, param: string): string {
  return `WITH RECURSIVE branch(id) AS (
      SELECT id FROM "${schema}".employees WHERE manager_id = ${param}::uuid
      UNION
      SELECT c.id FROM "${schema}".employees c JOIN branch b ON c.manager_id = b.id
    )
    SELECT id FROM branch WHERE id <> ${param}::uuid`
}

/**
 * Fragment SQL : la ligne employé d'alias `alias` appartient au périmètre du
 * manager dont l'id employé est `param` (paramètre positionnel '$3' ou
 * sous-requête scalaire). `alias`/`param` sont des constantes du code appelant.
 *
 * - équipe directe : toujours incluse ;
 * - reste de la branche : seulement si le tenant a choisi 'hierarchy'.
 * `forceHierarchy` ignore le réglage (contrôle d'intégrité de l'arbre).
 *
 * UNION (et non UNION ALL) dédoublonne : un cycle dans les manager_id
 * (A → B → A) ne fait donc pas boucler la récursion.
 */
export function managerScopeSql(
  schema: string,
  alias: string,
  param: string,
  opts: { forceHierarchy?: boolean } = {},
): string {
  if (!SCHEMA_NAME_RE.test(schema)) throw new Error('Nom de schéma tenant invalide')
  if (opts.forceHierarchy) return `${alias}.id IN (${branchSql(schema, param)})`
  return `(${alias}.manager_id = ${param} OR (
    EXISTS (SELECT 1 FROM platform.tenants mst
             WHERE mst.schema_name = '${schema}' AND mst.manager_scope = 'hierarchy')
    AND ${alias}.id IN (${branchSql(schema, param)})
  ))`
}

/**
 * Le manager `managerEmployeeId` peut-il agir sur l'employé `targetEmployeeId` ?
 * Fail-closed : sans dossier employé, aucun droit. Faux sur lui-même.
 */
export async function isInManagerScope(
  pool: Pool,
  schema: string,
  managerEmployeeId: string | null | undefined,
  targetEmployeeId: string | null | undefined,
): Promise<boolean> {
  if (!managerEmployeeId || !targetEmployeeId) return false
  if (managerEmployeeId === targetEmployeeId) return false
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM "${schema}".employees e
     WHERE e.id = $1 AND ${managerScopeSql(schema, 'e', '$2')} LIMIT 1`,
    [targetEmployeeId, managerEmployeeId],
  )
  return (r?.rows?.length ?? 0) > 0
}

/**
 * Rattacher `employeeId` au responsable `newManagerId` créerait-il une boucle ?
 * Vrai si c'est lui-même ou l'un de ses subordonnés (à n'importe quel niveau) :
 * un cycle rendrait la hiérarchie incohérente (organigramme, approbations).
 */
export async function wouldCreateManagerCycle(
  pool: Pool,
  schema: string,
  employeeId: string,
  newManagerId: string,
): Promise<boolean> {
  if (employeeId === newManagerId) return true
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM "${schema}".employees e
     WHERE e.id = $1 AND ${managerScopeSql(schema, 'e', '$2', { forceHierarchy: true })} LIMIT 1`,
    [newManagerId, employeeId],
  )
  return (r?.rows?.length ?? 0) > 0
}

/**
 * Dossier employé du manager connecté : l'employeeId du token fait foi ; repli
 * sur l'email pour les tokens émis avant le lien compte↔dossier. null = aucun
 * dossier → l'appelant doit refuser (fail-closed).
 */
export async function resolveManagerEmployeeId(
  pool: Pool,
  schema: string,
  user: { employeeId?: string | null; email: string },
): Promise<string | null> {
  if (user.employeeId) return user.employeeId
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM "${schema}".employees WHERE email = $1 LIMIT 1`, [user.email],
  )
  return r?.rows?.[0]?.id ?? null
}
