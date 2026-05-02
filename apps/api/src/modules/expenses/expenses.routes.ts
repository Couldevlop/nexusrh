import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { expenseReports, expenseLines } from '../../db/schema/expenses'
import { employees } from '../../db/schema/employees'
import { config } from '../../config'
import { ensureTenantSchema } from '../../utils/schema-migrations'

const ensureSchemaMigrated = ensureTenantSchema
// Pool brut pour les requêtes workflow dans les handlers approve/reject
const rawPool = new Pool({ connectionString: config.database.url })

const expensesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /expenses/reports — all reports (admin/hr) or own reports (employee)
  fastify.get('/reports', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['expenses'], summary: 'Notes de frais' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.query as { employeeId?: string }
      const reports = await db.query.expenseReports.findMany({
        where: employeeId ? eq(expenseReports.employeeId, employeeId) : undefined,
        orderBy: [expenseReports.createdAt],
      })
      return reply.send({ data: reports })
    },
  })

  // GET /expenses/reports/:id
  fastify.get('/reports/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['expenses'], summary: 'Détail d\'une note de frais' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const report = await db.query.expenseReports.findFirst({
        where: eq(expenseReports.id, id),
      })
      if (!report) return reply.status(404).send({ error: 'Note de frais introuvable' })
      return reply.send({ data: report })
    },
  })

  // POST /expenses/reports
  fastify.post('/reports', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['expenses'], summary: 'Créer une note de frais' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        title: string
        expenseDate?: string
        month?: string
        submitNow?: boolean
        employeeId?: string
        lines?: Array<{
          description: string
          category: string
          date?: string
          amountHT?: number
          vatRate?: number
          amountTTC?: number
          amount?: number
        }>
      }

      // Resolve employeeId:
      // 1. body.employeeId  (admin creating on behalf of an employee)
      // 2. request.user.employeeId  (employee self-service, from JWT)
      // 3. Lookup by email  (admin/hr who have no employeeId in JWT)
      // NOTE: request.user.sub is a users.id, NOT an employees.id — never use as FK
      let employeeId: string | null =
        body.employeeId ?? request.user.employeeId ?? null

      if (!employeeId) {
        const [emp] = await db
          .select({ id: employees.id })
          .from(employees)
          .where(eq(employees.email, request.user.email))
          .limit(1)

        if (!emp) {
          return reply.status(422).send({
            error: 'Aucun dossier employé associé à votre compte. Demandez à votre administrateur de créer votre fiche employé.',
          })
        }
        employeeId = emp.id
      }

      // month is NOT NULL — derive from expenseDate or current month
      const month = body.month ?? (body.expenseDate
        ? body.expenseDate.slice(0, 7)
        : new Date().toISOString().slice(0, 7))

      const totalAmount = body.lines?.reduce((s, l) => {
        const amt = l.amount ?? l.amountTTC ?? 0
        return s + amt
      }, 0) ?? 0

      const status = body.submitNow ? 'submitted' : 'draft'

      const [report] = await db
        .insert(expenseReports)
        .values({
          employeeId,
          title: body.title,
          month,
          totalAmount: totalAmount.toString(),
          currency: 'EUR',
          status,
          submittedAt: status === 'submitted' ? new Date() : null,
        } as never)
        .returning()

      if (!report) return reply.status(500).send({ error: 'Erreur lors de la création' })

      // Insert expense lines if provided
      if (body.lines && body.lines.length > 0) {
        const today = new Date().toISOString().slice(0, 10)
        await db.insert(expenseLines).values(
          body.lines.map((l) => ({
            reportId: report.id,
            description: l.description,
            category: l.category,
            date: l.date ?? today,  // date is NOT NULL
            amount: (l.amount ?? l.amountTTC ?? l.amountHT ?? 0).toString(),  // amount is NOT NULL
            currency: 'EUR',
          } as never))
        )
      }

      return reply.status(201).send({ data: report })
    },
  })

  // PATCH /expenses/reports/:id/submit
  fastify.patch('/reports/:id/submit', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['expenses'], summary: 'Soumettre une note de frais' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const [updated] = await db
        .update(expenseReports)
        .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(expenseReports.id, id))
        .returning()
      return reply.send({ data: updated })
    },
  })

  // PATCH /expenses/reports/:id/approve
  fastify.patch('/reports/:id/approve', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'manager', 'admin', 'super_admin')],
    schema: { tags: ['expenses'], summary: 'Approuver une note de frais (workflow multi-niveaux)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const schemaName = request.user.schemaName

      // Load workflow config
      const cfgRes = await rawPool.query<{ levels_count: number }>(
        `SELECT levels_count FROM "${schemaName}".workflow_configs WHERE module = 'expenses' LIMIT 1`
      )
      const levelsCount = cfgRes.rows[0]?.levels_count ?? 1

      // Load current report
      const currentRes = await rawPool.query<{ validation_level: number; status: string }>(
        `SELECT validation_level, status FROM "${schemaName}".expense_reports WHERE id = $1`, [id]
      )
      const current = currentRes.rows[0]
      if (!current) return reply.status(404).send({ error: 'Note de frais introuvable' })
      if (current.status === 'approved') return reply.status(422).send({ error: 'Note déjà approuvée' })
      if (current.status === 'rejected') return reply.status(422).send({ error: 'Note déjà refusée' })

      const nextLevel = current.validation_level + 1
      const isFullyApproved = nextLevel >= levelsCount

      const [updated] = await db
        .update(expenseReports)
        .set({
          validationLevel: nextLevel,
          status: isFullyApproved ? 'approved' : 'submitted',
          approvedBy: isFullyApproved ? request.user.sub : null,
          approvedAt: isFullyApproved ? new Date() : null,
          updatedAt: new Date(),
        } as never)
        .where(eq(expenseReports.id, id))
        .returning()

      return reply.send({
        data: updated,
        message: isFullyApproved
          ? 'Note de frais approuvée définitivement'
          : `Niveau ${nextLevel}/${levelsCount} validé — en attente du niveau suivant`,
        fullyApproved: isFullyApproved,
        currentLevel: nextLevel,
        totalLevels: levelsCount,
      })
    },
  })

  // PATCH /expenses/reports/:id/reject
  fastify.patch('/reports/:id/reject', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'manager', 'admin', 'super_admin')],
    schema: { tags: ['expenses'], summary: 'Refuser une note de frais' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { reason } = (request.body as { reason?: string }) ?? {}
      const [updated] = await db
        .update(expenseReports)
        .set({ status: 'rejected', rejectionReason: reason ?? null, updatedAt: new Date() })
        .where(eq(expenseReports.id, id))
        .returning()
      return reply.send({ data: updated })
    },
  })

  // GET /expenses/my-expenses — employee self-service
  fastify.get('/my-expenses', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['expenses'], summary: 'Mes notes de frais' },
    handler: async (request, reply) => {
      await ensureSchemaMigrated(request.user.schemaName ?? '')
      const db = getTenantDbForRequest(request)
      let employeeId: string | null = request.user.employeeId ?? null

      if (!employeeId) {
        const [emp] = await db
          .select({ id: employees.id })
          .from(employees)
          .where(eq(employees.email, request.user.email))
          .limit(1)
        employeeId = emp?.id ?? null
      }

      if (!employeeId) return reply.send({ data: [] })

      const reports = await db.query.expenseReports.findMany({
        where: eq(expenseReports.employeeId, employeeId),
        orderBy: [expenseReports.createdAt],
      })
      return reply.send({ data: reports })
    },
  })
}

export default expensesRoutes
