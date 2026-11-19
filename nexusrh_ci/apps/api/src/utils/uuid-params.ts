/**
 * Validation des paramètres de route porteurs d'un UUID.
 *
 * Sans elle, `GET /employees/pas-un-uuid` transmettait la chaîne telle quelle à
 * PostgreSQL, qui levait `22P02` (*invalid input syntax for type uuid*,
 * `string_to_uuid`). L'erreur n'était pas interceptée et remontait en **500**,
 * alors que la règle du projet est qu'aucune route ne renvoie 404/500 et que
 * chaque async a sa gestion d'erreur.
 *
 * Ce n'est pas une injection SQL — les requêtes sont paramétrées, c'est
 * précisément pourquoi PostgreSQL se plaint du type. Mais un 500 sur un chemin
 * trivialement atteignable signale à un balayeur automatisé qu'un handler a été
 * atteint et a échoué de façon non maîtrisée, et consomme une connexion du pool.
 *
 * On valide sur **liste d'autorisation de noms**, pas sur la forme de la valeur :
 * beaucoup de paramètres ne sont légitimement pas des UUID (`:month`, `:year`,
 * `:tenantSlug`, `:provider`, `:token` HMAC, `:country`, `:quarter`, `:level`,
 * `:version`, `:reference`, `:code`, `:key`, `:type`). Les refuser casserait
 * des routes valides.
 */

/**
 * Noms de paramètres qui portent TOUJOURS un UUID, relevés sur l'ensemble des
 * `modules/**\/*.routes.ts`. Ajouter un nom ici est un acte conscient : si une
 * nouvelle route nomme `:id` autre chose qu'un UUID, elle doit soit changer de
 * nom de paramètre, soit être retirée de cette liste.
 */
export const UUID_PARAM_NAMES: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'jobId',
  'docId',
  'userId',
  'profileId',
  'linkId',
  'competencyId',
  'tenantId',
])

/** UUID canonique (8-4-4-4-12), toute version, insensible à la casse. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Renvoie le nom du premier paramètre censé porter un UUID et qui n'en porte
 * pas, ou `null` si tout est conforme.
 */
export function findInvalidUuidParam(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    if (!UUID_PARAM_NAMES.has(name)) continue
    // Un paramètre absent ou non textuel n'est pas notre affaire : find-my-way
    // ne produit que des chaînes, et une route sans le paramètre ne l'expose pas.
    if (typeof value !== 'string') continue
    if (!UUID_RE.test(value)) return name
  }
  return null
}
