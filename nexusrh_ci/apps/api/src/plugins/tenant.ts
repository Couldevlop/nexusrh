import fp from 'fastify-plugin'
import { getTenantDb } from '../db/client.js'
import type { FastifyRequest } from 'fastify'

export function getTenantDbForRequest(request: FastifyRequest) {
  const schemaName = request.user?.schemaName
  if (!schemaName) throw new Error('schemaName manquant dans le token')
  return getTenantDb(schemaName)
}

export default fp(async (_fastify) => {
  // Le search_path est géré par requête via pool.query dans chaque handler
  // grâce à getTenantDbForRequest qui crée un client avec le bon schema
})
