import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { isTokenBlacklisted } from '../services/redis.js'
import { isValidSchemaName } from '../utils/schema-name.js'

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

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorize: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export default fp(async (fastify) => {
  // @fastify/cookie : permet à @fastify/jwt de lire le JWT depuis un cookie
  // httpOnly (mode SPA browser, anti-XSS) en plus du header Authorization.
  await fastify.register(fastifyCookie, {
    secret: config.jwt.secret,   // pour signer si on en a besoin plus tard
  })

  await fastify.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign:   { expiresIn: config.jwt.expiresIn },
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
    const jti = (request.user as unknown as { jti?: string }).jti ?? request.user.sub
    if (await isTokenBlacklisted(jti)) {
      reply.status(401).send({ error: 'Token révoqué' })
    }
  }

  fastify.decorate('authenticate', verifyAndCheckBlacklist)

  fastify.decorate('authorize', (...roles: string[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    await verifyAndCheckBlacklist(request, reply)
    if (reply.sent) return
    if (!roles.includes(request.user.role)) {
      return reply.status(403).send({ error: 'Accès interdit — rôle insuffisant' })
    }
  })
})
