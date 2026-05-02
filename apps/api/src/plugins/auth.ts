import fp from 'fastify-plugin/plugin.js'
import fastifyJwt from '@fastify/jwt'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config'
import type { JwtPayload, UserRole } from '@nexusrh/shared'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user: JwtPayload
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorize: (...roles: UserRole[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyJwt, {
    secret: config.jwt.secret,
  })

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch (err) {
        reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Token d\'authentification invalide ou expiré',
        })
      }
    }
  )

  fastify.decorate(
    'authorize',
    (...roles: UserRole[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          await request.jwtVerify()
          if (!roles.includes(request.user.role)) {
            return reply.status(403).send({
              statusCode: 403,
              error: 'Forbidden',
              message: 'Vous n\'avez pas les permissions nécessaires',
            })
          }
        } catch {
          reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Token d\'authentification invalide ou expiré',
          })
        }
      }
  )
}

export default fp(authPlugin, { name: 'auth' })
