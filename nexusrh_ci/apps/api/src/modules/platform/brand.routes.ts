import type { FastifyPluginAsync } from 'fastify'
import { config } from '../../config.js'
import { pool } from '../../db/pool.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// OWASP A03 (content-type spoofing) : allowlist stricte. SVG VOLONTAIREMENT exclu
// (un SVG peut embarquer du <script> → XSS stocké servi depuis l'origine API).
const LOGO_ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const LOGO_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

/**
 * Upload de logo (tenant ou cabinet) — stocké en base (platform.brand_assets,
 * bytea) et servi par GET /public/brand/:id. Renvoie une URL ABSOLUE que le
 * caller pose ensuite dans tenants.logo_url / agencies.logo_url (réutilise le
 * plumbing logo_url existant) et qui s'affiche dans les emails de connexion.
 *
 * Autorisé : super_admin (logos tenants/cabinets) + agency_owner (son cabinet
 * et ses tenants clients).
 */
export const brandRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/logo', {
    preHandler: [fastify.authorize('super_admin', 'agency_owner')],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: { tags: ['platform'], summary: 'Uploader un logo (tenant/cabinet)' },
    handler: async (request, reply) => {
      try {
        const file = await request.file()
        if (!file) return reply.status(400).send({ error: 'Aucun fichier reçu' })
        const mimetype = (file.mimetype || '').toLowerCase()
        if (!LOGO_ALLOWED_MIMES.has(mimetype)) {
          return reply.status(400).send({ error: 'Format non autorisé. Accepté : PNG, JPEG, WEBP, GIF.' })
        }
        const buf = await file.toBuffer()
        if (buf.byteLength > LOGO_MAX_BYTES) {
          return reply.status(400).send({ error: `Image trop volumineuse (max ${LOGO_MAX_BYTES / (1024 * 1024)} MB).` })
        }
        const res = await pool.query<{ id: string }>(
          `INSERT INTO platform.brand_assets (mime, bytes) VALUES ($1, $2) RETURNING id`,
          [mimetype, buf])
        const id = res.rows[0]?.id
        if (!id) throw new Error('insert brand_asset failed')
        const url = `${config.apiUrl}/public/brand/${id}`
        return reply.status(201).send({ data: { id, url, mime: mimetype, size: buf.byteLength } })
      } catch (err) {
        fastify.log.error({ err }, 'logo upload failed')
        return reply.status(500).send({ error: 'Erreur upload logo' })
      }
    },
  })
}

/**
 * Service PUBLIC des logos (non authentifié — un logo n'est pas un secret, et il
 * doit être chargeable depuis un client email). Monté sous /public/brand.
 */
export const publicBrandRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/:id', {
    schema: { hide: true },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide' })
      const res = await pool.query<{ mime: string; bytes: Buffer }>(
        `SELECT mime, bytes FROM platform.brand_assets WHERE id = $1 LIMIT 1`, [id])
      const row = res.rows[0]
      if (!row) return reply.status(404).send({ error: 'Logo introuvable' })
      reply
        .header('Content-Type', row.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'public, max-age=86400')
      return reply.send(row.bytes)
    },
  })
}
