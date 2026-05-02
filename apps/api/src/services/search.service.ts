import { config } from '../config'
import { logger } from '../utils/logger'

// ── Meilisearch (optionnel — fallback PostgreSQL full-text si non configuré) ──
let meiliClient: import('meilisearch').MeiliSearch | null = null
let meiliAvailable = false

async function getMeiliClient(): Promise<import('meilisearch').MeiliSearch | null> {
  if (!config.search.url || config.search.url === 'http://localhost:7700') {
    if (!config.search.masterKey || config.search.masterKey === 'nexusrh-dev-master-key') {
      return null // No Meilisearch configured — use PG fallback
    }
  }

  if (!meiliClient) {
    try {
      const { MeiliSearch } = await import('meilisearch')
      meiliClient = new MeiliSearch({
        host: config.search.url,
        apiKey: config.search.masterKey,
      })
      // Quick health check
      await meiliClient.health()
      meiliAvailable = true
      logger.info('Meilisearch connecté')
    } catch {
      logger.warn('Meilisearch indisponible — fallback PostgreSQL full-text activé')
      meiliClient = null
      meiliAvailable = false
    }
  }
  return meiliAvailable ? meiliClient : null
}

// ── PostgreSQL full-text search fallback ──────────────────────────────────────
// Injected lazily to avoid circular imports — set by db/client bootstrap
let pgPool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  schemaName?: string
} | null = null

export function setSearchPgPool(pool: typeof pgPool): void {
  pgPool = pool
}

export async function initSearchIndexes(): Promise<void> {
  const client = await getMeiliClient()
  if (!client) {
    logger.info('Recherche : mode PostgreSQL full-text (Meilisearch non configuré)')
    return
  }

  try {
    await client.createIndex('employees', { primaryKey: 'id' }).catch(() => {/* already exists */})
    const employeesIndex = client.index('employees')
    await employeesIndex.updateSettings({
      searchableAttributes: ['firstName', 'lastName', 'email', 'employeeNumber', 'jobTitle'],
      filterableAttributes: ['entityId', 'departmentId', 'status', 'profileType', 'burnoutRisk'],
      sortableAttributes: ['lastName', 'hireDate', 'retentionScore'],
      displayedAttributes: ['id', 'firstName', 'lastName', 'email', 'jobTitle', 'status', 'photoUrl', 'departmentId', 'employeeNumber'],
    })

    await client.createIndex('job_offers', { primaryKey: 'id' }).catch(() => {/* already exists */})
    const jobOffersIndex = client.index('job_offers')
    await jobOffersIndex.updateSettings({
      searchableAttributes: ['title', 'description', 'location'],
      filterableAttributes: ['entityId', 'status', 'contractType'],
      sortableAttributes: ['publishedAt'],
    })

    logger.info('Indexes Meilisearch initialisés')
  } catch (err) {
    logger.error({ err }, 'Erreur initialisation Meilisearch')
    meiliAvailable = false
  }
}

export async function indexEmployees(employees: Array<Record<string, unknown>>): Promise<void> {
  const client = await getMeiliClient()
  if (!client) return // PG fallback: no indexing needed, queries go direct to DB
  await client.index('employees').addDocuments(employees)
}

export async function updateEmployeeIndex(employee: Record<string, unknown>): Promise<void> {
  const client = await getMeiliClient()
  if (!client) return
  await client.index('employees').updateDocuments([employee])
}

export async function deleteEmployeeFromIndex(employeeId: string): Promise<void> {
  const client = await getMeiliClient()
  if (!client) return
  await client.index('employees').deleteDocument(employeeId)
}

export async function searchEmployees(
  query: string,
  options: {
    schemaName?: string
    entityId?: string
    departmentId?: string
    status?: string
    limit?: number
    offset?: number
  } = {}
): Promise<{
  hits: Array<Record<string, unknown>>
  totalHits: number
}> {
  const client = await getMeiliClient()

  // ── Meilisearch path ──────────────────────────────────────────────────────
  if (client) {
    const filter: string[] = []
    if (options.entityId) filter.push(`entityId = "${options.entityId}"`)
    if (options.departmentId) filter.push(`departmentId = "${options.departmentId}"`)
    if (options.status) filter.push(`status = "${options.status}"`)

    const result = await client.index('employees').search(query, {
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
      filter: filter.length > 0 ? filter.join(' AND ') : undefined,
    })

    return {
      hits: result.hits as Array<Record<string, unknown>>,
      totalHits: result.estimatedTotalHits ?? 0,
    }
  }

  // ── PostgreSQL full-text fallback ─────────────────────────────────────────
  const schema = options.schemaName ?? pgPool?.schemaName
  if (!pgPool || !schema) {
    logger.warn('searchEmployees: aucun pool PG disponible pour le fallback')
    return { hits: [], totalHits: 0 }
  }

  const limit = options.limit ?? 20
  const offset = options.offset ?? 0
  const params: unknown[] = []
  const conditions: string[] = []

  // PostgreSQL full-text: use plainto_tsquery for natural language
  if (query && query.trim().length > 0) {
    params.push(query.trim())
    conditions.push(`
      to_tsvector('french',
        coalesce(first_name,'') || ' ' ||
        coalesce(last_name,'') || ' ' ||
        coalesce(email,'') || ' ' ||
        coalesce(employee_number,'') || ' ' ||
        coalesce(job_title,'')
      ) @@ plainto_tsquery('french', $${params.length})
      OR (
        first_name ILIKE $${params.length + 1}
        OR last_name ILIKE $${params.length + 1}
        OR email ILIKE $${params.length + 1}
        OR employee_number ILIKE $${params.length + 1}
      )
    `)
    params.push(`%${query.trim()}%`)
  }

  if (options.entityId) {
    params.push(options.entityId)
    conditions.push(`entity_id = $${params.length}`)
  }
  if (options.departmentId) {
    params.push(options.departmentId)
    conditions.push(`department_id = $${params.length}`)
  }
  if (options.status) {
    params.push(options.status)
    conditions.push(`status = $${params.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const countResult = await pgPool.query(
      `SELECT COUNT(*) AS total FROM "${schema}".employees ${where}`,
      params
    )
    const totalHits = parseInt((countResult.rows[0] as { total: string }).total, 10)

    params.push(limit, offset)
    const dataResult = await pgPool.query(
      `SELECT
        id, first_name AS "firstName", last_name AS "lastName",
        email, job_title AS "jobTitle", status,
        photo_url AS "photoUrl", department_id AS "departmentId",
        employee_number AS "employeeNumber"
       FROM "${schema}".employees
       ${where}
       ORDER BY last_name ASC, first_name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    return {
      hits: dataResult.rows as Array<Record<string, unknown>>,
      totalHits,
    }
  } catch (err) {
    logger.error({ err }, 'Erreur recherche PostgreSQL full-text')
    return { hits: [], totalHits: 0 }
  }
}
