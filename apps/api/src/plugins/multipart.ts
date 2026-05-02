import fp from 'fastify-plugin/plugin.js'
import fastifyMultipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'

const multipartPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(fastifyMultipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 100,
      fields: 20,
      fileSize: 50 * 1024 * 1024, // 50 MB
      files: 5,
      headerPairs: 2000,
    },
  })
}

export default fp(multipartPlugin, { name: 'multipart' })
