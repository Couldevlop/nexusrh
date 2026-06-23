/**
 * Veille hebdomadaire des packs législatifs paie (UEMOA / CEMAC / Nigeria).
 *
 * Architecture hybride : le code reste la référence (legislation-packs.ts), la DB
 * porte les surcharges validées. Ce job CRÉE des PROPOSITIONS de revue dans
 * platform.legislation_proposals que le super_admin valide dans l'UI
 * (/platform/legislation). Il n'écrit JAMAIS directement une surcharge — la
 * validation humaine est obligatoire.
 *
 * Déclencheurs d'une proposition de revue pour un pays :
 *   - pack jamais vérifié, ou dernière vérification > 90 jours, OU
 *   - mois de janvier (entrée en vigueur des lois de finances de l'année N).
 * Garde anti-doublon : on n'ajoute rien si une proposition est déjà en attente.
 */
import type { Job } from 'bullmq'
import { Pool } from 'pg'
import { logger } from '../logger.js'

const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })

// Miroir de COUNTRY_TO_PACK_CODE (apps/api/.../legislation-packs.ts).
const COUNTRIES = [
  'CIV', 'BEN', 'TGO', 'BFA', 'SEN', 'MLI', 'NER', 'TCD', 'NGA',
  'CMR', 'GAB', 'COG', 'CAF', 'GNQ', 'GNB',
] as const
const STALE_DAYS = 90

export async function processLegislationWatchJob(_job: Job<unknown, void>): Promise<void> {
  try {
    const now = new Date()
    const isJanuary = now.getUTCMonth() === 0
    let created = 0
    for (const cc of COUNTRIES) {
      const pending = await pool.query(
        `SELECT 1 FROM platform.legislation_proposals WHERE country_code = $1 AND status = 'pending' LIMIT 1`, [cc],
      )
      if (pending.rowCount) continue // une proposition est déjà en attente — pas de doublon

      const ov = await pool.query<{ last_verified_at: string | null }>(
        `SELECT last_verified_at FROM platform.legislation_pack_overrides WHERE country_code = $1 LIMIT 1`, [cc],
      )
      const lastVerified = ov.rows[0]?.last_verified_at ? new Date(ov.rows[0]!.last_verified_at) : null
      const stale = !lastVerified || (now.getTime() - lastVerified.getTime()) > STALE_DAYS * 86_400_000
      if (!stale && !isJanuary) continue

      const summary = isJanuary
        ? `Loi de finances ${now.getUTCFullYear()} : vérifier le barème d'impôt, le SMIG et les plafonds (${cc}) auprès des sources officielles.`
        : `Revue périodique du pack ${cc} : aucune vérification depuis ${lastVerified ? lastVerified.toISOString().slice(0, 10) : 'jamais'} — confirmer SMIG, cotisations et barème.`
      await pool.query(
        `INSERT INTO platform.legislation_proposals (country_code, summary, source) VALUES ($1, $2, $3)`,
        [cc, summary, 'docs/referentiel-paie-afrique.md'],
      )
      created++
    }
    logger.info({ created }, 'legislation-watch: propositions de revue créées')
  } catch (err) {
    logger.error({ err }, 'legislation-watch: échec')
    throw err
  }
}
