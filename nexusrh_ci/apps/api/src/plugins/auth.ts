import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { isTokenBlacklisted } from '../services/redis.js'

// Nom du cookie qui transporte le JWT en httpOnly (mode SPA browser).
// Les clients API peuvent toujours utiliser Authorization: Bearer (backward-compat).
export const AUTH_COOKIE_NAME = 'nexusrh_token'

export interface JwtSignPayload {
  sub:        string
  tenantId:   string | null
  schemaName: string
  role:       string
  email:      string
  firstName:  string
  lastName:   string
  employeeId: string | null
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
