/**
 * Veille réglementaire — workflow de validation des mises à jour d'articles
 * juridiques. Réservé au super_admin.
 *
 * Endpoints :
 *   POST /platform/legal-watch/analyze        — IA propose un diff à partir d'un texte
 *   GET  /platform/legal-watch/proposals      — liste paginée (filtre par status)
 *   GET  /platform/legal-watch/proposals/:id  — détail d'une proposition
 *   POST /platform/legal-watch/proposals/:id/approve — applique le diff (transaction)
 *   POST /platform/legal-watch/proposals/:id/reject  — rejette la proposition
 *
 * OWASP :
 *   A07 — authorize('super_admin') sur toutes les routes
 *   A08 — transaction approve : archive ancien article + update + log
 *   A09 — audit log obligatoire sur approve/reject
 */
import type { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { createHash, randomUUID } from 'crypto'
import { config } from '../../config.js'
import { analyzeLegalDiff } from '../../services/legal-diff.service.js'
import { LEGAL_SOURCES_CATALOG } from '../../data/legal-sources-catalog.js'

const pool = new Pool({ connectionString: config.database.url })

// OWASP A03 — patterns stricts
const UUID_RE         = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ARTICLE_ID_RE   = /^[a-z][a-z0-9_-]{0,49}$/i
const SOURCE_CODE_RE  = /^[a-z][a-z0-9_-]{0,29}$/
const COUNTRY_CODE_RE = /^[A-Z]{3}$/
// Whitelist countries supportés par le catalogue
const SUPPORTED_COUNTRIES = new Set(LEGAL_SOURCES_CATALOG.map(s => s.countryCode))

// OWASP A07 — rate-limits sur opérations sensibles
const ANALYZE_RATE_LIMIT      = { rateLimit: { max: 20, timeWindow: '1 hour'   } }
const REVIEW_RATE_LIMIT       = { rateLimit: { max: 60, timeWindow: '1 hour'   } }  // approve/reject
const PROPOSALS_READ_LIMIT    = { rateLimit: { max: 200, timeWindow: '1 hour'  } }  // listing

// OWASP A03 — Zod strict + regex sur identifiants
const analyzeSchema = z.object({
  article_id:     z.string().regex(ARTICLE_ID_RE).max(50).optional(),
  country_code:   z.string().regex(COUNTRY_CODE_RE).default('CIV'),
  source:         z.string().regex(SOURCE_CODE_RE).min(1).max(30),
  source_url:     z.string().url().max(2000).optional(),
  source_type:    z.enum(['manual', 'scraper', 'upload']).default('manual'),
  proposed_text:  z.string().min(10).max(30_000),
  context:        z.string().max(2000).optional(),
}).strict()

const reviewSchema = z.object({
  notes: z.string().max(2000).optional(),
}).strict()

const sourcesCatalogQuerySchema = z.object({
  country: z.string().regex(COUNTRY_CODE_RE).optional(),
}).strict()

const legalWatchRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /analyze : IA propose un diff ───────────────────────────────────
  fastify.post('/analyze', {
    preHandler: [fastify.authorize('super_admin')],
    config: ANALYZE_RATE_LIMIT,
    handler: async (request, reply) => {
      const parsed = analyzeSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation échouée',
          issues: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      const body = parsed.data

      // Charge le texte actuel si article_id fourni
      let currentText: string | null = null
      let currentTitre: string | null = null
      if (body.article_id) {
        const cur = await pool.query<{ texte: string; titre_article: string }>(
          `SELECT texte, titre_article FROM droit_ci.articles WHERE article_id = $1 LIMIT 1`,
          [body.article_id],
        )
        // OWASP A04 — refus explicite si article_id pointe vers un article inexistant
        // (anti-pollution : sinon on créerait une proposition liée à un fantôme)
        if (!cur.rows[0]) {
          return reply.status(404).send({ error: `Article ${body.article_id} introuvable` })
        }
        currentText  = cur.rows[0].texte
        currentTitre = cur.rows[0].titre_article
      }

      let diff
      try {
        diff = await analyzeLegalDiff(currentText, body.proposed_text, body.context)
      } catch (err) {
        // OWASP A10 — masquer les détails internes Anthropic (stack, model, prompt).
        // Le pattern user-actionable est documenté dans le service legal-diff
        // (validation entrée). Tout autre msg = erreur générique côté client,
        // détail loggé serveur.
        const msg = err instanceof Error ? err.message : String(err)
        const isUserActionable = /trop court|trop long|configur|Clé Anthropic/i.test(msg)
        if (!isUserActionable) {
          fastify.log.error({ err: msg }, '[legal-watch] analyse IA échouée')
        }
        return reply.status(isUserActionable ? 422 : 500).send({
          error: isUserActionable ? msg : 'Erreur analyse IA — réessayez ou contactez le support',
        })
      }

      // Insère la proposition en pending
      const res = await pool.query<{ id: string }>(
        `INSERT INTO droit_ci.article_proposals
           (article_id, country_code, source, source_url, source_type,
            proposed_by, current_text, proposed_text,
            diff_summary, ai_confidence, ai_reasoning, ai_model, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
         RETURNING id`,
        [
          body.article_id ?? null, body.country_code, body.source,
          body.source_url ?? null, body.source_type,
          request.user.sub, currentText, body.proposed_text,
          diff.summary, diff.confidence, diff.reasoning, diff.model_used,
        ],
      )

      return reply.status(201).send({
        data: {
          id: res.rows[0]!.id,
          diff: {
            has_changes: diff.has_changes,
            confidence:  diff.confidence,
            summary:     diff.summary,
            reasoning:   diff.reasoning,
            key_changes: diff.key_changes,
            risk_level:  diff.risk_level,
          },
          article: body.article_id ? { id: body.article_id, title: currentTitre } : null,
        },
      })
    },
  })

  // ── GET /proposals : liste paginée ───────────────────────────────────────
  fastify.get('/proposals', {
    preHandler: [fastify.authorize('super_admin')],
    config: PROPOSALS_READ_LIMIT,
    handler: async (request, reply) => {
      const { status = 'pending', limit = '50', offset = '0' } = request.query as Record<string, string>
      const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 200)
      const off = Math.max(parseInt(offset) || 0, 0)
      const allowedStatuses = ['pending', 'approved', 'rejected', 'superseded', 'all']
      const s = allowedStatuses.includes(status) ? status : 'pending'
      const where = s === 'all' ? '' : `WHERE p.status = $1`
      const params: unknown[] = s === 'all' ? [] : [s]
      params.push(lim, off)
      const res = await pool.query(`
        SELECT p.id, p.article_id, p.country_code, p.source, p.source_url, p.source_type,
               p.proposed_at, p.proposed_by, p.diff_summary, p.ai_confidence,
               p.ai_model, p.status, p.reviewed_at, p.reviewed_by,
               a.titre_article AS current_title, a.article_numero
          FROM droit_ci.article_proposals p
          LEFT JOIN droit_ci.articles a ON a.article_id = p.article_id
          ${where}
          ORDER BY p.proposed_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params)
      const countRes = await pool.query(
        `SELECT count(*)::int AS cnt FROM droit_ci.article_proposals ${where}`,
        s === 'all' ? [] : [s],
      )
      return reply.send({ data: res.rows, total: countRes.rows[0]?.cnt ?? 0 })
    },
  })

  // ── GET /proposals/:id : détail (avec current_text + proposed_text) ─────
  fastify.get('/proposals/:id', {
    preHandler: [fastify.authorize('super_admin')],
    config: PROPOSALS_READ_LIMIT,
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // OWASP A03 — UUID strict (proposal IDs sont des UUID PG generated)
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const res = await pool.query(`
        SELECT p.*, a.titre_article AS current_title, a.article_numero
          FROM droit_ci.article_proposals p
          LEFT JOIN droit_ci.articles a ON a.article_id = p.article_id
          WHERE p.id = $1 LIMIT 1
      `, [id])
      if (!res.rows[0]) return reply.status(404).send({ error: 'Proposition introuvable' })
      return reply.send({ data: res.rows[0] })
    },
  })

  // ── POST /proposals/:id/approve : applique le diff (transaction) ────────
  // Étapes : pending → approved
  //   1. SELECT FOR UPDATE proposition (lock)
  //   2. Archive l'article actuel dans articles_history (si existant)
  //   3. UPDATE articles avec proposed_text + nouveau checksum
  //      OU INSERT si nouvel article
  //   4. UPDATE proposition status='approved' + reviewed_at + reviewed_by
  //   5. Audit log (OWASP A09)
  fastify.post('/proposals/:id/approve', {
    preHandler: [fastify.authorize('super_admin')],
    config: REVIEW_RATE_LIMIT,
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // OWASP A03 — UUID strict
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const parsed = reviewSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation échouée' })
      }
      const notes = parsed.data.notes ?? null

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // 1. Lock la proposition
        const propRes = await client.query<{
          id: string; article_id: string | null; country_code: string
          source: string; proposed_text: string; status: string
        }>(`
          SELECT id, article_id, country_code, source, proposed_text, status
            FROM droit_ci.article_proposals
            WHERE id = $1
            FOR UPDATE
        `, [id])
        const prop = propRes.rows[0]
        if (!prop) {
          await client.query('ROLLBACK')
          return reply.status(404).send({ error: 'Proposition introuvable' })
        }
        if (prop.status !== 'pending') {
          await client.query('ROLLBACK')
          return reply.status(409).send({
            error: `Proposition déjà ${prop.status} — impossible d'approuver`,
          })
        }

        let resultingArticleId = prop.article_id
        const newChecksum = createHash('sha256').update(prop.proposed_text).digest('hex')

        if (prop.article_id) {
          // 2. Archive version actuelle
          const curRes = await client.query<{
            titre_article: string; texte: string; keywords: string[]
            payroll_codes: string[]
          }>(`
            SELECT titre_article, texte, keywords, payroll_codes
              FROM droit_ci.articles
              WHERE article_id = $1
              FOR UPDATE
          `, [prop.article_id])
          const cur = curRes.rows[0]
          if (cur) {
            const versionRes = await client.query<{ max_v: number | null }>(`
              SELECT max(version)::int AS max_v
                FROM droit_ci.articles_history
                WHERE article_id = $1
            `, [prop.article_id])
            const nextVersion = (versionRes.rows[0]?.max_v ?? 0) + 1
            await client.query(`
              INSERT INTO droit_ci.articles_history
                (article_id, version, titre_article, texte, keywords, payroll_codes,
                 valid_until, replaced_by_proposal_id, archived_by)
              VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
            `, [
              prop.article_id, nextVersion, cur.titre_article, cur.texte,
              cur.keywords ?? [], cur.payroll_codes ?? [],
              prop.id, request.user.sub,
            ])

            // 3a. UPDATE article avec le nouveau texte
            await client.query(`
              UPDATE droit_ci.articles
                 SET texte = $1,
                     checksum_sha256 = $2,
                     last_verified_at = now(),
                     updated_at = now()
               WHERE article_id = $3
            `, [prop.proposed_text, newChecksum, prop.article_id])
          }
        } else {
          // 3b. INSERT nouvel article (cas rare : ajout pur).
          // OWASP A04 — ID cryptographique (UUID v4) au lieu de Date.now()
          // pour éviter toute collision si 2 propositions sont approuvées
          // dans la même milliseconde (rare mais déterministe = mauvaise idée).
          const newArticleId = `${prop.source}-${prop.country_code}-${randomUUID().slice(0, 12)}`
          await client.query(`
            INSERT INTO droit_ci.articles
              (article_id, article_numero, source, country_code,
               titre_article, texte, checksum_sha256, access_level, is_active)
            VALUES ($1, $1, $2, $3, 'Nouvel article', $4, $5, 'public', true)
          `, [newArticleId, prop.source, prop.country_code, prop.proposed_text, newChecksum])
          resultingArticleId = newArticleId
        }

        // 4. Marque la proposition approuvée
        await client.query(`
          UPDATE droit_ci.article_proposals
             SET status = 'approved',
                 reviewed_at = now(),
                 reviewed_by = $1,
                 review_notes = $2,
                 article_id = COALESCE(article_id, $3)
           WHERE id = $4
        `, [request.user.sub, notes, resultingArticleId, id])

        await client.query('COMMIT')

        // 5. Audit (non bloquant — log applicatif Fastify)
        fastify.log.info(
          {
            actor: request.user.sub, action: 'legal_watch.approve',
            proposal_id: id, article_id: resultingArticleId,
            checksum: newChecksum,
          },
          'Proposition approuvée',
        )

        return reply.send({
          data: { id, status: 'approved', article_id: resultingArticleId, checksum_sha256: newChecksum },
          message: 'Proposition appliquée — article mis à jour',
        })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        fastify.log.error({ err }, 'legal-watch.approve failed')
        return reply.status(500).send({ error: 'Erreur lors de l\'application' })
      } finally {
        client.release()
      }
    },
  })

  // ── POST /proposals/:id/reject ──────────────────────────────────────────
  fastify.post('/proposals/:id/reject', {
    preHandler: [fastify.authorize('super_admin')],
    config: REVIEW_RATE_LIMIT,
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      // OWASP A03 — UUID strict
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const parsed = reviewSchema.safeParse(request.body ?? {})
      if (!parsed.success) return reply.status(400).send({ error: 'Validation échouée' })
      const notes = parsed.data.notes ?? null

      const res = await pool.query<{ id: string; status: string }>(`
        UPDATE droit_ci.article_proposals
           SET status = 'rejected',
               reviewed_at = now(),
               reviewed_by = $1,
               review_notes = $2
         WHERE id = $3 AND status = 'pending'
         RETURNING id, status
      `, [request.user.sub, notes, id])
      if (!res.rows[0]) {
        return reply.status(409).send({ error: 'Proposition introuvable ou déjà traitée' })
      }
      // OWASP A09 — audit complet du reject (actor + notes + ip pour conformité
      // legale CI loi 2013-450 cybercriminalité, traçabilité 12 mois)
      fastify.log.info(
        {
          actor: request.user.sub, action: 'legal_watch.reject',
          proposal_id: id, notes: notes ?? null,
          ip: request.ip ?? null,
        },
        'Proposition rejetée',
      )
      return reply.send({ data: { id, status: 'rejected' } })
    },
  })

  // ── GET /sources-catalog : sites officiels par pays ─────────────────────
  // Catalogue statique des sources juridiques officielles (gouv, ministères,
  // CNPS, DGI...) pour aider le super_admin à configurer LEGAL_WATCH_SOURCES.
  fastify.get('/sources-catalog', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (request, reply) => {
      // OWASP A03 — country validé regex puis whitelist contre catalogue
      const parsed = sourcesCatalogQuerySchema.safeParse(request.query)
      if (!parsed.success) return reply.status(400).send({ error: 'country invalide (ISO 3166-1 alpha-3)' })
      const { country } = parsed.data
      if (country && !SUPPORTED_COUNTRIES.has(country)) {
        return reply.status(404).send({ error: `Pays ${country} non supporté par le catalogue` })
      }
      const data = country
        ? LEGAL_SOURCES_CATALOG.filter(s => s.countryCode === country)
        : LEGAL_SOURCES_CATALOG
      return reply.send({ data, total: data.length })
    },
  })

  // ── GET /stats : compteurs pour le badge sidebar ────────────────────────
  fastify.get('/stats', {
    preHandler: [fastify.authorize('super_admin')],
    handler: async (_req, reply) => {
      const res = await pool.query<{ status: string; cnt: number }>(`
        SELECT status, count(*)::int AS cnt
          FROM droit_ci.article_proposals
          GROUP BY status
      `)
      const stats = { pending: 0, approved: 0, rejected: 0, superseded: 0 }
      for (const r of res.rows) {
        if (r.status in stats) stats[r.status as keyof typeof stats] = r.cnt
      }
      return reply.send({ data: stats })
    },
  })
}

export default legalWatchRoutes
