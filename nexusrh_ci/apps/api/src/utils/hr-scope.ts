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
