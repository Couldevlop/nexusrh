import fp from 'fastify-plugin/plugin.js'
import fastifyWebSocket from '@fastify/websocket'
import type { FastifyPluginAsync } from 'fastify'

const websocketPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyWebSocket, {
    options: {
      maxPayload: 1048576, // 1 MB
    },
  })
}

export default fp(websocketPlugin, { name: 'websocket' })
