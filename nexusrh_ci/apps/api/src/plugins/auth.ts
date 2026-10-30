import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import { randomUUID } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { isTokenBlacklisted, getTokenEpoch } from '../services/redis.js'
import { isValidSchemaName } from '../utils/schema-name.js'
import { loadHabContext, can, hrScopeSql, type HabContext } from '../services/habilitation.service.js'
import { HR_GRID_ROLES, resolveRoutePermission } from '../modules/habilitations/route-permissions.js'
import { isPermission } from '../modules/habilitations/catalog.js'

// Nom du cookie qui transporte le JWT en httpOnly (mode SPA browser).
// Les clients API peuvent toujours utiliser Authorization: Bearer (backward-compat).
export const AUTH_COOKIE_NAME = 'nexusrh_token'

// Nom du cookie qui transporte le refresh token rotatif en httpOnly (OWASP A02).
// Il n'est JAMAIS lisible en JS (anti-exfiltration XSS) : seul ce cookie — et,
// pour backward-compat, le corps JSON — alimente /auth/refresh-token. Portée
// limitée à /auth pour qu'il ne soit envoyé qu'aux endpoints refresh/logout.
export const REFRESH_COOKIE_NAME = 'nexusrh_rt'

export interface JwtSignPayload {
  sub:        string
  /** OWASP A07 — identifiant UNIQUE du token (JWT ID, RFC 7519 §4.1.7).
   *  Posé par `withJti()` sur CHAQUE token signé. C'est la clé de la blacklist
   *  de révocation : sans lui, le logout retombait sur `sub` et blacklistait
   *  l'utilisateur ENTIER (toutes ses sessions + tout futur login) pendant la
   *  TTL du token — self-lockout jusqu'à 7 jours et DoS de compte trivial.
   *  Optionnel dans le type UNIQUEMENT pour les tokens legacy déjà émis. */
  jti?:       string
  tenantId:   string | null
  schemaName: string
  role:       string
  email:      string
  firstName:  string
  lastName:   string
  employeeId: string | null
  /** OWASP A07 — super_admin connecté sans MFA activé : token restreint au
   *  parcours d'activation MFA tant que ce flag est présent. */
  mfaPending?: boolean
  /** OWASP A07 — mot de passe expiré (durée de vie dépassée) ou trouvé dans une
   *  fuite : token restreint au changement de mot de passe tant que ce flag est
   *  présent. L'utilisateur n'est pas verrouillé, il DOIT renouveler son mdp. */
  pwdResetRequired?: boolean
  /** Cabinet de recrutement : présent uniquement pour les tokens d'un utilisateur
   *  de cabinet (contexte cabinet OU session scopée sur un tenant client). */
  actorType?: 'agency'
  /** ID du cabinet (platform.agencies.id) — présent si actorType='agency'. */
  agencyId?: string
  /** ID de l'utilisateur cabinet (platform.agency_users.id) — présent sur un
   *  token scopé pour tracer l'acteur réel derrière le role='admin' délégué. */
  agencyUserId?: string
  /** Token scopé : ID du tenant client sur lequel le cabinet agit (on-behalf). */
  onBehalfOf?: string
}

export interface JwtPayload extends JwtSignPayload {
  iat: number
  exp: number
}

// Tell @fastify/jwt what our JWT payload looks like
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtSignPayload
    user: JwtPayload
  }
}

/**
 * OWASP A07 — ajoute un `jti` aléatoire (UUID v4) au payload à signer.
 *
 * À appliquer sur TOUT `fastify.jwt.sign()` du dépôt (login, refresh,
 * refresh-token, challenge MFA, token restreint mfaPending/pwdResetRequired,
 * re-scoping cabinet, CSRF) — y compris les tokens de courte durée : un token
 * de 3 minutes reste révocable pendant ces 3 minutes.
 *
 * Le `jti` rend la révocation PAR TOKEN. Il ne remplace PAS l'époque de token
 * (`setTokenEpoch`, services/redis.ts) qui reste la révocation GLOBALE d'un
 * utilisateur (changement de mot de passe, de rôle, désactivation) : les deux
 * mécanismes sont complémentaires et évalués tous les deux à chaque requête.
 */
export function withJti<T extends object>(payload: T): T & { jti: string } {
  return { ...payload, jti: randomUUID() }
}

/**
 * Clé de blacklist d'un token vérifié.
 *
 * RÉTRO-COMPATIBILITÉ (à conserver) : les tokens émis AVANT l'introduction du
 * `jti` n'en portent pas et resteraient irrévocables. On retombe donc sur `sub`
 * pour eux, ce qui reproduit l'ancien comportement (blacklist de l'utilisateur)
 * mais UNIQUEMENT pour ces tokens legacy. La branche `?? sub` peut être retirée
 * une fois la fenêtre de validité écoulée (JWT_EXPIRES_IN, 7 jours max).
 */
export function tokenBlacklistKey(user: { sub: string; jti?: string }): string {
  return user.jti ?? user.sub
}

/** Route protégée par `authorize()` : recensée au démarrage (onRoute). */
export interface AuthorizedRoute {
  method: string
  url: string
  roles: readonly string[]
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorize: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** Routes protégées par `authorize()` et leurs rôles (contrôle de couverture de la grille). */
    authorizedRoutes: AuthorizedRoute[]
  }
  interface FastifyRequest {
    /**
     * Contexte d'habilitation RH, chargé au plus une fois par requête
     * (`undefined` = pas encore chargé ; `null` = aucune affectation, accès
     * hérité par rôle). Cf. getRequestHab.
     */
    hab?: HabContext | null
  }
}

/** Rôles listés dans chaque gestionnaire créé par `authorize()`. */
const AUTHORIZE_ROLES = new WeakMap<object, readonly string[]>()

const HR_GRID_ROLE_SET: ReadonlySet<string> = new Set(HR_GRID_ROLES)

export const HAB_DENIED_ERROR = 'Accès interdit — habilitation insuffisante'

/**
 * Vrai pour un jeton d'utilisateur de tenant (seuls concernés par la grille).
 * Les jetons plateforme (super_admin, cabinet en contexte cabinet) et les
 * jetons de cabinet scopés sur un tenant (sub = utilisateur de cabinet, pas un
 * utilisateur du tenant) gardent le contrôle par rôle.
 */
function isTenantUserToken(user: JwtPayload): boolean {
  return user.schemaName !== 'platform' && user.schemaName !== 'public' && user.actorType !== 'agency'
}

/**
 * Contexte d'habilitation de l'utilisateur courant, mémorisé sur la requête.
 * `null` hors tenant ou sans affectation. Lève si le moteur échoue : l'appelant
 * décide (authorize refuse, fermé par défaut).
 */
export async function getRequestHab(request: FastifyRequest): Promise<HabContext | null> {
  if (request.hab !== undefined) return request.hab
  const hab = isTenantUserToken(request.user)
    ? await loadHabContext(request.user.schemaName, request.user.sub)
    : null
  request.hab = hab
  return hab
}

export default fp(async (fastify) => {
  // @fastify/cookie : permet à @fastify/jwt de lire le JWT depuis un cookie
  // httpOnly (mode SPA browser, anti-XSS) en plus du header Authorization.
  await fastify.register(fastifyCookie, {
    secret: config.jwt.secret,   // pour signer si on en a besoin plus tard
  })

  await fastify.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign:   { algorithm: 'HS256', expiresIn: config.jwt.expiresIn },
    // OWASP A02 — algorithme ÉPINGLÉ à la vérification. Sans cette option,
    // l'ensemble autorisé est *déduit* du type de la clé par fast-jwt (une clé
    // symétrique restreint de fait à HS256/384/512). La protection existe donc
    // déjà, mais par effet de bord : la déclarer explicitement la rend
    // indépendante de la détection du paquet et de ses évolutions, et ferme la
    // porte à `alg: none` comme à toute confusion d'algorithme.
    verify: { algorithms: ['HS256'] },
    // OWASP A02 — accepte le JWT depuis un cookie httpOnly (mode SPA) en plus
    // du header Authorization (mode API client). Le cookie est résolu par
    // @fastify/cookie et @fastify/jwt l'extrait automatiquement si présent.
    cookie: {
      cookieName: AUTH_COOKIE_NAME,
      signed: false,
    },
  })

  async function verifyAndCheckBlacklist(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await request.jwtVerify()
    } catch {
      reply.status(401).send({ error: 'Token invalide ou expiré' })
      return
    }
    // OWASP A03 (défense en profondeur) — le schemaName du token est interpolé
    // tel quel dans des identifiants SQL par les handlers. On rejette ici, au
    // choke point central, tout token portant un schemaName non conforme.
    if (!isValidSchemaName(request.user.schemaName)) {
      reply.status(401).send({ error: 'Token invalide (schéma non conforme)' })
      return
    }
    // OWASP A07 — un token de challenge MFA, CSRF ou le jeton PUBLIC de
    // simulation d'entretien (aud='interview-sim-public', cf.
    // mintPublicInterviewToken dans modules/interview-sim/interview-sim.routes.ts)
    // n'est PAS un token de session : il ne doit jamais authentifier une route
    // applicative (sinon bypass MFA / usurpation via un jeton éphémère public).
    const aud = (request.user as { aud?: string }).aud
    if (aud === 'mfa-challenge' || aud === 'csrf' || aud === 'interview-sim-public') {
      return reply.code(401).send({ error: 'Token non autorisé pour cette ressource' })
    }
    // OWASP A07 — MFA obligatoire super_admin : un token "mfaPending" (super_admin
    // connecté sans MFA activé) est restreint au parcours d'activation MFA. Toute
    // autre route est refusée tant que le MFA n'est pas activé.
    if ((request.user as { mfaPending?: boolean }).mfaPending === true) {
      const path = request.url.split('?')[0] ?? ''
      const allowed =
        path.startsWith('/auth/mfa/') ||
        path === '/auth/me' || path === '/auth/logout' || path === '/auth/csrf-token'
      if (!allowed) {
        reply.status(403).send({ error: 'MFA obligatoire — activez le MFA pour accéder à la plateforme' })
        return
      }
    }
    // OWASP A07 — mot de passe expiré/compromis : token restreint au changement
    // de mot de passe. Mêmes routes de service autorisées que mfaPending, plus
    // /auth/change-password (la seule action permise pour débloquer le compte).
    if ((request.user as { pwdResetRequired?: boolean }).pwdResetRequired === true) {
      const path = request.url.split('?')[0] ?? ''
      const allowed =
        path === '/auth/change-password' ||
        path === '/auth/me' || path === '/auth/logout' || path === '/auth/csrf-token'
      if (!allowed) {
        reply.status(403).send({ error: 'Mot de passe expiré ou compromis — changez votre mot de passe pour continuer' })
        return
      }
    }
    // OWASP A07 — révocation PAR TOKEN via le `jti` (cf. tokenBlacklistKey pour
    // le fallback legacy `sub`). Un logout ne doit jamais bloquer les autres
    // sessions de l'utilisateur ni ses futurs logins.
    const jti = tokenBlacklistKey(request.user)
    if (await isTokenBlacklisted(jti)) {
      reply.status(401).send({ error: 'Token révoqué' })
      return
    }
    // OWASP A01/A02 — époque d'invalidation de session par utilisateur : un
    // changement de rôle/désactivation/mot de passe pose une nouvelle époque
    // (services/redis.ts, setTokenEpoch). Tout token émis AVANT (iat < epoch)
    // est rejeté ; un token émis après (nouveau login/refresh) reste valide.
    // Try/catch en plus du fail-open interne à getTokenEpoch : robuste même si
    // le module redis est partiellement mocké (tests) ou indisponible.
    try {
      const epoch = await getTokenEpoch(request.user.sub)
      if (epoch > 0 && request.user.iat < epoch) {
        reply.status(401).send({ error: 'Session invalidée — reconnectez-vous' })
        return
      }
    } catch {
      // Redis indisponible / fonction non mockée → fail-open (pas de rejet)
    }
  }

  fastify.decorate('authenticate', verifyAndCheckBlacklist)

  // Habilitations RH : un rôle hors grille listé par la route (admin, manager,
  // employee, dg, readonly) passe comme avant. Pour tout autre cas, si
  // l'utilisateur a une affectation, la grille décide (fonction, action,
  // périmètre valide) ; sans affectation, contrôle hérité par rôle.
  fastify.decorate('authorize', (...roles: string[]) => {
    const routeAllowsHrRole = roles.some((r) => HR_GRID_ROLE_SET.has(r))
    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await verifyAndCheckBlacklist(request, reply)
      if (reply.sent) return
      const role = request.user.role
      if (roles.includes(role) && !HR_GRID_ROLE_SET.has(role)) return
      // Route sans rôle RH (ex. authorize('admin')) : la grille n'ouvre rien,
      // refus hérité sans consulter le moteur.
      if (!routeAllowsHrRole) {
        return reply.status(403).send({ error: 'Accès interdit — rôle insuffisant' })
      }

      let hab: HabContext | null
      try {
        hab = await getRequestHab(request)
        // Valide le périmètre (ex. sous-groupe filiale sans entité légale) :
        // un périmètre incalculable ne doit jamais ouvrir l'accès.
        if (hab !== null) hrScopeSql(request.user.schemaName, 'e', hab)
      } catch (err) {
        request.log.error({ err }, 'habilitations : contexte indisponible, accès refusé')
        return reply.status(403).send({ error: HAB_DENIED_ERROR })
      }

      if (hab === null) {
        if (!roles.includes(role)) {
          return reply.status(403).send({ error: 'Accès interdit — rôle insuffisant' })
        }
        return
      }

      const perm = resolveRoutePermission(request.method, request.routeOptions.url ?? '')
      if (hab.kind === 'none' || perm === null || !can(hab, perm.fn, perm.action)) {
        return reply.status(403).send({ error: HAB_DENIED_ERROR })
      }
    }
    AUTHORIZE_ROLES.set(handler, roles)
    return handler
  })

  // Recensement des routes protégées par authorize() (contrôle de couverture
  // de la grille, cf. route-permissions.test.ts). Une route RH sans case de
  // grille est refusée à tout habilité : on le signale dès le démarrage.
  const authorizedRoutes: AuthorizedRoute[] = []
  fastify.decorate('authorizedRoutes', authorizedRoutes)
  fastify.addHook('onRoute', (route) => {
    const hooks = [route.onRequest, route.preHandler].flatMap((h) => (h === undefined ? [] : Array.isArray(h) ? h : [h]))
    const roles = hooks.map((h) => AUTHORIZE_ROLES.get(h)).find((r) => r !== undefined)
    if (!roles) return
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      authorizedRoutes.push({ method, url: route.url, roles })
      if (!roles.some((r) => HR_GRID_ROLE_SET.has(r))) continue
      const perm = resolveRoutePermission(method, route.url)
      if (perm === null || !isPermission(`${perm.fn}:${perm.action}`)) {
        fastify.log.error({ method, url: route.url }, 'habilitations : route RH sans case de grille (refusée aux habilités)')
      }
    }
  })
})
