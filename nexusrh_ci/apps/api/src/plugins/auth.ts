import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import { config } from '../config.js'

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
  await fastify.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign:   { expiresIn: config.jwt.expiresIn },
  })

  fastify.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ error: 'Token invalide ou expiré' })
    }
  })

  fastify.decorate('authorize', (...roles: string[]) => async (request: any, reply: any) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ error: 'Token invalide ou expiré' })
    }
    if (!roles.includes(request.user.role)) {
      return reply.status(403).send({ error: 'Accès interdit — rôle insuffisant' })
    }
  })
})
