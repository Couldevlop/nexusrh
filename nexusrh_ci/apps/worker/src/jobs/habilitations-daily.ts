import type { Job } from 'bullmq'
import { Pool } from 'pg'
import { logger } from '../logger.js'

/**
 * Balayage quotidien des habilitations RH.
 *
 * CE JOB NE DONNE ET NE RETIRE AUCUN DROIT. Le moteur d'habilitation calcule
 * les droits effectifs à chaque requête et filtre lui-même les dates : une
 * délégation échue cesse d'agir à la seconde où elle échoit, une affectation
 * datée prend effet à sa date, que ce job tourne ou non. Le faire porter la
 * coupure créerait une fenêtre de droits survivants entre l'échéance et 01:00
 * du matin — exactement ce que la grille sert à empêcher.
 *
 * Ce qu'il fait, et c'est tout : il TRACE, dans la piste d'audit de chaque
 * tenant, deux événements qu'aucune requête utilisateur ne produit, puisqu'ils
 * surviennent par le simple passage du temps :
 *   - `habilitation.delegation.expired` — une procuration a cessé ;
 *   - `habilitation.activated` — une habilitation datée prend effet ce jour.
 * Sans eux, un contrôleur qui relit la piste voit des droits apparaître et
 * disparaître sans aucune ligne pour l'expliquer.
 *
 * Le non-rejeu est garanti PAR LE SQL (`NOT EXISTS` sur la trace déjà écrite),
 * pas par une colonne d'état : rejouer le job, ou le lancer deux fois dans la
 * même nuit, n'écrit rien de plus.
 *
 * Patron identique à `interview-sim-consent-purge.ts` : fan-out sur les tenants
 * (schema-per-tenant), garde `SAFE_SCHEMA` avant toute interpolation
 * d'identifiant, cap anti-storm (OWASP A04), isolation des pannes par tenant.
 */
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })
const MAX_TENANTS = Number(process.env['HABILITATIONS_DAILY_MAX_TENANTS'] ?? 500)
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/
/** Cap par tenant et par nuit : une trace d'audit ne doit pas noyer la piste. */
const MAX_ROWS_PER_TENANT = 500

const ACTION_EXPIRED = 'habilitation.delegation.expired'
const ACTION_ACTIVATED = 'habilitation.activated'

// Codes PostgreSQL "undefined_table" / "undefined_column" : le tenant n'a
// jamais migré les habilitations. Repli silencieux — ce n'est pas une panne.
const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

/** Écrit une ligne d'audit système (aucun auteur : c'est le temps qui agit). */
async function traceAudit(schema: string, action: string, entityId: string): Promise<void> {
  await pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [null, action, 'habilitation', entityId, JSON.stringify({ source: 'habilitations-daily' }), null],
  )
}

export async function processHabilitationsDailyJob(_job: Job): Promise<void> {
  let tenantCount = 0
  let expiredCount = 0
  let activatedCount = 0
  try {
    // Même choix qu'`attendance-cron` / `interview-sim-consent-purge` : le
    // schéma d'un tenant suspendu est gelé, on ne l'écrit pas.
    const tenants = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM platform.tenants
        WHERE status NOT IN ('rejected', 'suspended', 'cancelled')
        LIMIT $1`,
      [MAX_TENANTS],
    )
    for (const t of tenants.rows) {
      const schema = t.schema_name
      if (!SAFE_SCHEMA.test(schema)) {
        logger.warn({ schema }, 'habilitations-daily: schema_name invalide, ignoré')
        continue
      }
      try {
        // Délégations échues jamais tracées. Le `NOT EXISTS` porte sur la piste
        // d'audit elle-même : c'est la trace qui fait office d'état, donc rien
        // à migrer et aucun rejeu possible.
        const expired = await pool.query<{ id: string }>(
          `SELECT d.id::text AS id
             FROM "${schema}".hab_delegations d
            WHERE d.revoked_at IS NULL
              AND d.ends_at < now()
              AND NOT EXISTS (
                SELECT 1 FROM "${schema}".audit_log a
                 WHERE a.action = '${ACTION_EXPIRED}' AND a.entity_id = d.id
              )
            LIMIT ${MAX_ROWS_PER_TENANT}`,
        )
        for (const row of expired.rows) {
          await traceAudit(schema, ACTION_EXPIRED, row.id)
          expiredCount++
        }

        // Habilitations qui prennent effet aujourd'hui. `CURRENT_DATE` est
        // évalué par PostgreSQL : pas de date calculée côté Node, donc pas de
        // décalage de fuseau entre le worker et la base.
        const activated = await pool.query<{ user_id: string }>(
          `SELECT a.user_id::text AS user_id
             FROM "${schema}".hab_assignments a
            WHERE a.revoked_at IS NULL
              AND a.effective_from = CURRENT_DATE
              AND NOT EXISTS (
                SELECT 1 FROM "${schema}".audit_log l
                 WHERE l.action = '${ACTION_ACTIVATED}' AND l.entity_id = a.user_id
                   AND l.created_at::date = CURRENT_DATE
              )
            LIMIT ${MAX_ROWS_PER_TENANT}`,
        )
        for (const row of activated.rows) {
          await traceAudit(schema, ACTION_ACTIVATED, row.user_id)
          activatedCount++
        }
        tenantCount++
        // Journalisation : COMPTES uniquement — jamais d'identifiant de
        // personne ni de permission (OWASP A09, minimisation des logs).
        logger.info(
          { schema, expired: expired.rows.length, activated: activated.rows.length },
          'habilitations-daily: tenant balayé',
        )
      } catch (e) {
        if (isMissingSchemaObject(e)) {
          logger.info({ schema }, 'habilitations-daily: tenant sans habilitations, ignoré')
          continue
        }
        // Isolation : un tenant en échec n'interrompt pas les autres.
        logger.error({ err: e, schema }, 'habilitations-daily: fan-out tenant échoué')
      }
    }
    logger.info(
      { tenants: tenantCount, expired: expiredCount, activated: activatedCount },
      'habilitations-daily: balayage quotidien terminé',
    )
  } catch (e) {
    logger.error({ err: e }, 'habilitations-daily: échec du balayage')
  }
}
