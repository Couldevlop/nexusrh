/**
 * Health-check minimal exécuté périodiquement par la livenessProbe Kubernetes.
 *
 * Le worker BullMQ n'expose pas de port HTTP, on vérifie donc deux signaux
 * indirects depuis le pod :
 *   1. Le processus Node est vivant (sinon, ce script ne tournerait pas)
 *   2. Une connexion Redis peut être ouverte (PING < 2s)
 *
 * Sortie :
 *   - exit 0 : OK
 *   - exit 1 : Redis injoignable → Kubernetes redémarre le pod
 *
 * Tolérance : on autorise un fail-open au démarrage (Redis pas encore prêt)
 * via `initialDelaySeconds: 30` côté Kubernetes.
 *
 * OWASP A05 (Security Misconfiguration) : pas de credential journalisé.
 */
import { Redis } from 'ioredis'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6380'
const PING_TIMEOUT_MS = 2000

async function main(): Promise<void> {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: PING_TIMEOUT_MS,
    lazyConnect: true,
  })

  const timeout = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('[health-check] timeout Redis PING')
    client.disconnect()
    process.exit(1)
  }, PING_TIMEOUT_MS)

  try {
    await client.connect()
    const pong = await client.ping()
    if (pong !== 'PONG') {
      throw new Error(`Réponse Redis inattendue: ${pong}`)
    }
    clearTimeout(timeout)
    client.disconnect()
    process.exit(0)
  } catch (err) {
    clearTimeout(timeout)
    client.disconnect()
    // eslint-disable-next-line no-console
    console.error('[health-check] échec:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

void main()
