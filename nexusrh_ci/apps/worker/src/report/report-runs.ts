import type { Pool } from 'pg'
import type { Period } from './period.js'

/**
 * Trace des rapports envoyés, et anti-doublon.
 *
 * La table est créée par le worker lui-même plutôt que par le provisioning de
 * l'API : le rapport est une fonctionnalité du worker, et lui faire dépendre du
 * cycle de démarrage d'un autre service ne servirait qu'à créer une panne au
 * premier déploiement où l'ordre change. `CREATE TABLE IF NOT EXISTS` est
 * idempotent et coûte une requête par exécution du job.
 */
const MAX_RECIPIENTS_LEN = 500
const MAX_ERROR_LEN = 1000

export async function ensureReportRunsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.report_runs (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      period_type   varchar(10)  NOT NULL,
      period_start  date         NOT NULL,
      period_end    date         NOT NULL,
      status        varchar(20)  NOT NULL,
      recipients    text         NOT NULL,
      error_message text,
      created_at    timestamptz  NOT NULL DEFAULT now(),
      updated_at    timestamptz  NOT NULL DEFAULT now(),
      UNIQUE (period_type, period_start)
    )
  `)
}

/**
 * Délai au-delà duquel une ligne `pending` est considérée abandonnée.
 *
 * Le job complet (collecte, rendu, envoi) dure quelques secondes : un
 * `pending` vieux de deux heures ne peut pas être un envoi encore en cours,
 * c'est le vestige d'un processus tué entre la prise de la ligne et
 * l'enregistrement du résultat. Le risque de double envoi est donc nul, alors
 * que le risque inverse — la période bloquée POUR TOUJOURS, en silence, avec
 * BullMQ affichant un succès — était certain.
 */
const PENDING_PERIME = '2 hours'

/**
 * Tente de prendre la main sur la période. Renvoie `false` si un rapport a déjà
 * été envoyé, ou si un envoi est réellement en cours.
 *
 * Une ligne `failed` est reprise : sans cela, la contrainte d'unicité
 * transformerait le moindre échec SMTP en semaine définitivement perdue.
 *
 * Une ligne `pending` PÉRIMÉE (voir `PENDING_PERIME`) est reprise elle aussi :
 * si le processus est tué entre la prise de la ligne et l'écriture du statut
 * final, la ligne reste `pending` indéfiniment et plus aucun rapport ne part
 * pour cette période.
 */
export async function claimRun(pool: Pool, period: Period, recipients: string): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO platform.report_runs (period_type, period_start, period_end, recipients, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (period_type, period_start) DO UPDATE
       SET status = 'pending', recipients = EXCLUDED.recipients, updated_at = now()
       WHERE platform.report_runs.status = 'failed'
          OR (platform.report_runs.status = 'pending'
              AND platform.report_runs.updated_at < now() - interval '${PENDING_PERIME}')
     RETURNING id`,
    [period.type, period.start, period.end, recipients.slice(0, MAX_RECIPIENTS_LEN)],
  )
  return res.rows.length > 0
}

export async function markSent(pool: Pool, period: Period): Promise<void> {
  await pool.query(
    `UPDATE platform.report_runs
        SET status = 'sent', error_message = NULL, updated_at = now()
      WHERE period_type = $1 AND period_start = $2`,
    [period.type, period.start],
  )
}

export async function markFailed(pool: Pool, period: Period, message: string): Promise<void> {
  await pool.query(
    `UPDATE platform.report_runs
        SET status = 'failed', error_message = $3, updated_at = now()
      WHERE period_type = $1 AND period_start = $2`,
    [period.type, period.start, message.slice(0, MAX_ERROR_LEN)],
  )
}
