/**
 * Producteur BullMQ pour le poll des badgeuses (`POST /attendance/devices/:id/sync`).
 *
 * SÉCURITÉ / FIABILITÉ
 *  - La route `/sync` NE DOIT JAMAIS effectuer d'appel HTTP sortant synchrone
 *    dans le cycle de la requête (spec) : elle se contente d'enfiler un job.
 *    Le fetch réel (avec sa propre garde SSRF) est effectué par le worker
 *    (`apps/worker/src/jobs/attendance-poll.ts`, tâche ultérieure).
 *  - `Queue` est construite PARESSEUSEMENT (au premier `enqueuePoll`) afin que
 *    le simple `import` de ce module n'ouvre aucune connexion Redis — condition
 *    nécessaire pour que les tests de routes puissent `vi.mock` ce module sans
 *    qu'aucun effet de bord ne se produise à la collecte des tests.
 *  - La connexion Redis est construite à partir de la même config que le reste
 *    de l'API (`config.redis.url`) ; `maxRetriesPerRequest: null` est requis
 *    par BullMQ pour les connexions utilisées par ses clients internes.
 */
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { config } from '../../config.js'

export interface AttendancePollJobData {
  schemaName: string
  deviceId: string
}

const QUEUE_NAME = 'attendance-poll'

let queue: Queue<AttendancePollJobData> | undefined

function getQueue(): Queue<AttendancePollJobData> {
  if (!queue) {
    const connection = new Redis(config.redis.url, { maxRetriesPerRequest: null })
    queue = new Queue<AttendancePollJobData>(QUEUE_NAME, { connection })
  }
  return queue
}

/**
 * Enfile un job de poll manuel pour une badgeuse. Best-effort côté appelant :
 * les erreurs Redis remontent (l'appelant renvoie une erreur HTTP claire plutôt
 * qu'un faux succès `enqueued: true`).
 */
export async function enqueuePoll(schemaName: string, deviceId: string): Promise<void> {
  await getQueue().add(
    'poll',
    { schemaName, deviceId },
    { removeOnComplete: true, removeOnFail: 1000, attempts: 1 },
  )
}
