import type { FastifyPluginAsync } from 'fastify'
import { eq, asc, desc, and, gte, lte, count, sql, isNull } from 'drizzle-orm'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { trainingCourses, trainingSessions, trainingEnrollments } from '../../db/schema/training'
import { employees, departments, legalEntities } from '../../db/schema/employees'
import PDFDocument from 'pdfkit'

const trainingRoutes: FastifyPluginAsync = async (fastify) => {
  // ─── COURSES ────────────────────────────────────────────────────────────────

  // GET /training/courses — catalogue complet avec stats
  fastify.get('/courses', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Catalogue des formations' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)

      const courses = await db
        .select({
          id: trainingCourses.id,
          entityId: trainingCourses.entityId,
          title: trainingCourses.title,
          description: trainingCourses.description,
          category: trainingCourses.category,
          provider: trainingCourses.provider,
          format: trainingCourses.format,
          durationHours: trainingCourses.durationHours,
          cpfEligible: trainingCourses.cpfEligible,
          cpfCode: trainingCourses.cpfCode,
          cost: trainingCourses.cost,
          isActive: trainingCourses.isActive,
          createdAt: trainingCourses.createdAt,
        })
        .from(trainingCourses)
        .where(eq(trainingCourses.isActive, true))
        .orderBy(asc(trainingCourses.title))

      // Enrich with session counts
      const sessionCounts = await db
        .select({
          courseId: trainingSessions.courseId,
          total: count(),
          upcoming: count(
            sql`CASE WHEN ${trainingSessions.startDate} >= CURRENT_DATE AND ${trainingSessions.status} = 'scheduled' THEN 1 END`
          ),
        })
        .from(trainingSessions)
        .groupBy(trainingSessions.courseId)

      const sessionMap = new Map(sessionCounts.map((s) => [s.courseId, s]))

      const enriched = courses.map((c) => ({
        ...c,
        sessionsCount: Number(sessionMap.get(c.id)?.total ?? 0),
        upcomingSessionsCount: Number(sessionMap.get(c.id)?.upcoming ?? 0),
      }))

      return reply.send({ data: enriched })
    },
  })

  // GET /training/catalog — alias
  fastify.get('/catalog', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Catalogue des formations (alias)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const courses = await db
        .select()
        .from(trainingCourses)
        .where(eq(trainingCourses.isActive, true))
        .orderBy(asc(trainingCourses.title))
      return reply.send({ data: courses })
    },
  })

  // POST /training/courses — créer une formation
  fastify.post('/courses', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['training'], summary: 'Créer une formation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        title: string
        category?: string
        durationHours?: number
        duration?: number
        provider?: string
        description?: string
        format?: string
        cpfEligible?: boolean
        cpfCode?: string
        cost?: number
        maxParticipants?: number
      }

      const [entity] = await db.select({ id: legalEntities.id }).from(legalEntities).limit(1)
      if (!entity) {
        return reply.status(422).send({ error: 'Aucune entité juridique configurée' })
      }

      const [course] = await db
        .insert(trainingCourses)
        .values({
          entityId: entity.id,
          title: body.title,
          category: body.category ?? 'Autre',
          durationHours: body.durationHours ?? body.duration ?? 8,
          provider: body.provider ?? null,
          description: body.description ?? null,
          format: body.format ?? 'in_person',
          cpfEligible: body.cpfEligible ?? false,
          cpfCode: body.cpfCode ?? null,
          cost: body.cost ? String(body.cost) : null,
          isActive: true,
        } as never)
        .returning()

      return reply.status(201).send({ data: course })
    },
  })

  // PATCH /training/courses/:id — modifier une formation
  fastify.patch('/courses/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['training'], summary: 'Modifier une formation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Partial<{
        title: string
        description: string
        category: string
        provider: string
        format: string
        durationHours: number
        cpfEligible: boolean
        cpfCode: string
        cost: number
        isActive: boolean
      }>

      const updateData: Record<string, unknown> = {}
      if (body.title !== undefined) updateData.title = body.title
      if (body.description !== undefined) updateData.description = body.description
      if (body.category !== undefined) updateData.category = body.category
      if (body.provider !== undefined) updateData.provider = body.provider
      if (body.format !== undefined) updateData.format = body.format
      if (body.durationHours !== undefined) updateData.durationHours = body.durationHours
      if (body.cpfEligible !== undefined) updateData.cpfEligible = body.cpfEligible
      if (body.cpfCode !== undefined) updateData.cpfCode = body.cpfCode
      if (body.cost !== undefined) updateData.cost = String(body.cost)
      if (body.isActive !== undefined) updateData.isActive = body.isActive

      const [updated] = await db
        .update(trainingCourses)
        .set(updateData as never)
        .where(eq(trainingCourses.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Formation introuvable' })
      return reply.send({ data: updated })
    },
  })

  // DELETE /training/courses/:id — archiver une formation (soft delete)
  fastify.delete('/courses/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['training'], summary: 'Archiver une formation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      await db
        .update(trainingCourses)
        .set({ isActive: false } as never)
        .where(eq(trainingCourses.id, id))
      return reply.send({ success: true })
    },
  })

  // ─── SESSIONS ────────────────────────────────────────────────────────────────

  // GET /training/sessions — toutes les sessions
  fastify.get('/sessions', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Toutes les sessions de formation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const qs = request.query as { status?: string; year?: string }

      const conditions = []
      if (qs.status) conditions.push(eq(trainingSessions.status, qs.status))
      if (qs.year) {
        conditions.push(gte(trainingSessions.startDate, `${qs.year}-01-01`))
        conditions.push(lte(trainingSessions.startDate, `${qs.year}-12-31`))
      }

      const sessions = await db
        .select({
          id: trainingSessions.id,
          courseId: trainingSessions.courseId,
          courseTitle: trainingCourses.title,
          courseCategory: trainingCourses.category,
          courseDurationHours: trainingCourses.durationHours,
          courseCpfEligible: trainingCourses.cpfEligible,
          courseCost: trainingCourses.cost,
          provider: trainingCourses.provider,
          startDate: trainingSessions.startDate,
          endDate: trainingSessions.endDate,
          location: trainingSessions.location,
          maxParticipants: trainingSessions.maxParticipants,
          status: trainingSessions.status,
          createdAt: trainingSessions.createdAt,
        })
        .from(trainingSessions)
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(trainingSessions.startDate))

      // Enrich with enrolled count
      const enrolledCounts = await db
        .select({
          sessionId: trainingEnrollments.sessionId,
          enrolled: count(),
        })
        .from(trainingEnrollments)
        .where(eq(trainingEnrollments.status, 'enrolled'))
        .groupBy(trainingEnrollments.sessionId)

      const enrolledMap = new Map(enrolledCounts.map((e) => [e.sessionId, Number(e.enrolled)]))

      const enriched = sessions.map((s) => ({
        ...s,
        enrolledCount: enrolledMap.get(s.id) ?? 0,
        availableSpots: s.maxParticipants
          ? s.maxParticipants - (enrolledMap.get(s.id) ?? 0)
          : null,
      }))

      return reply.send({ data: enriched })
    },
  })

  // POST /training/sessions — créer une session
  fastify.post('/sessions', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['training'], summary: 'Créer une session de formation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        courseId: string
        startDate: string
        endDate: string
        location?: string
        maxParticipants?: number
      }

      const [course] = await db
        .select()
        .from(trainingCourses)
        .where(eq(trainingCourses.id, body.courseId))
        .limit(1)
      if (!course) return reply.status(404).send({ error: 'Formation introuvable' })

      const [session] = await db
        .insert(trainingSessions)
        .values({
          courseId: body.courseId,
          startDate: body.startDate,
          endDate: body.endDate,
          location: body.location ?? null,
          maxParticipants: body.maxParticipants ?? null,
          status: 'scheduled',
        } as never)
        .returning()

      return reply.status(201).send({ data: session })
    },
  })

  // PATCH /training/sessions/:id — modifier une session
  fastify.patch('/sessions/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin')],
    schema: { tags: ['training'], summary: 'Modifier une session' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Partial<{
        startDate: string
        endDate: string
        location: string
        maxParticipants: number
        status: string
      }>

      const updateData: Record<string, unknown> = {}
      if (body.startDate !== undefined) updateData.startDate = body.startDate
      if (body.endDate !== undefined) updateData.endDate = body.endDate
      if (body.location !== undefined) updateData.location = body.location
      if (body.maxParticipants !== undefined) updateData.maxParticipants = body.maxParticipants
      if (body.status !== undefined) updateData.status = body.status

      const [updated] = await db
        .update(trainingSessions)
        .set(updateData as never)
        .where(eq(trainingSessions.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Session introuvable' })
      return reply.send({ data: updated })
    },
  })

  // GET /training/sessions/:id/enrollments — participants d'une session
  fastify.get('/sessions/:id/enrollments', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Participants d\'une session' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }

      const results = await db
        .select({
          id: trainingEnrollments.id,
          sessionId: trainingEnrollments.sessionId,
          employeeId: trainingEnrollments.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          employeeEmail: employees.email,
          employeeJobTitle: employees.jobTitle,
          status: trainingEnrollments.status,
          completedAt: trainingEnrollments.completedAt,
          rating: trainingEnrollments.rating,
          feedback: trainingEnrollments.feedback,
          certificate: trainingEnrollments.certificate,
          cpfHoursUsed: trainingEnrollments.cpfHoursUsed,
          createdAt: trainingEnrollments.createdAt,
        })
        .from(trainingEnrollments)
        .leftJoin(employees, eq(trainingEnrollments.employeeId, employees.id))
        .where(eq(trainingEnrollments.sessionId, id))
        .orderBy(asc(employees.lastName))

      return reply.send({ data: results })
    },
  })

  // POST /training/sessions/:id/enroll — inscrire un ou plusieurs employés
  fastify.post('/sessions/:id/enroll', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Inscrire à une session' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id: sessionId } = request.params as { id: string }
      const body = request.body as { employeeId?: string; employeeIds?: string[] }
      const userId = request.user.sub

      const [session] = await db
        .select()
        .from(trainingSessions)
        .where(eq(trainingSessions.id, sessionId))
        .limit(1)
      if (!session) return reply.status(404).send({ error: 'Session introuvable' })

      // Check capacity
      if (session.maxParticipants) {
        const enrolledResult = await db
          .select({ enrolled: count() })
          .from(trainingEnrollments)
          .where(
            and(
              eq(trainingEnrollments.sessionId, sessionId),
              eq(trainingEnrollments.status, 'enrolled')
            )
          )
        const enrolled = enrolledResult[0]?.enrolled ?? 0
        if (Number(enrolled) >= session.maxParticipants) {
          return reply.status(409).send({ error: 'Session complète — aucune place disponible' })
        }
      }

      const employeeIds = body.employeeIds ?? (body.employeeId ? [body.employeeId] : [])
      if (employeeIds.length === 0) {
        const empId = request.user.employeeId ?? request.user.sub
        employeeIds.push(empId)
      }

      const created = []
      for (const employeeId of employeeIds) {
        // Avoid duplicate enrollment
        const [existing] = await db
          .select()
          .from(trainingEnrollments)
          .where(
            and(
              eq(trainingEnrollments.sessionId, sessionId),
              eq(trainingEnrollments.employeeId, employeeId),
              eq(trainingEnrollments.status, 'enrolled')
            )
          )
          .limit(1)
        if (existing) continue

        const [enrollment] = await db
          .insert(trainingEnrollments)
          .values({
            sessionId,
            employeeId,
            status: 'enrolled',
            enrolledBy: userId,
          } as never)
          .returning()
        created.push(enrollment)
      }

      return reply.status(201).send({ data: created, count: created.length })
    },
  })

  // ─── ENROLLMENTS ─────────────────────────────────────────────────────────────

  // GET /training/enrollments — toutes les inscriptions (admin/RH)
  fastify.get('/enrollments', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Toutes les inscriptions' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const qs = request.query as { status?: string; year?: string }

      const conditions = []
      if (qs.status) conditions.push(eq(trainingEnrollments.status, qs.status))

      const results = await db
        .select({
          id: trainingEnrollments.id,
          sessionId: trainingEnrollments.sessionId,
          employeeId: trainingEnrollments.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          employeeJobTitle: employees.jobTitle,
          departmentName: departments.name,
          courseId: trainingSessions.courseId,
          courseTitle: trainingCourses.title,
          courseCategory: trainingCourses.category,
          courseDurationHours: trainingCourses.durationHours,
          courseCpfEligible: trainingCourses.cpfEligible,
          courseCost: trainingCourses.cost,
          sessionStartDate: trainingSessions.startDate,
          sessionEndDate: trainingSessions.endDate,
          sessionLocation: trainingSessions.location,
          status: trainingEnrollments.status,
          completedAt: trainingEnrollments.completedAt,
          rating: trainingEnrollments.rating,
          feedback: trainingEnrollments.feedback,
          certificate: trainingEnrollments.certificate,
          cpfHoursUsed: trainingEnrollments.cpfHoursUsed,
          createdAt: trainingEnrollments.createdAt,
        })
        .from(trainingEnrollments)
        .leftJoin(employees, eq(trainingEnrollments.employeeId, employees.id))
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(trainingEnrollments.createdAt))

      return reply.send({ data: results })
    },
  })

  // GET /training/my-enrollments — inscriptions de l'employé connecté
  fastify.get('/my-enrollments', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Mes inscriptions aux formations' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const employeeId = request.user.employeeId ?? request.user.sub

      const results = await db
        .select({
          id: trainingEnrollments.id,
          sessionId: trainingEnrollments.sessionId,
          courseTitle: trainingCourses.title,
          courseCategory: trainingCourses.category,
          courseDurationHours: trainingCourses.durationHours,
          courseCpfEligible: trainingCourses.cpfEligible,
          provider: trainingCourses.provider,
          sessionStartDate: trainingSessions.startDate,
          sessionEndDate: trainingSessions.endDate,
          sessionLocation: trainingSessions.location,
          status: trainingEnrollments.status,
          completedAt: trainingEnrollments.completedAt,
          rating: trainingEnrollments.rating,
          certificate: trainingEnrollments.certificate,
          cpfHoursUsed: trainingEnrollments.cpfHoursUsed,
          createdAt: trainingEnrollments.createdAt,
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(eq(trainingEnrollments.employeeId, employeeId))
        .orderBy(desc(trainingEnrollments.createdAt))

      return reply.send({ data: results })
    },
  })

  // GET /training/enrollments/employee/:employeeId
  fastify.get('/enrollments/employee/:employeeId', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Formations d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }

      const results = await db
        .select({
          id: trainingEnrollments.id,
          sessionId: trainingEnrollments.sessionId,
          courseTitle: trainingCourses.title,
          courseCategory: trainingCourses.category,
          courseDurationHours: trainingCourses.durationHours,
          sessionStartDate: trainingSessions.startDate,
          sessionEndDate: trainingSessions.endDate,
          status: trainingEnrollments.status,
          completedAt: trainingEnrollments.completedAt,
          rating: trainingEnrollments.rating,
          certificate: trainingEnrollments.certificate,
          createdAt: trainingEnrollments.createdAt,
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(eq(trainingEnrollments.employeeId, employeeId))
        .orderBy(desc(trainingEnrollments.createdAt))

      return reply.send({ data: results })
    },
  })

  // PATCH /training/enrollments/:id — compléter/annuler + évaluation
  fastify.patch('/enrollments/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Mettre à jour une inscription' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Partial<{
        status: 'enrolled' | 'completed' | 'cancelled' | 'absent'
        rating: number
        feedback: string
        cpfHoursUsed: number
      }>

      const updateData: Record<string, unknown> = {}
      if (body.status !== undefined) {
        updateData.status = body.status
        if (body.status === 'completed') {
          updateData.completedAt = new Date()
        }
      }
      if (body.rating !== undefined) updateData.rating = body.rating
      if (body.feedback !== undefined) updateData.feedback = body.feedback
      if (body.cpfHoursUsed !== undefined) updateData.cpfHoursUsed = String(body.cpfHoursUsed)

      const [updated] = await db
        .update(trainingEnrollments)
        .set(updateData as never)
        .where(eq(trainingEnrollments.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Inscription introuvable' })
      return reply.send({ data: updated })
    },
  })

  // POST /training/enroll — auto-inscription (employé self-service, compatible legacy)
  fastify.post('/enroll', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Auto-inscription (legacy)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as { courseId?: string; sessionId?: string; employeeId?: string }
      const employeeId = body.employeeId ?? request.user.employeeId ?? request.user.sub

      let sessionId = body.sessionId

      // If only courseId provided, find next upcoming session for that course
      if (!sessionId && body.courseId) {
        const [nextSession] = await db
          .select({ id: trainingSessions.id })
          .from(trainingSessions)
          .where(
            and(
              eq(trainingSessions.courseId, body.courseId),
              eq(trainingSessions.status, 'scheduled'),
              gte(trainingSessions.startDate, new Date().toISOString().slice(0, 10))
            )
          )
          .orderBy(asc(trainingSessions.startDate))
          .limit(1)

        if (!nextSession) {
          return reply.status(404).send({ error: 'Aucune session disponible pour cette formation' })
        }
        sessionId = nextSession.id
      }

      if (!sessionId) {
        return reply.status(400).send({ error: 'sessionId ou courseId requis' })
      }

      const [enrollment] = await db
        .insert(trainingEnrollments)
        .values({
          sessionId,
          employeeId,
          status: 'enrolled',
          enrolledBy: request.user.sub,
        } as never)
        .returning()

      return reply.status(201).send({ data: enrollment })
    },
  })

  // ─── ATTESTATIONS PDF ─────────────────────────────────────────────────────────

  // GET /training/enrollments/:id/certificate — générer attestation PDF
  fastify.get('/enrollments/:id/certificate', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Attestation de formation PDF' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }

      const [enrollment] = await db
        .select({
          id: trainingEnrollments.id,
          status: trainingEnrollments.status,
          completedAt: trainingEnrollments.completedAt,
          rating: trainingEnrollments.rating,
          cpfHoursUsed: trainingEnrollments.cpfHoursUsed,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          employeeJobTitle: employees.jobTitle,
          courseTitle: trainingCourses.title,
          courseCategory: trainingCourses.category,
          courseDurationHours: trainingCourses.durationHours,
          provider: trainingCourses.provider,
          cpfEligible: trainingCourses.cpfEligible,
          cpfCode: trainingCourses.cpfCode,
          sessionStartDate: trainingSessions.startDate,
          sessionEndDate: trainingSessions.endDate,
          sessionLocation: trainingSessions.location,
        })
        .from(trainingEnrollments)
        .leftJoin(employees, eq(trainingEnrollments.employeeId, employees.id))
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(eq(trainingEnrollments.id, id))
        .limit(1)

      if (!enrollment) return reply.status(404).send({ error: 'Inscription introuvable' })
      if (enrollment.status !== 'completed') {
        return reply.status(400).send({ error: 'La formation doit être terminée pour générer l\'attestation' })
      }

      const doc = new PDFDocument({ size: 'A4', margin: 60 })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))

      await new Promise<void>((resolve) => {
        doc.on('end', () => resolve())

        // Header band
        doc.rect(0, 0, 595, 160).fill('#4F46E5')

        doc.fillColor('white')
          .fontSize(28)
          .font('Helvetica-Bold')
          .text('ATTESTATION DE FORMATION', 60, 50, { align: 'center', width: 475 })

        doc.fontSize(12)
          .font('Helvetica')
          .text('Ce document certifie la participation et l\'accomplissement de la formation', 60, 100, {
            align: 'center',
            width: 475,
          })

        // Body
        doc.fillColor('#1F2937').fontSize(14).font('Helvetica').moveDown(4)

        const y = 200
        doc.text('Il est certifié que', 60, y, { align: 'center', width: 475 })

        doc.font('Helvetica-Bold')
          .fontSize(22)
          .fillColor('#4F46E5')
          .text(`${enrollment.employeeFirstName ?? ''} ${enrollment.employeeLastName ?? ''}`, 60, y + 30, {
            align: 'center',
            width: 475,
          })

        if (enrollment.employeeJobTitle) {
          doc.font('Helvetica').fontSize(12).fillColor('#6B7280').text(enrollment.employeeJobTitle, 60, y + 65, {
            align: 'center',
            width: 475,
          })
        }

        doc.font('Helvetica').fontSize(13).fillColor('#1F2937').text('a suivi et complété la formation', 60, y + 100, {
          align: 'center',
          width: 475,
        })

        doc.font('Helvetica-Bold')
          .fontSize(18)
          .fillColor('#111827')
          .text(`« ${enrollment.courseTitle ?? 'Formation'} »`, 60, y + 128, {
            align: 'center',
            width: 475,
          })

        // Details box
        const boxY = 390
        doc.rect(80, boxY, 435, 140).fill('#F8FAFC').stroke('#E2E8F0')

        const details = [
          { label: 'Catégorie', value: enrollment.courseCategory ?? '-' },
          { label: 'Durée', value: `${enrollment.courseDurationHours ?? 0} heures` },
          {
            label: 'Date',
            value: enrollment.sessionStartDate
              ? enrollment.sessionStartDate === enrollment.sessionEndDate
                ? new Date(enrollment.sessionStartDate).toLocaleDateString('fr-FR')
                : `${new Date(enrollment.sessionStartDate).toLocaleDateString('fr-FR')} — ${new Date(enrollment.sessionEndDate ?? '').toLocaleDateString('fr-FR')}`
              : '-',
          },
          { label: 'Lieu', value: enrollment.sessionLocation ?? 'En ligne / Interne' },
          { label: 'Organisme', value: enrollment.provider ?? 'Interne' },
        ]

        details.forEach((d, i) => {
          const dy = boxY + 12 + i * 24
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#6B7280').text(d.label.toUpperCase(), 100, dy)
          doc.font('Helvetica').fontSize(10).fillColor('#1F2937').text(d.value, 250, dy)
        })

        // CPF badge
        if (enrollment.cpfEligible) {
          doc.rect(80, 545, 150, 26).fill('#D1FAE5').stroke('#6EE7B7')
          doc.font('Helvetica-Bold').fontSize(9).fillColor('#065F46').text('✓ FORMATION CPF ÉLIGIBLE', 90, 552)
          if (enrollment.cpfCode) {
            doc.font('Helvetica').fontSize(9).fillColor('#065F46').text(`Code CPF : ${enrollment.cpfCode}`, 250, 552)
          }
        }

        // Completion date
        const completedDate = enrollment.completedAt
          ? new Date(enrollment.completedAt).toLocaleDateString('fr-FR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })

        doc.font('Helvetica').fontSize(11).fillColor('#374151').text(
          `Délivrée le ${completedDate}`,
          60,
          600,
          { align: 'center', width: 475 }
        )

        // Rating
        if (enrollment.rating) {
          const stars = '★'.repeat(enrollment.rating) + '☆'.repeat(5 - enrollment.rating)
          doc.font('Helvetica').fontSize(14).fillColor('#F59E0B').text(stars, 60, 625, {
            align: 'center',
            width: 475,
          })
          doc.font('Helvetica').fontSize(9).fillColor('#9CA3AF').text('Note attribuée par le participant', 60, 645, {
            align: 'center',
            width: 475,
          })
        }

        // Footer
        doc.rect(0, 750, 595, 92).fill('#F9FAFB')
        doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text(
          'Ce document tient lieu d\'attestation de présence et de réussite. Il est généré automatiquement par NexusRH.',
          60,
          765,
          { align: 'center', width: 475 }
        )
        doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text(
          `Document généré le ${new Date().toLocaleDateString('fr-FR')} — NexusRH SIRH`,
          60,
          780,
          { align: 'center', width: 475 }
        )

        doc.end()
      })

      const pdf = Buffer.concat(chunks)
      const filename = `attestation_${enrollment.employeeLastName ?? 'inconnu'}_${(enrollment.courseTitle ?? 'formation').replace(/\s+/g, '_')}.pdf`

      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      return reply.send(pdf)
    },
  })

  // ─── STATS / TABLEAU DE BORD ──────────────────────────────────────────────────

  // GET /training/stats — KPIs du module formation
  fastify.get('/stats', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Statistiques formation' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const qs = request.query as { year?: string }
      const year = qs.year ?? new Date().getFullYear().toString()

      // Active courses
      const coursesResult = await db
        .select({ coursesCount: count() })
        .from(trainingCourses)
        .where(eq(trainingCourses.isActive, true))
      const coursesCount = coursesResult[0]?.coursesCount ?? 0

      // Sessions this year
      const sessionsResult = await db
        .select({ sessionsCount: count() })
        .from(trainingSessions)
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
      const sessionsCount = sessionsResult[0]?.sessionsCount ?? 0

      // Enrollments this year
      const enrolledResult2 = await db
        .select({ totalEnrolled: count() })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
      const totalEnrolled = enrolledResult2[0]?.totalEnrolled ?? 0

      // Completed this year
      const completedResult = await db
        .select({ completedCount: count() })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .where(
          and(
            eq(trainingEnrollments.status, 'completed'),
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
      const completedCount = completedResult[0]?.completedCount ?? 0

      // Total hours completed
      const hoursResult = await db
        .select({
          totalHours: sql<number>`COALESCE(SUM(${trainingCourses.durationHours}), 0)`,
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(
          and(
            eq(trainingEnrollments.status, 'completed'),
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )

      const totalHours = Number(hoursResult[0]?.totalHours ?? 0)

      // Total budget spent
      const budgetResult = await db
        .select({
          totalBudget: sql<number>`COALESCE(SUM(${trainingCourses.cost}), 0)`,
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )

      const totalBudget = Number(budgetResult[0]?.totalBudget ?? 0)

      // Average rating
      const ratingResult = await db
        .select({
          avgRating: sql<number>`ROUND(AVG(${trainingEnrollments.rating})::numeric, 1)`,
        })
        .from(trainingEnrollments)
        .where(sql`${trainingEnrollments.rating} IS NOT NULL`)

      const avgRating = Number(ratingResult[0]?.avgRating ?? 0)

      // Completion rate
      const completionRate =
        Number(totalEnrolled) > 0 ? Math.round((Number(completedCount) / Number(totalEnrolled)) * 100) : 0

      // By category breakdown
      const byCategory = await db
        .select({
          category: trainingCourses.category,
          enrolled: count(),
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
        .groupBy(trainingCourses.category)
        .orderBy(desc(count()))

      // Top formations
      const topCourses = await db
        .select({
          courseTitle: trainingCourses.title,
          enrolled: count(),
          category: trainingCourses.category,
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
        .groupBy(trainingCourses.title, trainingCourses.category)
        .orderBy(desc(count()))
        .limit(5)

      // Monthly evolution
      const monthly = await db
        .select({
          month: sql<string>`TO_CHAR(${trainingSessions.startDate}::date, 'YYYY-MM')`,
          enrolled: count(),
          completed: count(
            sql`CASE WHEN ${trainingEnrollments.status} = 'completed' THEN 1 END`
          ),
        })
        .from(trainingEnrollments)
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
        .groupBy(sql`TO_CHAR(${trainingSessions.startDate}::date, 'YYYY-MM')`)
        .orderBy(sql`TO_CHAR(${trainingSessions.startDate}::date, 'YYYY-MM')`)

      return reply.send({
        data: {
          year: Number(year),
          kpis: {
            coursesCount: Number(coursesCount),
            sessionsCount: Number(sessionsCount),
            totalEnrolled: Number(totalEnrolled),
            completedCount: Number(completedCount),
            completionRate,
            totalHours,
            totalBudget,
            avgRating,
          },
          byCategory,
          topCourses,
          monthly,
        },
      })
    },
  })

  // ─── PLAN ANNUEL ──────────────────────────────────────────────────────────────

  // GET /training/plan — plan de formation annuel (sessions + inscriptions agrégées)
  fastify.get('/plan', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['training'], summary: 'Plan de formation annuel' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const qs = request.query as { year?: string }
      const year = qs.year ?? new Date().getFullYear().toString()

      const sessions = await db
        .select({
          id: trainingSessions.id,
          courseId: trainingSessions.courseId,
          courseTitle: trainingCourses.title,
          courseCategory: trainingCourses.category,
          courseDurationHours: trainingCourses.durationHours,
          courseCost: trainingCourses.cost,
          courseProvider: trainingCourses.provider,
          cpfEligible: trainingCourses.cpfEligible,
          startDate: trainingSessions.startDate,
          endDate: trainingSessions.endDate,
          location: trainingSessions.location,
          maxParticipants: trainingSessions.maxParticipants,
          status: trainingSessions.status,
          enrolledCount: sql<number>`(
            SELECT COUNT(*) FROM training_enrollments te
            WHERE te.session_id = ${trainingSessions.id}
            AND te.status IN ('enrolled', 'completed')
          )`,
        })
        .from(trainingSessions)
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
        .orderBy(asc(trainingSessions.startDate))

      // Department breakdown
      const deptBreakdown = await db
        .select({
          departmentName: departments.name,
          enrolled: count(),
          completed: count(
            sql`CASE WHEN ${trainingEnrollments.status} = 'completed' THEN 1 END`
          ),
          totalHours: sql<number>`COALESCE(SUM(${trainingCourses.durationHours}), 0)`,
          totalCost: sql<number>`COALESCE(SUM(${trainingCourses.cost}), 0)`,
        })
        .from(trainingEnrollments)
        .leftJoin(employees, eq(trainingEnrollments.employeeId, employees.id))
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .leftJoin(trainingSessions, eq(trainingEnrollments.sessionId, trainingSessions.id))
        .leftJoin(trainingCourses, eq(trainingSessions.courseId, trainingCourses.id))
        .where(
          and(
            gte(trainingSessions.startDate, `${year}-01-01`),
            lte(trainingSessions.startDate, `${year}-12-31`)
          )
        )
        .groupBy(departments.name)
        .orderBy(desc(count()))

      const totalBudget = sessions.reduce((acc, s) => {
        const cost = Number(s.courseCost ?? 0)
        return acc + cost * Number(s.enrolledCount ?? 0)
      }, 0)

      return reply.send({
        data: {
          year: Number(year),
          sessions,
          deptBreakdown,
          totalBudget,
          totalSessions: sessions.length,
          totalParticipants: sessions.reduce((acc, s) => acc + Number(s.enrolledCount ?? 0), 0),
        },
      })
    },
  })
}

export default trainingRoutes
