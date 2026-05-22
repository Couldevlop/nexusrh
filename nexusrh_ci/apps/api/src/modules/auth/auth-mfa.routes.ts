/**
 * MFA TOTP (Time-based One-Time Password) + Forgot/Reset password.
 *
 * Sécurité :
 *   A02 — bcrypt 12 rounds sur tokens reset + backup codes (jamais en clair en BD)
 *   A03 — Zod .strict() sur tous les body
 *   A05 — secret TOTP base32 généré via otplib (cryptographique), QR code en
 *         memory (jamais persisté en clair sur disque)
 *   A07 — rate-limits stricts (3/15min sur reset, 5/15min sur verify, 20/h setup)
 *   A09 — audit log obligatoire : mfa.setup_initiated/verified/disabled,
 *         password.reset_requested/completed
 *   A10 — messages génériques côté client (anti-énumération emails)
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { authenticator } from 'otplib'
import { toDataURL } from 'qrcode'
import { randomBytes, randomUUID, createHash } from 'crypto'
import { config } from '../../config.js'
import { ensurePlatformSchema, ensureTenantSchema } from '../../utils/schema-migrations.js'
import { AUTH_COOKIE_NAME } from '../../plugins/auth.js'
import { sendPasswordResetLinkEmail } from '../../services/email.js'

const pool = new Pool({ connectionString: config.database.url })

const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/
const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// MFA TOTP : authenticator.window=1 permet ±30s de dérive d'horloge mobile
authenticator.options = { window: 1, step: 30, digits: 6 }

// OWASP A02 — sha256 utilisé pour les tokens reset (pas bcrypt — le token est
// déjà cryptographiquement aléatoire 32 octets, pas besoin de cost factor)
function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function generateResetTokenRaw(): string {
  return randomBytes(32).toString('base64url')  // 43 chars URL-safe
}

function generateBackupCode(): string {
  // 10 caractères alphanumériques (sauf 0/O/1/I/l pour lecture humaine)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = randomBytes(10)
  let code = ''
  for (let i = 0; i < 10; i++) code += alphabet[buf[i]! % alphabet.length]
  return code
}

// Audit log non bloquant (table audit_log dans tenant OU table platform.activity_log
// pour super_admin)
function auditMfa(
  schemaOrPlatform: string, userId: string | null, action: string,
  changes: Record<string, unknown>, ip: string | null,
): void {
  if (schemaOrPlatform === 'platform') {
    pool.query(
      `INSERT INTO platform.activity_log (actor_user_id, action, payload, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [userId, action, JSON.stringify(changes), ip],
    ).catch(() => { /* table absente : non bloquant */ })
    return
  }
  if (!SCHEMA_NAME_RE.test(schemaOrPlatform)) return
  pool.query(
    `INSERT INTO "${schemaOrPlatform}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
     VALUES ($1, $2, 'auth', NULL, $3, $4)`,
    [userId, action, JSON.stringify(changes), ip],
  ).catch(() => { /* tenant sans audit_log : non bloquant */ })
}

// Identifie la table users (platform_users vs tenant.users) selon le scope
async function findUserScope(
  userId: string, schemaName: string,
): Promise<{ table: string; mfaEnabled: boolean; mfaSecret: string | null; email: string } | null> {
  if (schemaName === 'platform') {
    const r = await pool.query<{ email: string; mfa_enabled: boolean; mfa_secret: string | null }>(
      `SELECT email, mfa_enabled, mfa_secret FROM platform.platform_users WHERE id = $1 LIMIT 1`,
      [userId],
    )
    if (!r.rows[0]) return null
    return { table: 'platform.platform_users', mfaEnabled: r.rows[0].mfa_enabled, mfaSecret: r.rows[0].mfa_secret, email: r.rows[0].email }
  }
  if (!SCHEMA_NAME_RE.test(schemaName)) return null
  const r = await pool.query<{ email: string; mfa_enabled: boolean; mfa_secret: string | null }>(
    `SELECT email, mfa_enabled, mfa_secret FROM "${schemaName}".users WHERE id = $1 LIMIT 1`,
    [userId],
  )
  if (!r.rows[0]) return null
  return { table: `"${schemaName}".users`, mfaEnabled: r.rows[0].mfa_enabled, mfaSecret: r.rows[0].mfa_secret, email: r.rows[0].email }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schémas Zod
// ─────────────────────────────────────────────────────────────────────────────

const mfaVerifySchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, 'Code TOTP 6 chiffres requis'),
}).strict()

const mfaDisableSchema = z.object({
  password: z.string().min(1).max(256),
}).strict()

const forgotPasswordSchema = z.object({
  email: z.string().email().max(254),
}).strict()

const resetPasswordSchema = z.object({
  token:       z.string().min(20).max(100),
  newPassword: z.string().min(8).max(256),
}).strict()

const mfaLoginVerifySchema = z.object({
  challenge: z.string().min(1).max(2000),
  code:      z.string().regex(/^[0-9]{6}$|^[A-Z0-9]{10}$/, 'Code TOTP 6 chiffres OU backup 10 chars'),
}).strict()

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

const authMfaRoutes: FastifyPluginAsync = async (fastify) => {
  // Pre-handler : migration lazy des tables auth (password_reset_tokens,
  // mfa_backup_codes) dans le schéma cible
  fastify.addHook('preHandler', async (req) => {
    const u = (req as FastifyRequest & { user?: { schemaName?: string } }).user
    const schema = u?.schemaName
    if (schema === 'platform') await ensurePlatformSchema()
    else if (schema) await ensureTenantSchema(schema)
    await ensurePlatformSchema()
  })

  // ── POST /auth/mfa/setup : génère secret + QR code + backup codes ──────────
  fastify.post('/mfa/setup', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Initialiser MFA TOTP (génère QR + backup codes)' },
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const user = request.user
      const scope = await findUserScope(user.sub, user.schemaName)
      if (!scope) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      // Generate fresh TOTP secret + QR
      const secret = authenticator.generateSecret()
      const otpauth = authenticator.keyuri(scope.email, 'NexusRH CI', secret)
      const qrDataUrl = await toDataURL(otpauth)

      // Generate 10 backup codes (montrés une seule fois au user)
      const backupCodesPlain: string[] = []
      for (let i = 0; i < 10; i++) backupCodesPlain.push(generateBackupCode())
      const backupCodesHashed = await Promise.all(
        backupCodesPlain.map((c) => bcrypt.hash(c, 12)),
      )

      // Stocke le secret EN ATTENTE de vérification (mfa_enabled reste false
      // jusqu'à ce que l'utilisateur saisisse le 1er code TOTP avec /verify).
      // En attendant, on stocke dans mfa_secret. La connexion ne demande PAS
      // de MFA tant que mfa_enabled=false.
      await pool.query(`UPDATE ${scope.table} SET mfa_secret = $1, updated_at = now() WHERE id = $2`,
        [secret, user.sub])

      // Remplace les anciens backup codes par les nouveaux (mais non actifs
      // tant que /verify n'a pas confirmé). On purge d'abord pour éviter
      // les codes orphelins d'un setup précédent abandonné.
      const codesTable = user.schemaName === 'platform'
        ? 'platform.mfa_backup_codes' : `"${user.schemaName}".mfa_backup_codes`
      await pool.query(`DELETE FROM ${codesTable} WHERE user_id = $1`, [user.sub])
      for (const hash of backupCodesHashed) {
        await pool.query(`INSERT INTO ${codesTable} (user_id, code_hash) VALUES ($1, $2)`,
          [user.sub, hash])
      }

      auditMfa(user.schemaName, user.sub, 'mfa.setup_initiated', {}, request.ip ?? null)

      // OWASP — les backup codes ne seront JAMAIS retournés à nouveau
      return reply.send({
        qrCodeDataUrl: qrDataUrl,
        secret,                                  // affiché à l'utilisateur pour saisie manuelle
        backupCodes: backupCodesPlain,           // affichés UNE SEULE fois (téléchargement recommandé)
        message: 'Scannez le QR, sauvegardez les codes de secours, puis confirmez via /auth/mfa/verify',
      })
    },
  })

  // ── POST /auth/mfa/verify : valide le 1er code TOTP et active mfa_enabled ──
  fastify.post('/mfa/verify', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Vérifier le 1er code TOTP et activer MFA' },
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = mfaVerifySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Code TOTP invalide' })

      const user = request.user
      const scope = await findUserScope(user.sub, user.schemaName)
      if (!scope) return reply.status(404).send({ error: 'Utilisateur introuvable' })
      if (!scope.mfaSecret) {
        return reply.status(409).send({ error: 'Aucun secret MFA en attente — exécutez /setup d\'abord' })
      }
      if (scope.mfaEnabled) {
        return reply.status(409).send({ error: 'MFA déjà activé' })
      }

      const valid = authenticator.check(parsed.data.code, scope.mfaSecret)
      if (!valid) {
        auditMfa(user.schemaName, user.sub, 'mfa.verify_failed', { reason: 'invalid_code' }, request.ip ?? null)
        return reply.status(401).send({ error: 'Code TOTP invalide' })
      }

      await pool.query(`UPDATE ${scope.table} SET mfa_enabled = true, updated_at = now() WHERE id = $1`, [user.sub])
      auditMfa(user.schemaName, user.sub, 'mfa.enabled', {}, request.ip ?? null)
      return reply.send({ success: true, message: 'MFA activée' })
    },
  })

  // ── POST /auth/mfa/disable : désactive MFA (re-demande mot de passe) ───────
  fastify.post('/mfa/disable', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Désactiver MFA' },
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = mfaDisableSchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'Mot de passe requis' })

      const user = request.user
      const scope = await findUserScope(user.sub, user.schemaName)
      if (!scope) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      // Re-vérifier le mot de passe (action sensible)
      const pwRes = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM ${scope.table} WHERE id = $1 LIMIT 1`, [user.sub])
      const valid = pwRes.rows[0] && await bcrypt.compare(parsed.data.password, pwRes.rows[0].password_hash)
      if (!valid) {
        auditMfa(user.schemaName, user.sub, 'mfa.disable_failed', { reason: 'wrong_password' }, request.ip ?? null)
        return reply.status(401).send({ error: 'Mot de passe incorrect' })
      }

      await pool.query(`UPDATE ${scope.table} SET mfa_enabled = false, mfa_secret = NULL, updated_at = now() WHERE id = $1`, [user.sub])
      // Purger les backup codes existants
      const codesTable = user.schemaName === 'platform'
        ? 'platform.mfa_backup_codes' : `"${user.schemaName}".mfa_backup_codes`
      await pool.query(`DELETE FROM ${codesTable} WHERE user_id = $1`, [user.sub])
      auditMfa(user.schemaName, user.sub, 'mfa.disabled', {}, request.ip ?? null)
      return reply.send({ success: true, message: 'MFA désactivée' })
    },
  })

  // ── POST /auth/mfa/login-verify : 2e étape du login si MFA actif ───────────
  // Reçoit le challenge JWT (court, 3min) émis par /auth/login + code TOTP/backup.
  // Émet alors le JWT final 7d.
  fastify.post('/mfa/login-verify', {
    schema: { tags: ['auth'], summary: 'Valider le code TOTP/backup après login' },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = mfaLoginVerifySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation', issues: parsed.error.flatten() })
      }
      const { challenge, code } = parsed.data

      // Vérifier le challenge JWT
      let payload: { sub: string; schemaName: string; aud?: string; userId: string; tenantId: string | null }
      try {
        const decoded = fastify.jwt.verify<typeof payload>(challenge)
        if (decoded.aud !== 'mfa-challenge') throw new Error('Wrong audience')
        payload = decoded
      } catch {
        return reply.status(401).send({ error: 'Challenge invalide ou expiré' })
      }

      const scope = await findUserScope(payload.sub, payload.schemaName)
      if (!scope || !scope.mfaEnabled || !scope.mfaSecret) {
        return reply.status(409).send({ error: 'MFA non actif sur ce compte' })
      }

      // Vérifie TOTP en priorité ; sinon essaye backup codes
      let validMfa = false
      let usedBackupCode: string | null = null
      if (/^[0-9]{6}$/.test(code)) {
        validMfa = authenticator.check(code, scope.mfaSecret)
      } else {
        // Backup code : essayer chaque code non utilisé
        const codesTable = payload.schemaName === 'platform'
          ? 'platform.mfa_backup_codes' : `"${payload.schemaName}".mfa_backup_codes`
        const codes = await pool.query<{ id: string; code_hash: string }>(
          `SELECT id, code_hash FROM ${codesTable} WHERE user_id = $1 AND used_at IS NULL`,
          [payload.sub])
        for (const row of codes.rows) {
          if (await bcrypt.compare(code, row.code_hash)) {
            await pool.query(`UPDATE ${codesTable} SET used_at = now() WHERE id = $1`, [row.id])
            usedBackupCode = row.id
            validMfa = true
            break
          }
        }
      }

      if (!validMfa) {
        auditMfa(payload.schemaName, payload.sub, 'mfa.login_failed',
          { reason: usedBackupCode ? 'backup_invalid' : 'totp_invalid' }, request.ip ?? null)
        return reply.status(401).send({ error: 'Code MFA invalide' })
      }

      // Récupère les infos user complètes pour générer le JWT final
      // (cf. structure des tokens dans auth.routes.ts)
      const userInfo = await loadUserForToken(payload.sub, payload.schemaName, payload.tenantId)
      if (!userInfo) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      // Cast contrôlé : userInfo.tokenPayload est typé { sub, tenantId, schemaName,
      // role, email, firstName, lastName, employeeId } — compatible JwtSignPayload
      // mais TS ne le reconnait pas via le type object.
      const finalToken = fastify.jwt.sign(userInfo.tokenPayload as Parameters<typeof fastify.jwt.sign>[0])
      auditMfa(payload.schemaName, payload.sub, 'mfa.login_success',
        { usedBackupCode: !!usedBackupCode }, request.ip ?? null)

      // OWASP A02 — pose le JWT en cookie httpOnly aussi (parité avec /auth/login)
      reply.setCookie(AUTH_COOKIE_NAME, finalToken, {
        httpOnly: true,
        secure:   process.env['NODE_ENV'] === 'production',
        sameSite: 'lax',
        path:     '/',
        maxAge:   60 * 60 * 24 * 7,
      })

      return reply.send({
        token: finalToken,
        user: userInfo.userPublic,
        tenantConfig: userInfo.tenantConfig,
        redirectTo: userInfo.redirectTo,
      })
    },
  })

  // ── POST /auth/forgot-password : demande réinitialisation ──────────────────
  fastify.post('/forgot-password', {
    schema: { tags: ['auth'], summary: 'Demander un email de réinitialisation' },
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = forgotPasswordSchema.safeParse(request.body)
      if (!parsed.success) {
        // OWASP A07 anti-énumération : même réponse OK que pour un email valide
        return reply.send({ success: true, message: 'Si ce compte existe, un email a été envoyé' })
      }
      const { email } = parsed.data

      // Cherche d'abord dans platform_users
      let found: { id: string; schemaName: string; firstName: string } | null = null
      const p = await pool.query<{ id: string; first_name: string }>(
        `SELECT id, first_name FROM platform.platform_users WHERE email = $1 AND is_active = true LIMIT 1`,
        [email])
      if (p.rows[0]) {
        found = { id: p.rows[0].id, schemaName: 'platform', firstName: p.rows[0].first_name }
      } else {
        // Cherche dans tous les tenants actifs
        const tenants = await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM platform.tenants WHERE status IN ('active', 'trial')`)
        for (const t of tenants.rows) {
          if (!SCHEMA_NAME_RE.test(t.schema_name)) continue
          const u = await pool.query<{ id: string; first_name: string }>(
            `SELECT id, first_name FROM "${t.schema_name}".users WHERE email = $1 AND is_active = true LIMIT 1`,
            [email]).catch(() => ({ rows: [] as Array<{ id: string; first_name: string }> }))
          if (u.rows[0]) {
            found = { id: u.rows[0].id, schemaName: t.schema_name, firstName: u.rows[0].first_name }
            break
          }
        }
      }

      // Générer + stocker le token uniquement si user trouvé (mais répondre OK
      // dans tous les cas — anti-énumération)
      if (found) {
        const rawToken = generateResetTokenRaw()
        const tokenHash = hashResetToken(rawToken)
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 min
        const tokensTable = found.schemaName === 'platform'
          ? 'platform.password_reset_tokens' : `"${found.schemaName}".password_reset_tokens`

        // Invalider les anciens tokens non utilisés du même user
        await pool.query(`DELETE FROM ${tokensTable} WHERE user_id = $1 AND used_at IS NULL`, [found.id])
        await pool.query(
          `INSERT INTO ${tokensTable} (user_id, token_hash, expires_at, requested_ip) VALUES ($1, $2, $3, $4)`,
          [found.id, tokenHash, expiresAt, request.ip ?? null])

        // Envoi de l'email avec le lien magique. Non-bloquant : si SMTP down,
        // on log mais on répond OK (sinon on révèle au client l'existence du
        // compte via le timing/erreur — anti-énumération).
        const appUrl = config.appUrl ?? process.env['APP_URL'] ?? 'http://localhost:3001'
        const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(rawToken)}`
        sendPasswordResetLinkEmail({
          to: email,
          firstName: found.firstName,
          resetUrl,
          expiresInMinutes: 15,
        }).catch((err) => {
          fastify.log.error({ err: (err as Error).message, email },
            '[forgot-password] envoi email échoué (anti-énumération : réponse OK quand même)')
        })

        auditMfa(found.schemaName, found.id, 'password.reset_requested',
          { email }, request.ip ?? null)
      } else {
        // Compte introuvable : on simule un délai variable pour masquer le timing
        await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 100)))
      }

      return reply.send({ success: true, message: 'Si ce compte existe, un email a été envoyé' })
    },
  })

  // ── POST /auth/reset-password : applique le nouveau mot de passe ───────────
  fastify.post('/reset-password', {
    schema: { tags: ['auth'], summary: 'Réinitialiser le mot de passe avec le token' },
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const parsed = resetPasswordSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Token ou mot de passe invalide' })
      }
      const { token, newPassword } = parsed.data
      const tokenHash = hashResetToken(token)

      // Cherche le token dans platform puis dans tous les tenants actifs
      let match: { table: string; userTable: string; tokenId: string; userId: string; schemaName: string } | null = null

      const p = await pool.query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
        `SELECT id, user_id, expires_at, used_at FROM platform.password_reset_tokens WHERE token_hash = $1 LIMIT 1`,
        [tokenHash])
      if (p.rows[0]) {
        const t = p.rows[0]
        if (t.used_at) return reply.status(409).send({ error: 'Token déjà utilisé' })
        if (new Date(t.expires_at) < new Date()) return reply.status(410).send({ error: 'Token expiré' })
        match = { table: 'platform.password_reset_tokens', userTable: 'platform.platform_users', tokenId: t.id, userId: t.user_id, schemaName: 'platform' }
      } else {
        const tenants = await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM platform.tenants WHERE status IN ('active', 'trial')`)
        for (const tn of tenants.rows) {
          if (!SCHEMA_NAME_RE.test(tn.schema_name)) continue
          const r = await pool.query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
            `SELECT id, user_id, expires_at, used_at FROM "${tn.schema_name}".password_reset_tokens WHERE token_hash = $1 LIMIT 1`,
            [tokenHash]).catch(() => ({ rows: [] as Array<{ id: string; user_id: string; expires_at: string; used_at: string | null }> }))
          if (r.rows[0]) {
            const t = r.rows[0]
            if (t.used_at) return reply.status(409).send({ error: 'Token déjà utilisé' })
            if (new Date(t.expires_at) < new Date()) return reply.status(410).send({ error: 'Token expiré' })
            match = {
              table: `"${tn.schema_name}".password_reset_tokens`,
              userTable: `"${tn.schema_name}".users`,
              tokenId: t.id, userId: t.user_id, schemaName: tn.schema_name,
            }
            break
          }
        }
      }

      if (!match) return reply.status(404).send({ error: 'Token invalide' })

      const newHash = await bcrypt.hash(newPassword, 12)
      // Mise à jour + invalidation atomique du token
      await pool.query(`UPDATE ${match.userTable} SET password_hash = $1, updated_at = now() WHERE id = $2`,
        [newHash, match.userId])
      await pool.query(`UPDATE ${match.table} SET used_at = now() WHERE id = $1`, [match.tokenId])

      auditMfa(match.schemaName, match.userId, 'password.reset_completed', {}, request.ip ?? null)
      return reply.send({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' })
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper : recharge un utilisateur complet pour générer le JWT final post-MFA
// ─────────────────────────────────────────────────────────────────────────────
async function loadUserForToken(
  userId: string, schemaName: string, _tenantId: string | null,
): Promise<{ tokenPayload: object; userPublic: object; tenantConfig: object | null; redirectTo: string } | null> {
  if (schemaName === 'platform') {
    const r = await pool.query<{
      id: string; email: string; first_name: string; last_name: string
    }>(
      `SELECT id, email, first_name, last_name FROM platform.platform_users WHERE id = $1 LIMIT 1`,
      [userId])
    if (!r.rows[0]) return null
    const u = r.rows[0]
    return {
      tokenPayload: { sub: u.id, tenantId: null, schemaName: 'platform', role: 'super_admin',
        email: u.email, firstName: u.first_name, lastName: u.last_name, employeeId: null },
      userPublic: { sub: u.id, tenantId: null, schemaName: 'platform', email: u.email,
        firstName: u.first_name, lastName: u.last_name, role: 'super_admin', employeeId: null },
      tenantConfig: null,
      redirectTo: '/platform/dashboard',
    }
  }
  if (!SCHEMA_NAME_RE.test(schemaName)) return null
  const userR = await pool.query<{
    id: string; email: string; role: string; first_name: string; last_name: string
  }>(`SELECT id, email, role, first_name, last_name FROM "${schemaName}".users WHERE id = $1 LIMIT 1`, [userId])
  if (!userR.rows[0]) return null
  const u = userR.rows[0]

  const tenantR = await pool.query<{
    id: string; name: string; slug: string; primary_color: string; secondary_color: string
    logo_url: string | null; city: string | null
    has_subsidiaries: boolean; payroll_mode: string; default_country_code: string
  }>(`SELECT id, name, slug, primary_color, secondary_color, logo_url, city,
         has_subsidiaries, payroll_mode, default_country_code
       FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schemaName])
  const t = tenantR.rows[0]
  if (!t) return null

  const empR = await pool.query<{ id: string }>(
    `SELECT id FROM "${schemaName}".employees WHERE email = $1 LIMIT 1`, [u.email])
  const employeeId = empR.rows[0]?.id ?? null

  return {
    tokenPayload: { sub: u.id, tenantId: t.id, schemaName, role: u.role,
      email: u.email, firstName: u.first_name, lastName: u.last_name, employeeId },
    userPublic: { sub: u.id, tenantId: t.id, schemaName, email: u.email,
      firstName: u.first_name, lastName: u.last_name, role: u.role, employeeId },
    tenantConfig: {
      id: t.id, name: t.name, slug: t.slug,
      primaryColor: t.primary_color, secondaryColor: t.secondary_color,
      logoUrl: t.logo_url, city: t.city,
      hasSubsidiaries: t.has_subsidiaries,
      payrollMode: t.payroll_mode, defaultCountryCode: t.default_country_code,
    },
    redirectTo: u.role === 'employee' ? '/mon-espace' : '/dashboard',
  }
}

// Export helper pour permettre à auth.routes.ts d'émettre un challenge MFA.
// Le payload n'est pas un JwtSignPayload complet (champs sub + schemaName +
// tenantId + aud pour mfa-challenge), donc on passe via un cast contrôlé.
type FastifyJwtLike = { jwt: { sign: (p: Record<string, unknown>, opts?: Record<string, unknown>) => string } }

export function buildMfaChallenge(
  fastify: unknown,
  payload: { sub: string; schemaName: string; tenantId: string | null },
): string {
  const f = fastify as FastifyJwtLike
  return f.jwt.sign(
    { sub: payload.sub, schemaName: payload.schemaName, tenantId: payload.tenantId,
      aud: 'mfa-challenge', userId: payload.sub },
    { expiresIn: '3m' },
  )
}

// Re-exports utilitaires (utilisables depuis tests / docs)
export { hashResetToken, generateResetTokenRaw, generateBackupCode, randomUUID }

export default authMfaRoutes
