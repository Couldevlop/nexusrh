import type { FastifyPluginAsync } from 'fastify'
import { eq, and, gte, lte } from 'drizzle-orm'
import { Pool } from 'pg'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { absences, absenceTypes, absenceBalances } from '../../db/schema/absences'
import { legalEntities } from '../../db/schema/employees'
import { config } from '../../config'
import { ensureTenantSchema } from '../../utils/schema-migrations'

// Pool pour les requêtes workflow (lecture config niveaux)
const rawPool = new Pool({ connectionString: config.database.url })

// Alias local pour compatibilité avec les appels existants dans ce fichier
const ensureSchemaMigrated = ensureTenantSchema

function calcWorkingDays(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  let count = 0
  const current = new Date(start)
  while (current <= end) {
    const day = current.getDay()
    if (day !== 0 && day !== 6) count++
    current.setDate(current.getDate() + 1)
  }
  return count
}

function getPeriodLabel(): string {
  const now = new Date()
  const month = now.getMonth()
  const year = now.getFullYear()
  const periodYear = month >= 5 ? year : year - 1
  return `${periodYear}-${periodYear + 1}`
}

const absencesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /absences/my-balances — soldes de l'employé connecté
  fastify.get('/my-balances', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Mes soldes de congés' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const employeeId = request.user.employeeId
      if (!employeeId) return reply.send({ data: [] })
      const periodLabel = getPeriodLabel()
      const list = await db.query.absenceBalances.findMany({
        where: and(
          eq(absenceBalances.employeeId, employeeId),
          eq(absenceBalances.periodLabel, periodLabel)
        ),
      })
      return reply.send({ data: list })
    },
  })

  // GET /absences/my-absences — absences de l'employé connecté
  fastify.get('/my-absences', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Mes absences' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const employeeId = request.user.employeeId
      if (!employeeId) return reply.send({ data: [] })
      const query = request.query as { limit?: string }
      const list = await db.query.absences.findMany({
        where: eq(absences.employeeId, employeeId),
        orderBy: [absences.startDate],
        limit: query.limit ? Number(query.limit) : undefined,
      })
      return reply.send({ data: list })
    },
  })

  // GET /absences — list all absences (admin/hr) or current user absences
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Liste des absences' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.query as { employeeId?: string }

      const list = await db.query.absences.findMany({
        where: employeeId ? eq(absences.employeeId, employeeId) : undefined,
        orderBy: [absences.startDate],
      })

      return reply.send({ data: list })
    },
  })

  // GET /absences/employees/:employeeId — absences for a specific employee
  fastify.get('/employees/:employeeId', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Absences d\'un collaborateur' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }
      const list = await db.query.absences.findMany({
        where: eq(absences.employeeId, employeeId),
        orderBy: [absences.startDate],
      })
      return reply.send({ data: list })
    },
  })

  // GET /absences/employee/:employeeId — kept for backwards compatibility
  fastify.get('/employee/:employeeId', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Absences d\'un collaborateur (compat)' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }
      const list = await db.query.absences.findMany({
        where: eq(absences.employeeId, employeeId),
        orderBy: [absences.startDate],
      })
      return reply.send({ data: list })
    },
  })

  // GET /absences/employees/:employeeId/balances
  fastify.get('/employees/:employeeId/balances', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Soldes d\'absences d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }
      const periodLabel = getPeriodLabel()

      const balances = await db.query.absenceBalances.findMany({
        where: and(
          eq(absenceBalances.employeeId, employeeId),
          eq(absenceBalances.periodLabel, periodLabel)
        ),
      })
      return reply.send({ data: balances })
    },
  })

  // GET /absences/employee/:employeeId/balances — kept for backwards compatibility
  fastify.get('/employee/:employeeId/balances', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Soldes d\'absences (compat)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }
      const periodLabel = getPeriodLabel()

      const balances = await db.query.absenceBalances.findMany({
        where: and(
          eq(absenceBalances.employeeId, employeeId),
          eq(absenceBalances.periodLabel, periodLabel)
        ),
      })
      return reply.send({ data: balances })
    },
  })

  // GET /absences/pending
  fastify.get('/pending', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'manager', 'admin', 'super_admin')],
    schema: { tags: ['absences'], summary: 'Absences en attente d\'approbation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const list = await db.query.absences.findMany({
        where: eq(absences.status, 'pending'),
      })
      return reply.send({ data: list })
    },
  })

  // POST /absences
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['absences'], summary: 'Soumettre une demande d\'absence' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        employeeId?: string
        absenceTypeId?: string
        absenceTypeCode?: string
        startDate: string
        endDate: string
        halfDay?: boolean
        startHalf?: 'morning' | 'afternoon'
        endHalf?: 'morning' | 'afternoon'
        reason?: string
      }

      // Resolve absence type — accept either absenceTypeId (UUID) or absenceTypeCode
      let absenceTypeId = body.absenceTypeId
      if (!absenceTypeId && body.absenceTypeCode) {
        const found = await db.query.absenceTypes.findFirst({
          where: eq(absenceTypes.code, body.absenceTypeCode),
        })
        absenceTypeId = found?.id
      }
      // Fallback: use first available absence type
      if (!absenceTypeId) {
        const first = await db.query.absenceTypes.findFirst()
        absenceTypeId = first?.id
      }
      // Last resort: auto-create default absence types for tenants that have none
      if (!absenceTypeId) {
        // Must resolve entityId first — absenceTypes.entityId is NOT NULL
        const [entity] = await db.select({ id: legalEntities.id }).from(legalEntities).limit(1)
        if (entity) {
          const defaultTypes = [
            { entityId: entity.id, code: 'CP',         label: 'Congés payés',       category: 'paid',   color: '#4F46E5', requiresApproval: true,  isPaid: true,  maxDaysPerYear: '25' },
            { entityId: entity.id, code: 'RTT',        label: 'RTT',                category: 'paid',   color: '#7C3AED', requiresApproval: true,  isPaid: true,  maxDaysPerYear: '12' },
            { entityId: entity.id, code: 'MALADIE',    label: 'Maladie',            category: 'sick',   color: '#EF4444', requiresApproval: false, isPaid: false, maxDaysPerYear: '90' },
            { entityId: entity.id, code: 'SANS_SOLDE', label: 'Sans solde',         category: 'unpaid', color: '#6B7280', requiresApproval: true,  isPaid: false, maxDaysPerYear: '365' },
            { entityId: entity.id, code: 'MATERNITE',  label: 'Maternité',          category: 'family', color: '#EC4899', requiresApproval: false, isPaid: true,  maxDaysPerYear: '112' },
            { entityId: entity.id, code: 'PATERNITE',  label: 'Paternité',          category: 'family', color: '#8B5CF6', requiresApproval: false, isPaid: true,  maxDaysPerYear: '25' },
            { entityId: entity.id, code: 'EVENEMENT',  label: 'Événement familial', category: 'family', color: '#F59E0B', requiresApproval: false, isPaid: true,  maxDaysPerYear: '5' },
          ]
          for (const t of defaultTypes) {
            await db.insert(absenceTypes).values(t as never).onConflictDoNothing()
          }
        }
        const code = body.absenceTypeCode ?? 'CP'
        const found2 = await db.query.absenceTypes.findFirst({
          where: eq(absenceTypes.code, code),
        })
        absenceTypeId = found2?.id ?? (await db.query.absenceTypes.findFirst())?.id
      }
      if (!absenceTypeId) {
        return reply.status(422).send({ error: 'Type d\'absence introuvable' })
      }

      // Resolve employeeId — use the JWT employeeId for employees, or the provided one for HR/admin
      const employeeId = body.employeeId ?? request.user.employeeId ?? request.user.sub

      const daysCount = body.halfDay
        ? 0.5
        : calcWorkingDays(body.startDate, body.endDate)

      const [absence] = await db
        .insert(absences)
        .values({
          employeeId,
          absenceTypeId,
          startDate: body.startDate,
          endDate: body.endDate,
          startHalf: body.halfDay ? 'morning' : (body.startHalf ?? null),
          endHalf: body.halfDay ? 'morning' : (body.endHalf ?? null),
          daysCount: daysCount.toString(),
          reason: body.reason ?? null,
          status: 'pending',
        })
        .returning()

      return reply.status(201).send({ data: absence })
    },
  })

  // PATCH /absences/:id/approve
  fastify.patch('/:id/approve', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'manager', 'admin', 'super_admin')],
    schema: { tags: ['absences'], summary: 'Approuver une absence (workflow multi-niveaux)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const schemaName = request.user.schemaName

      // Safe migration for existing tenants (idempotent)
      await rawPool.query(
        `ALTER TABLE "${schemaName}".absences ADD COLUMN IF NOT EXISTS validation_level INT NOT NULL DEFAULT 0`
      )
      await rawPool.query(
        `CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_configs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          module VARCHAR(50) NOT NULL UNIQUE,
          levels_count INT NOT NULL DEFAULT 1,
          level1_role VARCHAR(50) NOT NULL DEFAULT 'manager',
          level2_role VARCHAR(50), level3_role VARCHAR(50), level4_role VARCHAR(50),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      )
      await rawPool.query(
        `INSERT INTO "${schemaName}".workflow_configs (module, levels_count, level1_role)
         VALUES ('absences', 1, 'manager') ON CONFLICT (module) DO NOTHING`
      )

      // Load workflow config
      const cfgRes = await rawPool.query<{ levels_count: number }>(
        `SELECT levels_count FROM "${schemaName}".workflow_configs WHERE module = 'absences' LIMIT 1`
      )
      const levelsCount = cfgRes.rows[0]?.levels_count ?? 1

      // Load current absence
      const currentRes = await rawPool.query<{ validation_level: number; status: string }>(
        `SELECT validation_level, status FROM "${schemaName}".absences WHERE id = $1`, [id]
      )
      const current = currentRes.rows[0]
      if (!current) return reply.status(404).send({ error: 'Absence introuvable' })
      if (current.status === 'approved') return reply.status(422).send({ error: 'Absence déjà approuvée' })
      if (current.status === 'rejected') return reply.status(422).send({ error: 'Absence déjà refusée' })

      const nextLevel = current.validation_level + 1
      const isFullyApproved = nextLevel >= levelsCount

      const [updated] = await db
        .update(absences)
        .set({
          validationLevel: nextLevel,
          status: isFullyApproved ? 'approved' : 'pending',
          approvedBy: isFullyApproved ? request.user.sub : null,
          approvedAt: isFullyApproved ? new Date() : null,
        } as never)
        .where(eq(absences.id, id))
        .returning()

      return reply.send({
        data: updated,
        message: isFullyApproved
          ? 'Absence approuvée définitivement'
          : `Niveau ${nextLevel}/${levelsCount} validé — en attente du niveau suivant`,
        fullyApproved: isFullyApproved,
        currentLevel: nextLevel,
        totalLevels: levelsCount,
      })
    },
  })

  // PATCH /absences/:id/reject
  fastify.patch('/:id/reject', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'manager', 'admin', 'super_admin')],
    schema: { tags: ['absences'], summary: 'Refuser une absence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { reason } = (request.body as { reason?: string }) ?? {}
      const [updated] = await db
        .update(absences)
        .set({
          status: 'rejected',
          approvedBy: request.user.sub,
          approvedAt: new Date(),
          rejectionReason: reason ?? null,
        })
        .where(eq(absences.id, id))
        .returning()
      return reply.send({ data: updated })
    },
  })
}

export default absencesRoutes
