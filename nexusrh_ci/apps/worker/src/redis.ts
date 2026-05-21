import { Redis } from 'ioredis'

/**
 * OWASP A02 + A05 — connexion Redis sécurisée.
 * - En production : refus si l'URL n'est pas `rediss://` (TLS) ou si elle
 *   ne contient pas de credentials. Empêche le déploiement par erreur d'un
 *   worker qui écouterait des queues en clair sur le réseau cluster.
 * - En dev/test : tolère `redis://localhost:6380` sans auth (dev local).
 */
export function createClient(): Redis {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6380'
  const isProduction = process.env['NODE_ENV'] === 'production'

  if (isProduction) {
    if (!url.startsWith('rediss://')) {
      throw new Error(
        '[redis] REDIS_URL doit utiliser rediss:// (TLS) en production. ' +
        'Connexion en clair refusée pour éviter MITM sur queues de jobs sensibles (paie, CNPS, emails).',
      )
    }
    // Vérifier qu'il y a au moins un mot de passe (format rediss://user:pass@host)
    if (!/^rediss:\/\/[^@\s]+@/.test(url)) {
      throw new Error(
        '[redis] REDIS_URL doit contenir des credentials en production (rediss://user:pass@host).',
      )
    }
  }

  return new Redis(url, { maxRetriesPerRequest: null })
}
