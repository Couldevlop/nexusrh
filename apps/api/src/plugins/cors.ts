import fp from 'fastify-plugin/plugin.js'
import fastifyCors from '@fastify/cors'
import type { FastifyPluginAsync } from 'fastify'
import { config } from '../config'

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyCors, {
    origin: [config.app.url, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
}

export default fp(corsPlugin, { name: 'cors' })
