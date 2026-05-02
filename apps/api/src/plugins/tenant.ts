import fp from 'fastify-plugin/plugin.js'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { getTenantDb } from '../db/client'
import type { TenantDb } from '../db/client'

declare module 'fastify' {
  interface FastifyRequest {
    tenantDb?: TenantDb
  }
}

/**
 * Tenant plugin — enriches every authenticated request with a Drizzle DB
 * instance scoped to the tenant's PostgreSQL schema.
 *
 * Because preValidation runs BEFORE preHandler (where jwtVerify() is called),
 * request.user is not yet populated at preValidation time. The actual DB
 * resolution is therefore deferred to getTenantDbForRequest(), which reads
 * request.user.schemaName after authentication has run.
 */
const tenantPlugin: FastifyPluginAsync = async (_fastify) => {
  // No-op: tenant DB is resolved lazily in getTenantDbForRequest
}

export default fp(tenantPlugin, { name: 'tenant', dependencies: ['auth'] })

/**
 * Returns the tenant-scoped Drizzle DB for the current request.
 *
 * Resolution order:
 *  1. Use request.tenantDb if already set (cached on first call)
 *  2. Derive from request.user.schemaName (available after authenticate preHandler)
 *  3. Throw if neither is available
 */
export function getTenantDbForRequest(request: FastifyRequest): TenantDb {
  if (request.tenantDb) return request.tenantDb

  const schemaName = request.user?.schemaName
  if (!schemaName) {
    throw new Error(
      'No tenant schema on request. Ensure the route uses fastify.authenticate and the JWT contains a schemaName.'
    )
  }

  // Cache on the request so repeated calls in the same handler reuse it
  request.tenantDb = getTenantDb(schemaName)
  return request.tenantDb
}
