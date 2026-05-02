import fp from 'fastify-plugin'
import fastifyCors from '@fastify/cors'
import { config } from '../config.js'

export default fp(async (fastify) => {
  await fastify.register(fastifyCors, {
    origin: config.env === 'development'
      ? ['http://localhost:3001', 'http://localhost:3000']
      : [config.appUrl],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
})
