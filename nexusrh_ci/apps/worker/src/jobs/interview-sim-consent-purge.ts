import type { Job } from 'bullmq'
import { Pool } from 'pg'
import { logger } from '../logger.js'

// Purge quotidienne des preuves de consentement RGPD (art. 7-1) recueillies
// avant chaque simulation d'entretien (table `interview_sim_consents`),
// au-delà de la durée de conservation paramétrable par tenant
// (`interview_sim_config.consent_retention_months`, repli 36 mois si la
// ligne/colonne est absente). Sans cette purge, la trace serait conservée
// indéfiniment — recréerait le problème de limitation de la conservation que
// ce module a été construit pour corriger (RGPD, principe de minimisation).
//
// Patron IDENTIQUE à attendance-cron.ts : fan-out sur les tenants (schema-per-
// tenant), garde SAFE_SCHEMA avant toute interpolation d'identifiant, cap
// anti-storm (OWASP A04), isolation des pannes par tenant.
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })
const MAX_TENANTS = Number(process.env['INTERVIEW_SIM_PURGE_MAX_TENANTS'] ?? 500)
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/

const DEFAULT_RETENTION_MONTHS = 36
const MIN_RETENTION_MONTHS = 1
const MAX_RETENTION_MONTHS = 120

// Codes PostgreSQL "undefined_table" / "undefined_column" — le tenant n'a
// jamais migré le module interview-sim (table/colonne jamais créée) : repli
// silencieux, ce n'est pas une panne. Toute AUTRE erreur (connexion perdue,
// etc.) doit continuer à se propager (isolée par le try/catch par tenant).
const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

/**
 * Coerce la valeur lue en base vers un entier borné [1, 120]. La valeur
 * provient de notre propre colonne (jamais d'un body de requête utilisateur),
 * mais on ne construit jamais un intervalle SQL à partir d'un nombre non
 * vérifié — bornage défensif systématique avant toute utilisation, même en
 * paramètre lié ($1).
 */
export function clampRetentionMonths(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_MONTHS
  const truncated = Math.trunc(n)
  return Math.min(MAX_RETENTION_MONTHS, Math.max(MIN_RETENTION_MONTHS, truncated))
}

export async function processInterviewSimConsentPurgeJob(_job: Job): Promise<void> {
  let tenantCount = 0
  let totalDeleted = 0
  try {
    // Choix ASSUMÉ (décision 2026-07-24) : les tenants suspendus/rejetés/annulés
    // sont exclus du balayage — leur schéma est gelé (aucune activité), leurs
    // données ne sont pas altérées tant que le compte n'est pas réactivé ou
    // définitivement supprimé. Conséquence : les traces de consentement d'un
    // tenant suspendu survivent à la fenêtre de rétention le temps de la
    // suspension ; leur purge reprend à la réactivation. Cohérent avec
    // attendance-cron.ts.
    const tenants = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM platform.tenants
        WHERE status NOT IN ('rejected', 'suspended', 'cancelled')
        LIMIT $1`,
      [MAX_TENANTS],
    )
    for (const t of tenants.rows) {
      const schema = t.schema_name
      if (!SAFE_SCHEMA.test(schema)) {
        logger.warn({ schema }, 'interview-sim-consent-purge: schema_name invalide, ignoré')
        continue
      }
      try {
        const cfg = await pool.query<{ consent_retention_months: number }>(
          `SELECT consent_retention_months FROM "${schema}".interview_sim_config WHERE id = 1`,
        ).catch((e: unknown) => {
          if (isMissingSchemaObject(e)) return { rows: [] as { consent_retention_months: number }[] }
          throw e
        })
        const months = clampRetentionMonths(cfg.rows[0]?.consent_retention_months)

        // Paramétré ($1) : `months` est un entier borné, JAMAIS interpolé dans
        // le texte SQL (contrairement au nom de schéma — un IDENTIFIANT,
        // gardé ci-dessus par SAFE_SCHEMA avant interpolation, seule façon de
        // paramétrer un nom de schéma en PostgreSQL).
        const del = await pool.query(
          `DELETE FROM "${schema}".interview_sim_consents
            WHERE accepted_at < now() - ($1 * interval '1 month')`,
          [months],
        ).catch((e: unknown) => {
          if (isMissingSchemaObject(e)) return { rowCount: 0 as number | null }
          throw e
        })
        const deleted = del.rowCount ?? 0
        totalDeleted += deleted
        tenantCount++
        // Journalisation : COMPTE uniquement — jamais employee_id / consent_text
        // / session_id (OWASP A09, minimisation des logs).
        logger.info({ schema, months, deleted }, 'interview-sim-consent-purge: tenant purgé')
      } catch (e) {
        // Isolation : un tenant en échec n'interrompt pas la purge des autres.
        logger.error({ err: e, schema }, 'interview-sim-consent-purge: fan-out tenant échoué')
      }
    }
    logger.info({ tenants: tenantCount, totalDeleted }, 'interview-sim-consent-purge: balayage quotidien terminé')
  } catch (e) {
    logger.error({ err: e }, 'interview-sim-consent-purge: échec du balayage')
  }
}
