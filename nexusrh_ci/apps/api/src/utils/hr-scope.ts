import type { FastifyRequest } from 'fastify'
import { getRequestHab } from '../plugins/auth.js'
import { hrScopeSql } from '../services/habilitation.service.js'
import { pool } from '../db/pool.js'
import { assertValidSchemaName } from './schema-name.js'

/**
 * Fragment SQL de périmètre filiale (habilitations RH) pour la requête courante,
 * à ajouter en `AND` sur la ligne employé `alias`. 'TRUE' pour l'admin du tenant
 * (hors grille) et sans affectation (accès hérité). Le schéma vient du JWT.
 *
 * Si le moteur échoue, l'exception remonte : authorize() a déjà refusé (403)
 * avant tout handler dans ce cas ; atteindre ici sans contexte valide = 500,
 * fermé par défaut (aucune donnée servie).
 */
export async function requestHrScope(request: FastifyRequest, alias: string): Promise<string> {
  if (request.user.role === 'admin') return 'TRUE'
  return hrScopeSql(request.user.schemaName, alias, await getRequestHab(request))
}

/**
 * Variante pour les routes ouvertes aussi au self-service : un employé (ou un
 * utilisateur RH rétrogradé en « employee » par authorize) lit ses propres
 * données, jamais scopées.
 */
export async function requestHrScopeUnlessSelf(request: FastifyRequest, alias: string): Promise<string> {
  return request.user.role === 'employee' ? 'TRUE' : requestHrScope(request, alias)
}

/**
 * Garde d'existence « dans mon périmètre » pour les écritures par id : faux si
 * l'employé est hors périmètre (l'appelant répond 404, pas 403). Aucune requête
 * quand le périmètre est ouvert ('TRUE'), pour ne rien changer au chemin hérité.
 */
export async function employeeInHrScope(
  schema: string, employeeId: string, scopeSql: string, alias = 'e',
): Promise<boolean> {
  if (scopeSql === 'TRUE') return true
  assertValidSchemaName(schema)
  const r = await pool.query(
    `SELECT 1 FROM "${schema}".employees ${alias} WHERE ${alias}.id = $1 AND ${scopeSql} LIMIT 1`,
    [employeeId],
  )
  return (r.rowCount ?? r.rows.length) > 0
}

/**
 * Une filiale cible (création/mutation d'un employé) est-elle dans le périmètre
 * de l'utilisateur ? Évalue le même fragment SQL sur une ligne virtuelle, pour
 * qu'il n'existe qu'une seule définition du périmètre. Faux = l'appelant répond 403.
 */
export async function legalEntityInHrScope(
  schema: string, legalEntityId: string | null | undefined, scopeSql: string, alias = 'e',
): Promise<boolean> {
  if (scopeSql === 'TRUE') return true
  assertValidSchemaName(schema)
  const r = await pool.query(
    `SELECT 1 FROM (SELECT $1::uuid AS legal_entity_id) ${alias} WHERE ${scopeSql}`,
    [legalEntityId ?? null],
  )
  return (r.rowCount ?? r.rows.length) > 0
}

/**
 * Périmètre filiale pour une table qui ne porte qu'une colonne `employee_id`
 * (contrats, notes de frais, sanctions…) : sous-requête EXISTS sur employees.
 * 'TRUE' reste 'TRUE' (aucune sous-requête superflue, SQL hérité inchangé).
 * `employeeIdColumn` est une colonne QUALIFIÉE (`table.col`, obligatoire : une colonne nue serait capturée par l'alias de la sous-requête) écrite dans le code (jamais une
 * entrée utilisateur).
 */
export async function requestEmployeeScope(request: FastifyRequest, employeeIdColumn: string): Promise<string> {
  const scope = await requestHrScope(request, 'hs')
  return wrapEmployeeScope(request.user.schemaName, employeeIdColumn, scope)
}

/**
 * Fabrique de fragments de périmètre pour du code qui n'a pas la requête sous la main
 * (outils IA) : le contexte d'habilitation est lu UNE fois, puis chaque alias demande
 * son fragment. Admin du tenant : toujours 'TRUE'.
 */
export async function requestHrScopeFactory(request: FastifyRequest): Promise<(alias: string) => string> {
  if (request.user.role === 'admin') return () => 'TRUE'
  const hab = await getRequestHab(request)
  const schema = request.user.schemaName
  return (alias: string) => hrScopeSql(schema, alias, hab)
}

/** Variante self-service : un employé (rôle effectif) n'est jamais filtré. */
export async function requestEmployeeScopeUnlessSelf(request: FastifyRequest, employeeIdColumn: string): Promise<string> {
  return request.user.role === 'employee' ? 'TRUE' : requestEmployeeScope(request, employeeIdColumn)
}

function wrapEmployeeScope(schema: string, employeeIdColumn: string, scopeSql: string): string {
  if (scopeSql === 'TRUE') return 'TRUE'
  assertValidSchemaName(schema)
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(employeeIdColumn)) {
    throw new Error(`Colonne SQL invalide : ${employeeIdColumn}`)
  }
  return `EXISTS (SELECT 1 FROM "${schema}".employees hs WHERE hs.id = ${employeeIdColumn} AND ${scopeSql})`
}

/** Réponse 409 des opérations d'écriture sur une période/lot qui mélange des filiales. */
export const SHARED_PERIOD_ERROR =
  'Période partagée avec une autre filiale : action réservée à un RH habilité sur toutes les filiales'

/**
 * Nombre d'employés de la liste hors du périmètre (`scopeSql` calculé sur l'alias
 * `e`). 0 sans requête quand le périmètre est ouvert. Compté en SQL ; un employé
 * introuvable est compté hors périmètre (fermé par défaut).
 */
export async function countEmployeesOutOfScope(
  schema: string, employeeIds: string[], scopeSql: string,
): Promise<number> {
  if (scopeSql === 'TRUE' || employeeIds.length === 0) return 0
  assertValidSchemaName(schema)
  const r = await pool.query<{ n: string | number }>(
    `SELECT COUNT(*)::int AS n
       FROM unnest($1::uuid[]) AS ids(id)
       LEFT JOIN "${schema}".employees e ON e.id = ids.id
      WHERE NOT COALESCE((${scopeSql}), false)`,
    [employeeIds],
  )
  return Number(r.rows[0]?.n ?? 0)
}

/**
 * La période (et ses déclinaisons filiales) porte-t-elle un bulletin d'un employé
 * hors périmètre ? Sert aux écritures de période (valider, rejeter, annuler,
 * envoyer) : un RH restreint ne décide pas pour d'autres filiales.
 */
export async function periodHasOutOfScopeSlips(
  schema: string, periodId: string, scopeSql: string,
): Promise<boolean> {
  if (scopeSql === 'TRUE') return false
  assertValidSchemaName(schema)
  const r = await pool.query(
    `SELECT 1
       FROM "${schema}".pay_slips ps
       LEFT JOIN "${schema}".employees e ON e.id = ps.employee_id
      WHERE ps.period_id IN (SELECT id FROM "${schema}".pay_periods WHERE id = $1 OR parent_period_id = $1)
        AND NOT COALESCE((${scopeSql}), false)
      LIMIT 1`,
    [periodId],
  )
  if ((r.rowCount ?? r.rows.length) > 0) return true
  // Paie multi-filiales : une déclinaison dont la filiale est hors périmètre
  // (même sans bulletin encore) suffit à rendre la période partagée.
  const c = await pool.query(
    `SELECT 1
       FROM "${schema}".pay_periods c
      WHERE c.parent_period_id = $1 AND c.legal_entity_id IS NOT NULL
        AND NOT COALESCE((SELECT TRUE FROM (SELECT c.legal_entity_id AS legal_entity_id) e WHERE ${scopeSql}), false)
      LIMIT 1`,
    [periodId],
  )
  return (c.rowCount ?? c.rows.length) > 0
}

/**
 * Habilitations : périmètre d'une déclaration (cnps_declarations / disa_records) sur
 * l'alias `alias`. Une déclaration est dans le périmètre si sa filiale l'est ET si
 * aucun salarié listé dans ses données (jsonb `employee_id`) n'est hors périmètre
 * (ex. déclaration sans filiale, générée par un RH global). 'TRUE' sans restriction.
 */
export async function declarationScope(request: FastifyRequest, alias: string): Promise<string> {
  const entity = await requestHrScope(request, alias)
  if (entity === 'TRUE') return 'TRUE'
  const emp = await requestHrScope(request, 'hs')
  const schema = request.user.schemaName
  return `(${entity} AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.data) = 'array' THEN ${alias}.data ELSE '[]'::jsonb END) x
      LEFT JOIN "${schema}".employees hs ON hs.id::text = x->>'employee_id'
     WHERE NOT COALESCE((${emp}), false)))`
}
