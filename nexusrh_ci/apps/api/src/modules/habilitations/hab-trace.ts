/**
 * Habilitations RH — classement et composition de la trace d'une requête.
 *
 * Demande du porteur (04/11/2026) : « toutes ses actions doivent être tracées
 * et consultables ». TOUTES, donc les lectures de liste aussi, et avec la
 * CAUSE quand l'accès a été refusé — sinon la piste montre un trou là où il
 * faudrait lire « cette personne a essayé, et voici pourquoi elle n'a pas pu ».
 *
 * Deux contraintes opposées tiennent ce fichier :
 *  1. La trace doit porter la cause du refus (`denied_permission`,
 *     `denied_scope`, `denied_self`) et le fait qu'une réponse a été masquée.
 *  2. La RÉPONSE HTTP ne doit rien en dire : un refus de périmètre reste un
 *     404 indistinguable d'un vrai 404, sans quoi il révèle l'existence de la
 *     ligne (énumération). La cause est donc classée ici, côté serveur, à
 *     partir de marqueurs posés sur la requête — jamais exposée au client.
 *
 * Minimisation (OWASP A09) : `changes` ne porte que la route, le résultat, le
 * sous-groupe, les NOMS des filtres et les NOMS des champs masqués. Jamais un
 * body, jamais la valeur d'un filtre, jamais une donnée personnelle.
 */
import { resolveRoutePermission } from './route-permissions.js'

/**
 * Reconnaissance d'UUID, écrite ici plutôt qu'importée de
 * `services/habilitation.service.ts` : ce fichier doit rester une feuille
 * (aucun accès base, aucune configuration), afin que le hook de réponse et les
 * bancs de test puissent l'utiliser sans démarrer un pool PostgreSQL.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Cause d'un refus, posée sur la requête au moment où il est décidé. */
export type HabDenial = 'permission' | 'scope' | 'self'

/** Résultat consigné dans la piste d'audit. */
export type HabResult = 'allowed' | 'denied_permission' | 'denied_scope' | 'denied_self' | 'masked'

export const HAB_RESULTS = [
  'allowed', 'denied_permission', 'denied_scope', 'denied_self', 'masked',
] as const satisfies readonly HabResult[]
export const HAB_DENIED_RESULTS = ['denied_permission', 'denied_scope', 'denied_self'] as const satisfies readonly HabResult[]

export interface HabTraceInput {
  statusCode: number
  /** Marqueur explicite posé par le point de refus (prime sur le code HTTP). */
  denial?: HabDenial | undefined
  /**
   * Vrai si le périmètre filiale de l'utilisateur a réellement restreint la
   * requête (fragment SQL différent de 'TRUE'). Sans lui, un 404 ne peut pas
   * être distingué d'un refus de périmètre — et avec lui, un vrai 404 d'un
   * utilisateur non restreint n'est jamais classé comme un refus.
   */
  scopeRestricted?: boolean | undefined
  /** Noms des champs effectivement masqués dans la réponse. */
  maskedFields?: readonly string[] | undefined
}

/**
 * Résultat d'une requête d'habilité, ou `null` quand il n'y a rien à classer
 * (panne technique : ce n'est pas une décision d'habilitation, et une trace
 * « refusé » sur un 500 ferait accuser la grille à tort).
 */
export function classifyHabResult(input: HabTraceInput): HabResult | null {
  const { statusCode, denial, scopeRestricted, maskedFields } = input
  if (statusCode >= 500) return null
  if (denial === 'self') return 'denied_self'
  if (denial === 'scope') return 'denied_scope'
  if (denial === 'permission' || statusCode === 403) return 'denied_permission'
  if (statusCode === 404 && scopeRestricted === true) return 'denied_scope'
  if (maskedFields && maskedFields.length > 0) return 'masked'
  return 'allowed'
}

export interface HabTraceRoute extends HabTraceInput {
  method: string
  /** URL de ROUTE (`/employees/:id`), jamais l'URL appelée (pas de valeur dedans). */
  routeUrl: string
  /** `params.id` de la requête, retenu seulement s'il est un UUID. */
  paramId?: string | null | undefined
  /** Noms des paramètres de requête utilisés (jamais leurs valeurs). */
  filterKeys?: readonly string[] | undefined
}

export interface HabTraceEntry {
  action: string
  entity: string
  entityId: string | null
  changes: Record<string, unknown>
}

/**
 * Entrée d'audit d'une requête RH, ou `null` si la route n'a pas de case dans
 * la grille (ce n'est pas une action RH : authentification, référentiels
 * publics…) ou s'il n'y a rien à classer.
 */
export function habTraceEntry(
  route: HabTraceRoute,
  ctx: { subgroupId: string | null },
): HabTraceEntry | null {
  const perm = resolveRoutePermission(route.method, route.routeUrl)
  if (perm === null) return null
  const result = classifyHabResult(route)
  if (result === null) return null
  const changes: Record<string, unknown> = {
    route: route.routeUrl,
    result,
    subgroupId: ctx.subgroupId,
  }
  if (route.filterKeys && route.filterKeys.length > 0) changes.filters = [...route.filterKeys]
  if (result === 'masked' && route.maskedFields) changes.maskedFields = [...route.maskedFields]
  return {
    action: `hr.${perm.fn}.${perm.action}`,
    entity: perm.fn,
    entityId: route.paramId && UUID_RE.test(route.paramId) ? route.paramId : null,
    changes,
  }
}
