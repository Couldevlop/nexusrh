import fp from 'fastify-plugin/plugin.js'
import fastifyRateLimit from '@fastify/rate-limit'
import type { FastifyPluginAsync } from 'fastify'
import { getRedisClient } from '../services/redis.service'

const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis: getRedisClient(),
    keyGenerator(request) {
      return `rate_limit:${request.ip}:${request.url}`
    },
    errorResponseBuilder(_request, context) {
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Trop de requêtes. Réessayez dans ${context.after}.`,
      }
    },
  })
}

export default fp(rateLimitPlugin, { name: 'rateLimit' })
