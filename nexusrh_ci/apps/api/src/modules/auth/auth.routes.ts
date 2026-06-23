import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool } from '../../db/pool.js'
import { blacklistTokenSafe } from '../../services/redis.js'
import { buildMfaChallenge } from './auth-mfa.routes.js'
import { AUTH_COOKIE_NAME } from '../../plugins/auth.js'
import {
  getSecurityPolicy,
  isPasswordExpired,
  isPasswordReused,
  effectiveTenantMfaRequired,
  toLockoutPolicy,
} from '../../services/security-policy.service.js'
import { isPasswordBreached } from '../../services/breach-check.service.js'
import { DEFAULT_OFFLINE_MESSAGE } from '../../services/offline-status.service.js'
import { redisLockoutStore } from '../../services/redis.js'
import { checkLockout, registerFailure, clearFailures } from '../../services/account-lockout.service.js'
import { assertAgencyCanActOnTenant } from '../../services/agency.service.js'
import { resolveEnabledModules } from '../../services/tenant-modules.service.js'
import { issueRefreshToken, consumeRefreshToken, revokeRefreshToken, verifyAccountActive } from '../../services/refresh-token.service.js'

// OWASP A02 — options du cookie httpOnly de session.
// httpOnly  : JS ne peut pas lire le cookie (anti-XSS exfiltration)
// secure    : envoyé uniquement en HTTPS (anti MITM, sauf en dev local)
// sameSite  : 'lax' = pas envoyé sur requêtes cross-site POST (anti-CSRF basique)
// path '/'  : disponible sur toutes les routes /api/*
// maxAge    : 7 jours par défaut (aligné JWT_EXPIRES_IN), ajustable
function authCookieOptions(): {
  httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number
} {
  return {
    httpOnly: true,
    secure:   process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24 * 7,
  }
}

// OWASP A05 — sanity-check du nom de schema (defense in depth, le schema vient
// d'une jointure platform.tenants donc déjà sûr, mais regex empêche toute
// dérive future qui interpolerait un schema mal contrôlé).
const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/

// OWASP A02 — hash bcrypt "dummy" pré-calculé. Utilisé pour comparer même
// lorsque l'email est introuvable, afin de garder un temps de réponse
// constant (mitige timing attack qui révèlerait l'existence d'un email).
// Coût 12 rounds identique aux hashs réels.
const DUMMY_BCRYPT_HASH = '$2a$12$YmZvc2htYWxlc3BoZXJlb.uPnVfM7g8e4PYJVxLLDh89gGmJ8N3ge'

// OWASP A03 — schémas Zod stricts
const loginSchema = z.object({
  email:    z.string().email().max(254),
  password: z.string().min(1).max(256),
}).strict()

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
}).strict()

// OWASP A07 — rate-limits durcis sur les endpoints d'auth (cibles privilégiées
// du brute force et du credential stuffing).
const LOGIN_RATE_LIMIT           = { rateLimit: { max: 10, timeWindow: '5 minutes' } }
const CHANGE_PASSWORD_RATE_LIMIT = { rateLimit: { max: 5,  timeWindow: '5 minutes' } }
const REFRESH_RATE_LIMIT         = { rateLimit: { max: 60, timeWindow: '1 minute'  } }

// OWASP A09 — audit log non bloquant des actions d'auth (login OK/KO,
// logout, change password). Critique pour conformité (loi 2013-450 CI
// sur la cybercriminalité — exigence traçabilité 12 mois).
function auditLogAuth(
  schema: string, userId: string | null, action: string,
  changes: Record<string, unknown>, ip: string | null, userAgent: string | null,
): void {
  if (!SCHEMA_NAME_RE.test(schema)) return
  pool.query(
    `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address, user_agent)
     VALUES ($1, $2, 'auth', NULL, $3, $4, $5)`,
    [userId, action, JSON.stringify(changes), ip, userAgent],
  ).catch(() => { /* tenant sans audit_log ou colonne user_agent absente : non bloquant */ })
}

interface TenantCandidate {
  tenant: {
    id: string; schema_name: string; name: string; slug: string
    primary_color: string; secondary_color: string; logo_url: string | null
    city: string | null
    has_subsidiaries: boolean
    payroll_mode: string
    default_country_code: string
    mfa_required: boolean
    enabled_modules: unknown
  }
  user: {
    id: string; email: string; password_hash: string; role: string
    first_name: string; last_name: string; mfa_enabled: boolean
    is_active: boolean; last_login_at: string | null
    password_changed_at: string | null
  }
}

async function findTenantAndUser(
  email: string,
  password: string,
  log?: { warn: (msg: string) => void },
): Promise<TenantCandidate | null> {
  const tenantsRes = await pool.query<{
    id: string; schema_name: string; name: string; slug: string
    primary_color: string; secondary_color: string; logo_url: string | null
    city: string | null
    has_subsidiaries: boolean; payroll_mode: string; default_country_code: string
    mfa_required: boolean; enabled_modules: unknown
  }>(`SELECT id, schema_name, name, slug, primary_color, secondary_color, logo_url, city,
             has_subsidiaries, payroll_mode, default_country_code,
             COALESCE(mfa_required, false) AS mfa_required,
             COALESCE(enabled_modules, '{}'::jsonb) AS enabled_modules
      FROM platform.tenants WHERE status IN ('active', 'trial')`)

  const candidates: TenantCandidate[] = []

  for (const tenant of tenantsRes.rows) {
    if (!SCHEMA_NAME_RE.test(tenant.schema_name)) continue
    try {
      const userRes = await pool.query<{
        id: string; email: string; password_hash: string; role: string
        first_name: string; last_name: string; mfa_enabled: boolean; is_active: boolean
        last_login_at: string | null; password_changed_at: string | null
      }>(
        `SELECT id, email, password_hash, role, first_name, last_name, mfa_enabled, is_active,
                last_login_at, password_changed_at
         FROM "${tenant.schema_name}".users WHERE email = $1 LIMIT 1`,
        [email],
      )
      if (userRes.rows[0]) {
        candidates.push({ tenant, user: userRes.rows[0] })
      }
    } catch (err) {
      log?.warn(`[auth] schema ${tenant.schema_name} lookup failed: ${(err as Error).message}`)
    }
  }

  if (candidates.length === 0) {
    log?.warn(`[auth] no user found across ${tenantsRes.rows.length} tenants`)
    return null
  }

  for (const c of candidates) {
    if (!c.user.is_active) {
      log?.warn(`[auth] inactive user in ${c.tenant.schema_name}`)
      continue
    }
    const valid = await bcrypt.compare(password, c.user.password_hash)
    if (valid) return c
    log?.warn(`[auth] password mismatch in ${c.tenant.schema_name}`)
  }

  return null
}

interface AgencyCandidate {
  id: string; email: string; password_hash: string; role: string
  first_name: string; last_name: string; mfa_enabled: boolean
  is_active: boolean; password_changed_at: string | null
  agency_id: string; agency_name: string; agency_status: string
  agency_offline_message: string | null
  primary_color: string | null; logo_url: string | null; city: string | null
}

// Cabinet de recrutement : lookup d'un utilisateur dans platform.agency_users.
// Non bloquant si les tables n'existent pas encore (bases pré-migration). Un
// user inactif → null (login refusé, pas de fuite de motif). Un cabinet suspendu
// est retourné AVEC son statut : le handler ne révèle le message hors-ligne
// qu'après vérification du mot de passe (OWASP A07 — pas de fuite d'existence).
async function findAgencyUser(email: string): Promise<AgencyCandidate | null> {
  try {
    const r = await pool.query<AgencyCandidate>(
      `SELECT au.id, au.email, au.password_hash, au.role, au.first_name, au.last_name,
              au.mfa_enabled, au.is_active, au.password_changed_at,
              a.id AS agency_id, a.name AS agency_name, a.status AS agency_status,
              a.offline_message AS agency_offline_message,
              a.primary_color, a.logo_url, a.city
       FROM platform.agency_users au
       JOIN platform.agencies a ON a.id = au.agency_id
       WHERE au.email = $1 LIMIT 1`,
      [email],
    ).catch(() =>
      // Repli pré-migration : colonne offline_message absente.
      pool.query<AgencyCandidate>(
        `SELECT au.id, au.email, au.password_hash, au.role, au.first_name, au.last_name,
                au.mfa_enabled, au.is_active, au.password_changed_at,
                a.id AS agency_id, a.name AS agency_name, a.status AS agency_status,
                NULL AS agency_offline_message,
                a.primary_color, a.logo_url, a.city
         FROM platform.agency_users au
         JOIN platform.agencies a ON a.id = au.agency_id
         WHERE au.email = $1 LIMIT 1`,
        [email],
      )
    )
    const row = r.rows[0]
    if (!row || !row.is_active) return null
    return row
  } catch {
    return null
  }
}

// Tenant hors ligne : recherche d'identifiants VALIDES sur un tenant suspendu.
// Appelé uniquement quand le chemin nominal (tenants actifs) n'a rien trouvé →
// zéro régression. Le message hors-ligne n'est retourné que si le mot de passe
// est correct (OWASP A07 — un attaquant ne peut pas sonder les tenants suspendus).
async function findSuspendedTenantLogin(
  email: string,
  password: string,
): Promise<{ schemaName: string; userId: string; message: string | null } | null> {
  try {
    const tenantsRes = await pool.query<{ schema_name: string; offline_message: string | null }>(
      `SELECT schema_name, offline_message FROM platform.tenants WHERE status = 'suspended'`
    ).catch(() =>
      pool.query<{ schema_name: string; offline_message: string | null }>(
        `SELECT schema_name, NULL AS offline_message FROM platform.tenants WHERE status = 'suspended'`
      )
    )
    for (const tenant of tenantsRes.rows) {
      if (!SCHEMA_NAME_RE.test(tenant.schema_name)) continue
      try {
        const userRes = await pool.query<{ id: string; password_hash: string; is_active: boolean }>(
          `SELECT id, password_hash, is_active FROM "${tenant.schema_name}".users WHERE email = $1 LIMIT 1`,
          [email],
        )
        const user = userRes.rows[0]
        if (!user || !user.is_active) continue
        if (await bcrypt.compare(password, user.password_hash)) {
          return { schemaName: tenant.schema_name, userId: user.id, message: tenant.offline_message ?? null }
        }
      } catch { /* schéma incomplet : ignorer */ }
    }
  } catch { /* table/colonne absente : ignorer */ }
  return null
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/login
  fastify.post('/login', {
    schema: { tags: ['auth'], summary: 'Connexion unifiée (super_admin + tenant)' },
    config: LOGIN_RATE_LIMIT,
    handler: async (request, reply) => {
      // OWASP A03 — validation Zod stricte (rejette champs inconnus, email mal formé)
      const parsed = loginSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Email et mot de passe requis' })
      }
      const { email, password } = parsed.data
      const ip   = request.ip ?? null
      const ua   = request.headers['user-agent']?.slice(0, 500) ?? null

      try {
        // OWASP A07 — politique de sécurité paramétrable (super_admin). Lue une
        // fois par login ; ne lève jamais (défauts si table/colonnes absentes).
        const policy = await getSecurityPolicy(pool)
        const now = new Date()

        // OWASP A07 — verrouillage de compte (brute-force). Compteurs Redis par
        // email, fail-open si Redis indisponible. Contrôlé AVANT toute vérif de
        // mot de passe : un compte verrouillé est refusé sans révéler le motif
        // exact des identifiants.
        const lockoutPolicy = toLockoutPolicy(policy)
        const lock = await checkLockout(redisLockoutStore, email, lockoutPolicy)
        if (lock.locked) {
          auditLogAuth('platform', null, 'auth.login.locked',
            { email, retryAfterSec: lock.retryAfterSec }, ip, ua)
          reply.header('Retry-After', String(lock.retryAfterSec))
          return reply.status(423).send({
            error: `Compte temporairement verrouillé suite à trop de tentatives. Réessayez dans ${Math.ceil(lock.retryAfterSec / 60)} min.`,
          })
        }

        // 1. Vérifier si c'est un super_admin (platform)
        const platformRes = await pool.query<{
          id: string; email: string; password_hash: string; role: string
          first_name: string; last_name: string; mfa_enabled: boolean; is_active: boolean
          password_changed_at: string | null
        }>(
          `SELECT id, email, password_hash, role, first_name, last_name, mfa_enabled, is_active,
                  password_changed_at
           FROM platform.platform_users WHERE email = $1 LIMIT 1`,
          [email],
        )

        const platformUser = platformRes.rows[0]
        if (platformUser && platformUser.is_active) {
          const valid = await bcrypt.compare(password, platformUser.password_hash)
          if (valid) {
            // OWASP A07 — mot de passe correct : réinitialise le compteur d'échecs.
            await clearFailures(redisLockoutStore, email)
            // MFA actif : émet un challenge 3min au lieu du JWT final.
            // Le client doit ensuite appeler POST /auth/mfa/login-verify avec
            // le code TOTP (ou backup) pour obtenir le vrai token.
            if (platformUser.mfa_enabled) {
              const challenge = buildMfaChallenge(fastify, {
                sub: platformUser.id, schemaName: 'platform', tenantId: null,
              })
              auditLogAuth('platform', platformUser.id, 'auth.login.mfa_required', { scope: 'platform' }, ip, ua)
              return reply.status(202).send({
                mfaRequired: true,
                challenge,
                message: 'Saisissez votre code TOTP pour finaliser la connexion',
              })
            }

            // OWASP A07 — MFA obligatoire super_admin UNIQUEMENT si la politique
            // l'exige (paramétrable, désactivée par défaut). Si exigé sans MFA
            // actif, on émet un token RESTREINT (mfaPending) limité au parcours
            // d'activation MFA. Désactivée par défaut → accès normal (débloque la
            // création de tenant).
            const mfaPending = policy.mfaRequiredSuperAdmin && !platformUser.mfa_enabled

            // OWASP A07 — mot de passe expiré (durée de vie) ou présent dans une
            // fuite (vérifié si internet) → on force le changement via un token
            // restreint à /auth/change-password. Pas de verrouillage du compte.
            // Sauté si mfaPending (parcours MFA prioritaire).
            const expired = !mfaPending &&
              isPasswordExpired(platformUser.password_changed_at, policy.passwordMaxAgeDays, now)
            let breached = false
            if (!mfaPending && policy.breachCheckEnabled) {
              breached = (await isPasswordBreached(password)) === true
            }
            const pwdResetRequired = !mfaPending && (expired || breached)

            const token = fastify.jwt.sign({
              sub:        platformUser.id,
              tenantId:   null,
              schemaName: 'platform',
              role:       'super_admin',
              email:      platformUser.email,
              firstName:  platformUser.first_name,
              lastName:   platformUser.last_name,
              employeeId: null,
              ...(mfaPending ? { mfaPending: true } : {}),
              ...(pwdResetRequired ? { pwdResetRequired: true } : {}),
            })
            await pool.query(
              `UPDATE platform.platform_users SET updated_at = now() WHERE id = $1`,
              [platformUser.id],
            )
            auditLogAuth('platform', platformUser.id, 'auth.login.success',
              { scope: 'platform', mfaSetupRequired: mfaPending, passwordExpired: expired, passwordBreached: breached }, ip, ua)
            // OWASP A02 — pose le JWT en cookie httpOnly (mode SPA). Le client
            // browser n'a plus à manipuler le token en JS. Les clients API
            // peuvent toujours utiliser le `token` renvoyé en JSON dans Authorization.
            reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions())
            // Refresh token rotatif (renouvellement silencieux du JWT — AUTH-008).
            // PAS de refresh token tant qu'un MFA est requis ou que le mot de
            // passe doit être changé (expiré/compromis) : sinon un rafraîchissement
            // émettrait un JWT « propre » contournant le garde pwdResetRequired.
            const refreshToken = (mfaPending || pwdResetRequired) ? null : await issueRefreshToken(pool, {
              sub: platformUser.id, tenantId: null, schemaName: 'platform', role: 'super_admin',
              email: platformUser.email, firstName: platformUser.first_name, lastName: platformUser.last_name, employeeId: null,
            })
            return reply.send({
              token,
              refreshToken,
              // Le frontend doit forcer l'activation MFA quand ce flag est vrai
              // (le token n'autorise rien d'autre côté serveur).
              mfaSetupRequired: mfaPending,
              // Forcer le changement de mot de passe (expiré/compromis).
              must_change_password: pwdResetRequired,
              passwordExpired: expired,
              passwordBreached: breached,
              user: {
                sub:        platformUser.id,
                tenantId:   null,
                schemaName: 'platform',
                email:      platformUser.email,
                firstName:  platformUser.first_name,
                lastName:   platformUser.last_name,
                role:       'super_admin',
                employeeId: null,
              },
              tenantConfig: null,
              redirectTo: pwdResetRequired ? '/change-password' : '/platform/dashboard',
            })
          }
        } else if (!platformUser) {
          // OWASP A02 — bcrypt dummy pour temps de réponse constant même
          // quand l'email est introuvable (timing attack mitigation).
          await bcrypt.compare(password, DUMMY_BCRYPT_HASH)
        }

        // 2. Chercher dans les tenants
        const candidate = await findTenantAndUser(email, password, fastify.log)
        if (!candidate) {
          // 2bis. CABINET de recrutement (platform.agency_users). Vérifié
          // seulement si aucun tenant ne matche → le chemin tenant nominal reste
          // inchangé (zéro régression). Acteur multi-tenant : contexte cabinet
          // (schemaName='platform'), bascule ensuite vers un tenant client via
          // POST /agency/sessions/activate.
          const agencyUser = await findAgencyUser(email)
          if (agencyUser && await bcrypt.compare(password, agencyUser.password_hash)) {
            await clearFailures(redisLockoutStore, email)

            // Cabinet mis hors ligne par le super_admin : identifiants corrects
            // mais accès refusé, avec le message configuré (OWASP A07 — le
            // message n'est révélé qu'après vérification du mot de passe).
            if (agencyUser.agency_status !== 'active') {
              auditLogAuth('platform', agencyUser.id, 'auth.login.blocked_offline',
                { scope: 'agency', agencyId: agencyUser.agency_id }, ip, ua)
              return reply.status(503).send({
                error: agencyUser.agency_offline_message || DEFAULT_OFFLINE_MESSAGE,
                offline: true,
              })
            }

            // MFA actif : challenge TOTP (contexte plateforme).
            if (agencyUser.mfa_enabled) {
              const challenge = buildMfaChallenge(fastify, {
                sub: agencyUser.id, schemaName: 'platform', tenantId: null,
              })
              auditLogAuth('platform', agencyUser.id, 'auth.login.mfa_required', { scope: 'agency' }, ip, ua)
              return reply.status(202).send({
                mfaRequired: true,
                challenge,
                message: 'Saisissez votre code TOTP pour finaliser la connexion',
              })
            }

            // MFA obligatoire (politique plateforme, désactivée par défaut) →
            // token restreint au parcours d'activation MFA.
            const mfaPending = policy.mfaRequiredSuperAdmin && !agencyUser.mfa_enabled
            const expired = !mfaPending &&
              isPasswordExpired(agencyUser.password_changed_at, policy.passwordMaxAgeDays, now)
            let breached = false
            if (!mfaPending && policy.breachCheckEnabled) {
              breached = (await isPasswordBreached(password)) === true
            }
            const pwdResetRequired = !mfaPending && (expired || breached)

            const token = fastify.jwt.sign({
              sub:        agencyUser.id,
              tenantId:   null,
              schemaName: 'platform',
              role:       agencyUser.role,
              email:      agencyUser.email,
              firstName:  agencyUser.first_name,
              lastName:   agencyUser.last_name,
              employeeId: null,
              actorType:  'agency',
              agencyId:   agencyUser.agency_id,
              ...(mfaPending ? { mfaPending: true } : {}),
              ...(pwdResetRequired ? { pwdResetRequired: true } : {}),
            })
            await pool.query(
              `UPDATE platform.agency_users SET last_login_at = now(), updated_at = now() WHERE id = $1`,
              [agencyUser.id],
            ).catch(() => undefined)
            auditLogAuth('platform', agencyUser.id, 'auth.login.success',
              { scope: 'agency', agencyId: agencyUser.agency_id,
                mfaSetupRequired: mfaPending, passwordExpired: expired, passwordBreached: breached }, ip, ua)
            reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions())
            return reply.send({
              token,
              mfaSetupRequired: mfaPending,
              must_change_password: pwdResetRequired,
              passwordExpired: expired,
              passwordBreached: breached,
              user: {
                sub:        agencyUser.id,
                tenantId:   null,
                schemaName: 'platform',
                email:      agencyUser.email,
                firstName:  agencyUser.first_name,
                lastName:   agencyUser.last_name,
                role:       agencyUser.role,
                employeeId: null,
                actorType:  'agency',
                agencyId:   agencyUser.agency_id,
              },
              tenantConfig: null,
              agencyConfig: {
                id:           agencyUser.agency_id,
                name:         agencyUser.agency_name,
                primaryColor: agencyUser.primary_color,
                logoUrl:      agencyUser.logo_url,
                city:         agencyUser.city,
              },
              redirectTo: pwdResetRequired ? '/change-password' : '/agency/dashboard',
            })
          }

          // Tenant mis hors ligne : si les identifiants sont VALIDES sur un
          // tenant suspendu, on renvoie le message hors-ligne configuré plutôt
          // qu'un 401 trompeur. Vérifié en dernier → zéro régression sur le
          // chemin nominal. Mot de passe correct → pas de compteur de lockout.
          const offlineLogin = await findSuspendedTenantLogin(email, password)
          if (offlineLogin) {
            await clearFailures(redisLockoutStore, email)
            auditLogAuth(offlineLogin.schemaName, offlineLogin.userId, 'auth.login.blocked_offline', {}, ip, ua)
            return reply.status(503).send({
              error: offlineLogin.message || DEFAULT_OFFLINE_MESSAGE,
              offline: true,
            })
          }

          // OWASP A09 — log de l'échec, sans révéler le motif au client
          auditLogAuth('platform', null, 'auth.login.failed', { email, reason: 'invalid_credentials' }, ip, ua)
          // OWASP A07 — comptabilise l'échec ; si le seuil est atteint, verrouille
          // et informe immédiatement (423) plutôt que de répéter un 401 opaque.
          const fail = await registerFailure(redisLockoutStore, email, lockoutPolicy)
          if (fail.locked) {
            auditLogAuth('platform', null, 'auth.login.locked',
              { email, retryAfterSec: fail.retryAfterSec, trigger: 'threshold_reached' }, ip, ua)
            reply.header('Retry-After', String(fail.retryAfterSec))
            return reply.status(423).send({
              error: `Compte temporairement verrouillé suite à trop de tentatives. Réessayez dans ${Math.ceil(fail.retryAfterSec / 60)} min.`,
            })
          }
          return reply.status(401).send({ error: 'Email ou mot de passe incorrect' })
        }

        const { tenant, user } = candidate
        // OWASP A07 — identifiants tenant valides : réinitialise le compteur d'échecs.
        await clearFailures(redisLockoutStore, email)

        // MFA actif sur ce user : émet un challenge 3min au lieu du JWT final.
        // Le client doit ensuite appeler POST /auth/mfa/login-verify avec le
        // code TOTP (ou backup) pour obtenir le vrai token. last_login_at
        // n'est PAS mis à jour ici (login non finalisé).
        if (user.mfa_enabled) {
          const challenge = buildMfaChallenge(fastify, {
            sub: user.id, schemaName: tenant.schema_name, tenantId: tenant.id,
          })
          auditLogAuth(
            tenant.schema_name, user.id, 'auth.login.mfa_required',
            { role: user.role }, ip, ua,
          )
          return reply.status(202).send({
            mfaRequired: true,
            challenge,
            message: 'Saisissez votre code TOTP pour finaliser la connexion',
          })
        }

        // OWASP A07 — MFA obligatoire pour les employés du tenant : politique
        // globale (super_admin), durcissable par le tenant (mfa_required), jamais
        // assouplissable. Sans MFA actif → token restreint au parcours
        // d'activation MFA (le user a déjà passé le contrôle mot de passe).
        const tenantMfaPending = effectiveTenantMfaRequired(policy, tenant.mfa_required)

        // Trouver l'employeeId si lié
        let employeeId: string | null = null
        try {
          const empRes = await pool.query<{ id: string }>(
            `SELECT id FROM "${tenant.schema_name}".employees WHERE email = $1 LIMIT 1`,
            [email],
          )
          employeeId = empRes.rows[0]?.id ?? null
        } catch {
          // pas d'employé lié
        }

        // OWASP A07 — expiration / fuite → forcer le changement (token restreint
        // à /auth/change-password). Sauté si parcours MFA prioritaire.
        const expired = !tenantMfaPending &&
          isPasswordExpired(user.password_changed_at, policy.passwordMaxAgeDays, now)
        let breached = false
        if (!tenantMfaPending && policy.breachCheckEnabled) {
          breached = (await isPasswordBreached(password)) === true
        }
        const pwdResetRequired = !tenantMfaPending && (expired || breached)

        const token = fastify.jwt.sign({
          sub:        user.id,
          tenantId:   tenant.id,
          schemaName: tenant.schema_name,
          role:       user.role,
          email:      user.email,
          firstName:  user.first_name,
          lastName:   user.last_name,
          employeeId,
          ...(tenantMfaPending ? { mfaPending: true } : {}),
          ...(pwdResetRequired ? { pwdResetRequired: true } : {}),
        })

        const mustChangePassword = !user.last_login_at || pwdResetRequired

        await pool.query(
          `UPDATE "${tenant.schema_name}".users SET last_login_at = now() WHERE id = $1`,
          [user.id],
        )
        const redirectTo = pwdResetRequired
          ? '/change-password'
          : (user.role === 'employee' ? '/mon-espace'
            : user.role === 'dg' ? '/dg'
            : '/dashboard')

        auditLogAuth(
          tenant.schema_name, user.id, 'auth.login.success',
          { role: user.role, mustChangePassword, hasEmployeeLink: !!employeeId,
            mfaSetupRequired: tenantMfaPending, passwordExpired: expired, passwordBreached: breached },
          ip, ua,
        )

        // OWASP A02 — cookie httpOnly mode SPA (cf. helper authCookieOptions)
        reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions())

        // Refresh token rotatif (AUTH-008) — PAS émis si MFA en attente ou mot de
        // passe à changer (sinon le refresh contournerait le garde pwdResetRequired).
        const refreshToken = (tenantMfaPending || pwdResetRequired) ? null : await issueRefreshToken(pool, {
          sub: user.id, tenantId: tenant.id, schemaName: tenant.schema_name, role: user.role,
          email: user.email, firstName: user.first_name, lastName: user.last_name, employeeId,
        })

        return reply.send({
          token,
          refreshToken,
          must_change_password: mustChangePassword,
          mfaSetupRequired: tenantMfaPending,
          passwordExpired: expired,
          passwordBreached: breached,
          user: {
            sub:        user.id,
            tenantId:   tenant.id,
            schemaName: tenant.schema_name,
            email:      user.email,
            firstName:  user.first_name,
            lastName:   user.last_name,
            role:       user.role,
            employeeId,
          },
          tenantConfig: {
            id:             tenant.id,
            name:           tenant.name,
            slug:           tenant.slug,
            primaryColor:   tenant.primary_color,
            secondaryColor: tenant.secondary_color,
            logoUrl:        tenant.logo_url,
            city:           tenant.city,
            hasSubsidiaries:    tenant.has_subsidiaries,
            payrollMode:        tenant.payroll_mode,
            defaultCountryCode: tenant.default_country_code,
            enabledModules:     resolveEnabledModules(tenant.enabled_modules),
          },
          redirectTo,
        })
      } catch (err) {
        // OWASP A10 — ne pas leak les détails internes (DB down, etc.)
        fastify.log.error({ err: (err as Error).message }, '[auth] login error')
        return reply.status(503).send({ error: 'Service indisponible, réessayez dans un instant' })
      }
    },
  })

  // POST /auth/refresh
  fastify.post('/refresh', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Renouveler le token' },
    config: REFRESH_RATE_LIMIT,
    handler: async (request, reply) => {
      const user = request.user as typeof request.user & {
        actorType?: 'agency'; agencyId?: string; agencyUserId?: string; onBehalfOf?: string
      }

      // CABINET — token SCOPÉ sur un tenant client (schemaName ≠ platform) :
      // re-valider l'autorisation à chaque refresh (OWASP A01/A02). Si le tenant
      // a été détaché / le cabinet suspendu depuis l'émission → 401. TTL court
      // conservé (30 min) pour borner la fenêtre de staleness.
      if (user.actorType === 'agency' && user.schemaName !== 'platform') {
        if (!user.agencyId || !user.tenantId) {
          return reply.status(401).send({ error: 'Session cabinet invalide' })
        }
        const guard = await assertAgencyCanActOnTenant(pool, user.agencyUserId ?? user.sub, user.agencyId, user.tenantId)
        if (!guard.ok) {
          return reply.status(401).send({ error: 'Accès au tenant révoqué' })
        }
        const scoped = fastify.jwt.sign({
          sub: user.sub, tenantId: user.tenantId, schemaName: user.schemaName, role: 'admin',
          email: user.email, firstName: user.firstName, lastName: user.lastName, employeeId: null,
          actorType: 'agency', agencyId: user.agencyId, agencyUserId: user.agencyUserId ?? user.sub,
          onBehalfOf: user.tenantId,
        }, { expiresIn: '30m' })
        return reply.send({ token: scoped, scoped: true, expiresInSec: 1800 })
      }

      const newToken = fastify.jwt.sign({
        sub:        user.sub,
        tenantId:   user.tenantId,
        schemaName: user.schemaName,
        role:       user.role,
        email:      user.email,
        firstName:  user.firstName,
        lastName:   user.lastName,
        employeeId: user.employeeId,
        // Préserve le contexte cabinet (token non scopé).
        ...(user.actorType === 'agency' && user.agencyId
          ? { actorType: 'agency' as const, agencyId: user.agencyId }
          : {}),
      })
      return reply.send({ token: newToken })
    },
  })

  // POST /auth/refresh-token — renouvellement SILENCIEUX via refresh token
  // rotatif, SANS JWT valide requis (couvre le cas du JWT expiré — AUTH-008).
  fastify.post('/refresh-token', {
    config: REFRESH_RATE_LIMIT,
    schema: { tags: ['auth'], summary: 'Renouveler le JWT via refresh token (rotation)' },
    handler: async (request, reply) => {
      const parsed = z.object({ refreshToken: z.string().min(32).max(256) }).strict().safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'refreshToken requis' })
      }
      // Rotation : consomme (révoque) l'ancien token et récupère ses claims.
      const claims = await consumeRefreshToken(pool, parsed.data.refreshToken)
      if (!claims) {
        return reply.status(401).send({ error: 'Refresh token invalide ou expiré' })
      }
      // Le compte doit toujours exister ET être actif (un compte désactivé ne
      // peut pas rafraîchir) ; le rôle courant prime sur le rôle snapshot.
      const account = await verifyAccountActive(pool, claims.schemaName, claims.sub)
      if (!account) {
        return reply.status(401).send({ error: 'Compte introuvable ou désactivé' })
      }
      // Le mot de passe ne doit pas avoir expiré entre-temps : sinon le refresh
      // permettrait de prolonger indéfiniment une session dont le mdp doit être
      // changé. → 401 force un re-login (qui imposera le changement).
      const policy = await getSecurityPolicy(pool)
      if (isPasswordExpired(account.passwordChangedAt, policy.passwordMaxAgeDays, new Date())) {
        return reply.status(401).send({ error: 'Mot de passe expiré — reconnexion requise' })
      }
      const token = fastify.jwt.sign({
        sub:        claims.sub,
        tenantId:   claims.tenantId,
        schemaName: claims.schemaName,
        role:       account.role,
        email:      claims.email,
        firstName:  claims.firstName,
        lastName:   claims.lastName,
        employeeId: claims.employeeId,
      })
      // Émet un NOUVEAU refresh token (rotation) avec le rôle à jour.
      const newRefresh = await issueRefreshToken(pool, { ...claims, role: account.role })
      reply.setCookie(AUTH_COOKIE_NAME, token, authCookieOptions())
      return reply.send({ token, refreshToken: newRefresh })
    },
  })

  // POST /auth/logout
  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Déconnexion' },
    handler: async (request, reply) => {
      const user = request.user
      const jti = (user as unknown as { jti?: string }).jti ?? user.sub
      const exp = (user as unknown as { exp?: number }).exp
      const ttl = exp ? Math.max(exp - Math.floor(Date.now() / 1000), 0) : 604800
      await blacklistTokenSafe(jti, ttl)
      // Révoque le refresh token associé (s'il est fourni) → plus de renouvellement.
      const body = (request.body ?? {}) as { refreshToken?: string }
      await revokeRefreshToken(pool, body.refreshToken)
      // OWASP A02 — révoque le cookie httpOnly (mode SPA browser)
      reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' })
      auditLogAuth(
        user.schemaName, user.sub, 'auth.logout',
        { jti },
        request.ip ?? null,
        request.headers['user-agent']?.slice(0, 500) ?? null,
      )
      return reply.send({ message: 'Déconnecté avec succès' })
    },
  })

  // ── GET /auth/csrf-token : émet un token CSRF (double-submit pattern) ─────
  // Le client SPA appelle cet endpoint au boot, stocke le token retourné en
  // mémoire (PAS dans un cookie pour pouvoir l'injecter en header), puis
  // l'envoie dans X-CSRF-Token sur chaque POST/PATCH/PUT/DELETE.
  // Le serveur valide que header.csrf === jwt.aud='csrf' && sub === user.sub.
  // Sans ce token, les mutations cookie-authentifiées sont refusées (anti-CSRF).
  fastify.get('/csrf-token', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Émettre un token CSRF (double-submit pattern)' },
    handler: async (request, reply) => {
      const csrfToken = fastify.jwt.sign(
        { sub: request.user.sub, aud: 'csrf' } as unknown as Parameters<typeof fastify.jwt.sign>[0],
        { expiresIn: '1h' },
      )
      return reply.send({ csrfToken })
    },
  })

  // GET /auth/me
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Profil utilisateur courant' },
    handler: async (request, reply) => {
      const user = request.user
      let tenantConfig = null

      if (user.tenantId) {
        const res = await pool.query<{
          id: string; name: string; slug: string
          primary_color: string; secondary_color: string
          logo_url: string | null; city: string | null
          has_subsidiaries: boolean; payroll_mode: string; default_country_code: string
          enabled_modules: unknown
        }>(
          `SELECT id, name, slug, primary_color, secondary_color, logo_url, city,
                  has_subsidiaries, payroll_mode, default_country_code,
                  COALESCE(enabled_modules, '{}'::jsonb) AS enabled_modules
           FROM platform.tenants WHERE id = $1 LIMIT 1`,
          [user.tenantId],
        )
        const t = res.rows[0]
        if (t) {
          tenantConfig = {
            id:             t.id,
            name:           t.name,
            slug:           t.slug,
            primaryColor:   t.primary_color,
            secondaryColor: t.secondary_color,
            logoUrl:        t.logo_url,
            city:           t.city,
            hasSubsidiaries:    t.has_subsidiaries,
            payrollMode:        t.payroll_mode,
            defaultCountryCode: t.default_country_code,
            enabledModules:     resolveEnabledModules(t.enabled_modules),
          }
        }
      }

      return reply.send({
        user: {
          id:         user.sub,
          email:      user.email,
          firstName:  user.firstName,
          lastName:   user.lastName,
          role:       user.role,
          employeeId: user.employeeId,
        },
        tenantConfig,
      })
    },
  })

  // POST /auth/change-password
  fastify.post('/change-password', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['auth'], summary: 'Changer le mot de passe' },
    config: CHANGE_PASSWORD_RATE_LIMIT,
    handler: async (request, reply) => {
      // OWASP A03 — validation Zod stricte (min 8 chars)
      const parsed = changePasswordSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Mot de passe invalide (min 8 caractères)' })
      }
      const { oldPassword, newPassword } = parsed.data

      const user = request.user
      // OWASP A03 — schema validé contre regex avant interpolation dans le nom de table
      if (user.schemaName !== 'platform' && !SCHEMA_NAME_RE.test(user.schemaName)) {
        return reply.status(400).send({ error: 'Schema invalide' })
      }
      const table = user.schemaName === 'platform'
        ? 'platform.platform_users'
        : `"${user.schemaName}".users`
      const historyTable = user.schemaName === 'platform'
        ? 'platform.password_history'
        : `"${user.schemaName}".password_history`

      // OWASP A07 — politique mot de passe (historique anti-réutilisation +
      // refus d'un nouveau mot de passe figurant dans une fuite). Ne lève jamais.
      const policy = await getSecurityPolicy(pool)

      const res = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM ${table} WHERE id = $1 LIMIT 1`,
        [user.sub],
      )
      const record = res.rows[0]
      if (!record) return reply.status(404).send({ error: 'Utilisateur introuvable' })

      const valid = await bcrypt.compare(oldPassword, record.password_hash)
      if (!valid) {
        auditLogAuth(
          user.schemaName, user.sub, 'auth.password.change_failed',
          { reason: 'wrong_old_password' },
          request.ip ?? null,
          request.headers['user-agent']?.slice(0, 500) ?? null,
        )
        return reply.status(400).send({ error: 'Ancien mot de passe incorrect' })
      }

      // OWASP A07 — historique anti-réutilisation : le nouveau mot de passe ne
      // doit correspondre ni à l'actuel ni aux N précédents. SELECT défensif
      // (table absente sur un schéma non migré → pas de blocage, dégradation
      // gracieuse). On inclut le hash courant pour interdire de re-poser le même.
      if (policy.passwordHistoryCount > 0) {
        const histRes = await pool.query<{ password_hash: string }>(
          `SELECT password_hash FROM ${historyTable}
           WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [user.sub, policy.passwordHistoryCount],
        ).catch(() => ({ rows: [] as Array<{ password_hash: string }> }))
        const previousHashes = [record.password_hash, ...histRes.rows.map((r) => r.password_hash)]
        if (await isPasswordReused(newPassword, previousHashes)) {
          auditLogAuth(
            user.schemaName, user.sub, 'auth.password.reuse_blocked', {},
            request.ip ?? null, request.headers['user-agent']?.slice(0, 500) ?? null,
          )
          return reply.status(400).send({
            error: `Mot de passe déjà utilisé récemment — choisissez-en un différent des ${policy.passwordHistoryCount} derniers`,
          })
        }
      }

      // OWASP A07 — refuser un nouveau mot de passe présent dans une fuite connue
      // (si internet). `null` = vérif impossible → on n'empêche pas (non bloquant).
      if (policy.breachCheckEnabled) {
        const breached = await isPasswordBreached(newPassword)
        if (breached === true) {
          auditLogAuth(
            user.schemaName, user.sub, 'auth.password.breach_blocked', {},
            request.ip ?? null, request.headers['user-agent']?.slice(0, 500) ?? null,
          )
          return reply.status(400).send({
            error: 'Ce mot de passe figure dans une fuite de données connue — choisissez-en un autre',
          })
        }
      }

      const newHash = await bcrypt.hash(newPassword, 12)
      // OWASP A07 — met à jour le hash ET la date de changement (réinitialise le
      // compteur de durée de vie). Le token restreint pwdResetRequired devient
      // caduc à la prochaine connexion / au prochain /auth/refresh.
      await pool.query(
        `UPDATE ${table} SET password_hash = $1, password_changed_at = now(), updated_at = now() WHERE id = $2`,
        [newHash, user.sub],
      )

      // OWASP A07 — archive l'ANCIEN hash dans l'historique puis purge au-delà de
      // la fenêtre conservée. Non bloquant (table absente → on ignore).
      if (policy.passwordHistoryCount > 0) {
        await pool.query(
          `INSERT INTO ${historyTable} (user_id, password_hash) VALUES ($1, $2)`,
          [user.sub, record.password_hash],
        ).catch(() => undefined)
        await pool.query(
          `DELETE FROM ${historyTable}
           WHERE user_id = $1 AND id NOT IN (
             SELECT id FROM ${historyTable} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
           )`,
          [user.sub, policy.passwordHistoryCount],
        ).catch(() => undefined)
      }

      auditLogAuth(
        user.schemaName, user.sub, 'auth.password.changed',
        {},
        request.ip ?? null,
        request.headers['user-agent']?.slice(0, 500) ?? null,
      )

      return reply.send({ message: 'Mot de passe modifié avec succès' })
    },
  })
}

export default authRoutes
