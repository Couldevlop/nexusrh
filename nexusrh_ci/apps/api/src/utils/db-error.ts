/**
 * Traduction des erreurs techniques (PostgreSQL, chiffrement) en messages
 * MÉTIER personnalisés en français — jamais de « Internal Server Error » brut ni
 * de fuite de détail SQL vers le client (OWASP A05). Le détail complet reste
 * loggé côté serveur (OWASP A09) ; seul un message clair et actionnable est
 * renvoyé à l'utilisateur.
 *
 * Utilisé à la fois par le error handler global (filet de sécurité pour tous les
 * modules) et par les handlers qui veulent un message spécifique à l'entité
 * (ex. « Un employé avec cet email existe déjà »).
 */

export interface MappedDbError {
  statusCode: number
  /** Message personnalisé, sûr à afficher à l'utilisateur final. */
  error: string
  /** Code technique d'origine (pg ou applicatif), pour le client/diagnostic. */
  code: string
}

export interface DescribeOpts {
  /** Nom de l'entité pour personnaliser les messages (ex. « employé »). */
  entity?: string
  /**
   * Messages spécifiques par champ pour les violations d'unicité (23505).
   * La clé est cherchée (insensible à la casse) dans le nom de la contrainte
   * ET le `detail` Postgres. Ex. { email: 'Un employé avec cet email existe déjà.' }
   */
  uniqueMessages?: Record<string, string>
}

interface PgLikeError {
  code?: string
  constraint?: string
  column?: string
  detail?: string
  message?: string
}

/**
 * Renvoie un message personnalisé si l'erreur est reconnue (pg/chiffrement),
 * sinon `null` (l'appelant applique alors un message générique personnalisé).
 */
export function describeDbError(err: unknown, opts: DescribeOpts = {}): MappedDbError | null {
  const e = (err ?? {}) as PgLikeError
  const code = e.code
  if (!code) return null

  const entity = opts.entity ?? 'enregistrement'

  // Chiffrement des données sensibles (NNI, IBAN) indisponible côté serveur.
  if (code === 'ENCRYPTION_UNAVAILABLE') {
    return {
      statusCode: 503,
      code,
      error: e.message
        ?? "Le chiffrement des données sensibles (NNI, IBAN) n'est pas configuré sur le serveur. Contactez votre administrateur.",
    }
  }

  switch (code) {
    case '23505': { // unique_violation
      const hay = `${e.constraint ?? ''} ${e.detail ?? ''}`.toLowerCase()
      for (const [field, msg] of Object.entries(opts.uniqueMessages ?? {})) {
        if (hay.includes(field.toLowerCase())) return { statusCode: 409, code, error: msg }
      }
      if (hay.includes('email')) {
        return { statusCode: 409, code, error: `Cet email est déjà utilisé par un autre ${entity}.` }
      }
      return { statusCode: 409, code, error: `Ce ${entity} existe déjà (valeur en double).` }
    }
    case '23503': // foreign_key_violation
      return {
        statusCode: 422, code,
        error: `Référence invalide : un élément lié (département, responsable…) est introuvable.`,
      }
    case '23502': { // not_null_violation
      const col = e.column ? ` (« ${e.column} »)` : ''
      return { statusCode: 400, code, error: `Un champ obligatoire${col} est manquant.` }
    }
    case '23514': // check_violation
      return { statusCode: 422, code, error: `Une valeur saisie ne respecte pas les règles de validation.` }
    case '22P02': // invalid_text_representation (ex. UUID/int mal formé)
      return { statusCode: 400, code, error: `Format de donnée invalide (identifiant attendu).` }
    case '22001': // string_data_right_truncation
      return { statusCode: 400, code, error: `Une valeur saisie dépasse la longueur autorisée.` }
    case '42703': // undefined_column
    case '42P01': // undefined_table
      // Bug de configuration serveur : message neutre, jamais le SQL brut.
      return { statusCode: 500, code, error: `Erreur de configuration du serveur. Nos équipes ont été notifiées.` }
    case '08000': case '08003': case '08006': // connexion DB perdue
    case '53300': case '57P03': // trop de connexions / DB en démarrage
      return { statusCode: 503, code, error: `Service temporairement indisponible. Réessayez dans un instant.` }
    default:
      return null
  }
}
