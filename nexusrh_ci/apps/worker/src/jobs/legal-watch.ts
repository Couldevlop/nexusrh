/**
 * Job worker : veille réglementaire.
 *
 * Reçoit en payload une référence d'article à surveiller (article_id +
 * sourceUrl). Récupère le contenu, le compare au texte actuel (via SHA-256),
 * et si changement détecté → insère une proposition en `pending` dans
 * droit_ci.article_proposals.
 *
 * Le diff IA détaillé n'est PAS fait ici (rate-limit + coût). Il est calculé
 * lazy par la route API GET /proposals/:id ou au moment de la revue manuelle
 * (super_admin peut relancer un analyze sur le texte si besoin).
 *
 * OWASP :
 *  - A04 : fetch avec timeout 30s + max body 1MB (anti-ressources illimitées)
 *  - A09 : log structuré pour audit
 *  - A10 : URLs configurables via env, pas SSRF par défaut (liste allowlist
 *          recommandée en production)
 */
import type { Job } from 'bullmq'
import { Pool } from 'pg'
import { createHash } from 'crypto'
import { logger } from '../logger.js'
import { parseLegalWatchPayload, JobValidationError, type LegalWatchPayload } from '../schemas.js'

// OWASP A04 — cap connexions PG (le worker peut traiter plusieurs sources en
// parallèle, chacune fait 2-3 queries — 5 connexions suffisent et empêchent
// de saturer le pool DB partagé avec l'API)
const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })

export type { LegalWatchPayload } from '../schemas.js'

const FETCH_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES   = 1_000_000  // 1 MB

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'NexusRH-LegalWatch/1.0 (+https://nexusrh.openlabconsulting.com)',
        'Accept': 'text/plain, text/html, application/json, application/pdf;q=0.5, */*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new Error(`Body trop grand (${buf.byteLength} bytes > ${MAX_BODY_BYTES})`)
    }
    return new TextDecoder('utf-8').decode(buf)
  } finally {
    clearTimeout(timer)
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export async function processLegalWatchJob(job: Job<unknown, void>): Promise<void> {
  // OWASP A03 + A10 (anti-SSRF) — validation stricte du payload :
  // sourceUrl obligatoirement http(s), countryCode ISO alpha-3, source whitelist
  let payload: LegalWatchPayload
  try {
    payload = parseLegalWatchPayload(job.data)
  } catch (err) {
    if (err instanceof JobValidationError) {
      logger.error({ jobId: job.id, err: err.message }, 'legal-watch: payload invalide — job rejeté')
      return
    }
    throw err
  }
  const { articleId, sourceUrl, source, countryCode, sourceType = 'scraper' } = payload

  logger.info({ articleId, sourceUrl, source }, 'legal-watch: fetch start')

  // 1. Fetch le contenu de la source
  let fetchedText: string
  try {
    fetchedText = await fetchText(sourceUrl)
  } catch (err) {
    logger.error({ err, sourceUrl }, 'legal-watch: fetch failed')
    throw err  // BullMQ retry selon config
  }

  const fetchedHash = sha256(fetchedText.trim())

  // 2. Compare au texte actuel (si article existant)
  let currentText: string | null = null
  let currentHash: string | null = null
  if (articleId) {
    const cur = await pool.query<{ texte: string; checksum_sha256: string | null }>(
      `SELECT texte, checksum_sha256 FROM droit_ci.articles WHERE article_id = $1 LIMIT 1`,
      [articleId],
    )
    if (cur.rows[0]) {
      currentText = cur.rows[0].texte
      currentHash = cur.rows[0].checksum_sha256 ?? sha256(currentText.trim())
    }
  }

  // Court-circuit si aucun changement détecté
  if (currentHash === fetchedHash) {
    logger.info({ articleId, sourceUrl }, 'legal-watch: no change (hash identique)')
    return
  }

  // 3. Évite les doublons : si une proposition pending existe déjà avec le
  //    même texte exact, on ne re-crée pas.
  const existing = await pool.query(
    `SELECT id FROM droit_ci.article_proposals
       WHERE article_id IS NOT DISTINCT FROM $1
         AND source_url = $2
         AND status = 'pending'
         AND md5(proposed_text) = md5($3)
       LIMIT 1`,
    [articleId, sourceUrl, fetchedText],
  )
  if (existing.rows[0]) {
    logger.info({ articleId, sourceUrl, proposalId: existing.rows[0].id },
      'legal-watch: proposition déjà pending — skip')
    return
  }

  // 4. Insert proposition en pending (l'analyse IA détaillée sera faite au
  //    moment de la revue par le super_admin via UI ou explicit POST /analyze)
  const res = await pool.query<{ id: string }>(
    `INSERT INTO droit_ci.article_proposals
       (article_id, country_code, source, source_url, source_type,
        proposed_by, current_text, proposed_text,
        diff_summary, status)
     VALUES ($1, $2, $3, $4, $5, 'ai_watcher', $6, $7, $8, 'pending')
     RETURNING id`,
    [
      articleId, countryCode.toUpperCase(), source, sourceUrl, sourceType,
      currentText, fetchedText,
      `Changement détecté automatiquement par le worker de veille (hash SHA-256 différent). Analyse IA à demander.`,
    ],
  )

  logger.info(
    { articleId, sourceUrl, proposalId: res.rows[0]?.id, currentHash, fetchedHash },
    'legal-watch: nouvelle proposition pending créée',
  )
}
