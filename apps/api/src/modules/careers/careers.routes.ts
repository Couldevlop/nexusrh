import type { FastifyPluginAsync } from 'fastify'
import { eq, and, desc, asc, lt, isNull, inArray, sql } from 'drizzle-orm'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { evaluations, developmentPlans, careerPaths, nineBox, skills, employeeSkills } from '../../db/schema/careers'
import { employees, departments } from '../../db/schema/employees'
import { users } from '../../db/schema/auth'
import { sendEmail } from '../../services/email.service'
import { config } from '../../config'
import { ensureTenantSchema } from '../../utils/schema-migrations'
import { logger } from '../../utils/logger'

const careersRoutes: FastifyPluginAsync = async (fastify) => {

  // Garantit que toutes les colonnes sont présentes avant chaque requête (idempotent + cached)
  fastify.addHook('preHandler', async (request) => {
    const schemaName = request.user?.schemaName
    if (schemaName) await ensureTenantSchema(schemaName)
  })

  // ── COMPÉTENCES ────────────────────────────────────────────────────────────

  fastify.get('/skills', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['careers'], summary: 'Référentiel de compétences' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const skillList = await db.query.skills.findMany({
        orderBy: [asc(skills.category), asc(skills.name)],
      })
      return reply.send({ data: skillList })
    },
  })

  fastify.post('/skills', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Créer une compétence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const [skill] = await db.insert(skills).values(request.body as never).returning()
      return reply.status(201).send({ data: skill })
    },
  })

  fastify.patch('/skills/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Modifier une compétence' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const [skill] = await db.update(skills).set(request.body as never).where(eq(skills.id, id)).returning()
      return reply.send({ data: skill })
    },
  })

  fastify.get('/employees/:employeeId/skills', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['careers'], summary: 'Compétences d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }
      const list = await db
        .select({
          id: employeeSkills.id,
          skillId: employeeSkills.skillId,
          skillName: skills.name,
          skillCategory: skills.category,
          level: employeeSkills.level,
          assessedAt: employeeSkills.assessedAt,
        })
        .from(employeeSkills)
        .innerJoin(skills, eq(employeeSkills.skillId, skills.id))
        .where(eq(employeeSkills.employeeId, employeeId))
        .orderBy(asc(skills.category), asc(skills.name))
      return reply.send({ data: list })
    },
  })

  fastify.post('/employees/:employeeId/skills', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Évaluer les compétences d\'un collaborateur' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.params as { employeeId: string }
      const body = request.body as { skillId: string; level: number; assessedAt?: string }
      const [created] = await db
        .insert(employeeSkills)
        .values({ ...body, employeeId, assessedBy: (request.user as { userId: string }).userId })
        .onConflictDoUpdate({
          target: [employeeSkills.employeeId, employeeSkills.skillId],
          set: { level: body.level, assessedAt: body.assessedAt ?? new Date().toISOString().split('T')[0] },
        })
        .returning()
      return reply.status(201).send({ data: created })
    },
  })

  // ── ENTRETIENS ─────────────────────────────────────────────────────────────

  fastify.get('/evaluations', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'admin', 'manager')],
    schema: {
      tags: ['careers'],
      summary: 'Liste des entretiens',
      querystring: {
        type: 'object',
        properties: {
          employeeId: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          year: { type: 'number' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const q = request.query as {
        employeeId?: string
        type?: string
        status?: string
        year?: number
        limit?: number
        offset?: number
      }

      const conditions = []
      if (q.employeeId) conditions.push(eq(evaluations.employeeId, q.employeeId))
      if (q.type) conditions.push(eq(evaluations.type, q.type))
      if (q.status) conditions.push(eq(evaluations.status, q.status))
      if (q.year) conditions.push(eq(evaluations.year, q.year))

      const limit = q.limit ?? 50
      const offset = q.offset ?? 0

      const list = await db
        .select({
          id: evaluations.id,
          type: evaluations.type,
          year: evaluations.year,
          status: evaluations.status,
          scheduledAt: evaluations.scheduledAt,
          completedAt: evaluations.completedAt,
          overallRating: evaluations.overallRating,
          signedByEmployee: evaluations.signedByEmployee,
          signedByManager: evaluations.signedByManager,
          cpfAbondementRequired: evaluations.cpfAbondementRequired,
          employeeId: evaluations.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          employeeJobTitle: employees.jobTitle,
        })
        .from(evaluations)
        .innerJoin(employees, eq(evaluations.employeeId, employees.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(evaluations.scheduledAt))
        .limit(limit)
        .offset(offset)

      return reply.send({ data: list, meta: { limit, offset } })
    },
  })

  fastify.get('/evaluations/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['careers'], summary: 'Détail d\'un entretien' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const ev = await db.query.evaluations.findFirst({
        where: eq(evaluations.id, id),
      })
      if (!ev) return reply.status(404).send({ message: 'Entretien introuvable' })

      // Enrichir avec infos employé
      const [emp] = await db
        .select({ firstName: employees.firstName, lastName: employees.lastName, jobTitle: employees.jobTitle, hireDate: employees.hireDate })
        .from(employees)
        .where(eq(employees.id, ev.employeeId))

      return reply.send({ data: { ...ev, employee: emp } })
    },
  })

  fastify.post('/evaluations', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Planifier un entretien' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as Record<string, unknown>

      if (!body.employeeId || typeof body.employeeId !== 'string') {
        return reply.status(400).send({ error: 'employeeId est obligatoire' })
      }
      if (!body.type || typeof body.type !== 'string') {
        return reply.status(400).send({ error: 'type est obligatoire' })
      }
      if (!body.year) {
        return reply.status(400).send({ error: 'year est obligatoire' })
      }

      // Vérifier que l'employé existe
      const empCheck = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.id, body.employeeId as string))
        .limit(1)
      if (!empCheck[0]) {
        return reply.status(404).send({ error: 'Employé introuvable' })
      }

      const [evaluation] = await db.insert(evaluations).values({
        employeeId: body.employeeId as string,
        type: body.type as string,
        year: Number(body.year),
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt as string) : null,
        status: 'planned',
      }).returning()

      return reply.status(201).send({ data: evaluation })
    },
  })

  fastify.patch('/evaluations/:id', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Modifier / remplir un entretien' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      const [updated] = await db
        .update(evaluations)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(evaluations.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ message: 'Entretien introuvable' })
      return reply.send({ data: updated })
    },
  })

  // ── Workflow : changer le statut d'un entretien ────────────────────────────
  fastify.post('/evaluations/:id/status', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: {
      tags: ['careers'],
      summary: 'Changer le statut d\'un entretien',
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['planned', 'invited', 'in_progress', 'awaiting_employee_sign', 'completed', 'cancelled'],
          },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { status } = request.body as { status: string }

      const update: Record<string, unknown> = { status, updatedAt: new Date() }
      if (status === 'completed') update.completedAt = new Date()

      const [updated] = await db.update(evaluations).set(update as never).where(eq(evaluations.id, id)).returning()
      if (!updated) return reply.status(404).send({ message: 'Entretien introuvable' })

      return reply.send({ data: updated })
    },
  })

  // ── Envoi de l'invitation par email ───────────────────────────────────────
  fastify.post('/evaluations/:id/invite', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Envoyer l\'invitation à l\'entretien' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }

      const ev = await db.query.evaluations.findFirst({ where: eq(evaluations.id, id) })
      if (!ev) return reply.status(404).send({ message: 'Entretien introuvable' })

      const [emp] = await db
        .select({ firstName: employees.firstName, lastName: employees.lastName, email: users.email })
        .from(employees)
        .innerJoin(users, eq(employees.userId, users.id))
        .where(eq(employees.id, ev.employeeId))

      if (!emp?.email) return reply.status(400).send({ message: 'Pas d\'email pour cet employé' })

      const typeLabel = {
        annual: 'Entretien annuel d\'évaluation',
        professional: 'Entretien professionnel (art. L6315-1)',
        six_year_review: 'Bilan 6 ans (art. L6315-1)',
        mid_year: 'Point mi-parcours',
        trial_period: 'Entretien fin de période d\'essai',
        '360': 'Évaluation 360°',
      }[ev.type] ?? 'Entretien'

      const scheduledStr = ev.scheduledAt
        ? new Date(ev.scheduledAt).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Date à confirmer'

      const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-attributes><mj-all font-family="Arial, sans-serif" /></mj-attributes>
  </mj-head>
  <mj-body background-color="#f0f4f8">
    <mj-section background-color="#4F46E5" padding="24px 40px">
      <mj-column>
        <mj-text color="white" font-size="20px" font-weight="bold" align="center">NexusRH</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="white" padding="40px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold" color="#1e293b">📅 ${typeLabel}</mj-text>
        <mj-text font-size="14px" color="#475569">
          Bonjour <strong>${emp.firstName} ${emp.lastName}</strong>,
        </mj-text>
        <mj-text font-size="14px" color="#475569" line-height="24px">
          Votre <strong>${typeLabel}</strong> pour l'année <strong>${ev.year}</strong> est planifié.
        </mj-text>
        ${ev.type === 'professional' ? `
        <mj-section background-color="#eff6ff" border-radius="8px" padding="16px">
          <mj-column>
            <mj-text font-size="13px" color="#1d4ed8" font-weight="bold">ℹ️ À propos de l'entretien professionnel</mj-text>
            <mj-text font-size="12px" color="#3b82f6" line-height="20px">
              L'entretien professionnel est un droit garanti par l'article L6315-1 du Code du Travail.
              Il porte sur vos perspectives d'évolution professionnelle, vos souhaits de formation et votre employabilité.
              Il est distinct de l'entretien d'évaluation de vos performances.
            </mj-text>
          </mj-column>
        </mj-section>
        ` : ''}
        <mj-table>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;color:#64748b;font-size:13px"><strong>Date</strong></td>
            <td style="padding:8px 12px;font-size:13px">${scheduledStr}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#64748b;font-size:13px"><strong>Type</strong></td>
            <td style="padding:8px 12px;font-size:13px">${typeLabel}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;color:#64748b;font-size:13px"><strong>Année</strong></td>
            <td style="padding:8px 12px;font-size:13px">${ev.year}</td>
          </tr>
        </mj-table>
        <mj-button background-color="#4F46E5" href="${config.app.url}/mon-espace/entretiens" border-radius="8px" font-size="14px">
          Voir mes entretiens →
        </mj-button>
        <mj-text font-size="12px" color="#94a3b8" padding-top="16px">
          Ce message est envoyé automatiquement depuis NexusRH. Ne pas répondre directement à cet email.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`

      await sendEmail({
        to: emp.email,
        subject: `${typeLabel} ${ev.year} — NexusRH`,
        mjml: mjmlTemplate,
      }).catch((err) => logger.error({ err }, 'Erreur envoi invitation entretien'))

      await db.update(evaluations)
        .set({ status: 'invited', invitationSentAt: new Date(), updatedAt: new Date() } as never)
        .where(eq(evaluations.id, id))

      return reply.send({ message: 'Invitation envoyée', to: emp.email })
    },
  })

  // ── Signature employé ─────────────────────────────────────────────────────
  fastify.post('/evaluations/:id/sign-employee', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['careers'],
      summary: 'Signer l\'entretien (employé)',
      body: {
        type: 'object',
        properties: { comments: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { comments } = request.body as { comments?: string }
      const user = request.user as { userId: string; role: string }

      const ev = await db.query.evaluations.findFirst({ where: eq(evaluations.id, id) })
      if (!ev) return reply.status(404).send({ message: 'Entretien introuvable' })

      // Vérifier que c'est bien l'employé concerné (sauf RH/admin)
      if (!['admin', 'hr_manager', 'hr_officer'].includes(user.role)) {
        const [emp] = await db.select({ userId: employees.userId }).from(employees).where(eq(employees.id, ev.employeeId))
        if (emp?.userId !== user.userId) return reply.status(403).send({ message: 'Non autorisé' })
      }

      const [updated] = await db
        .update(evaluations)
        .set({
          signedByEmployee: true,
          employeeSignedAt: new Date(),
          ...(comments ? { employeeComments: comments } : {}),
          status: ev.signedByManager ? 'completed' : 'awaiting_employee_sign',
          updatedAt: new Date(),
        } as never)
        .where(eq(evaluations.id, id))
        .returning()

      return reply.send({ data: updated })
    },
  })

  // ── Signature manager/RH ──────────────────────────────────────────────────
  fastify.post('/evaluations/:id/sign-manager', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Signer l\'entretien (manager/RH)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }

      const ev = await db.query.evaluations.findFirst({ where: eq(evaluations.id, id) })
      if (!ev) return reply.status(404).send({ message: 'Entretien introuvable' })

      const [updated] = await db
        .update(evaluations)
        .set({
          signedByManager: true,
          managerSignedAt: new Date(),
          status: ev.signedByEmployee ? 'completed' : 'awaiting_employee_sign',
          ...(ev.signedByEmployee ? { completedAt: new Date() } : {}),
          updatedAt: new Date(),
        } as never)
        .where(eq(evaluations.id, id))
        .returning()

      return reply.send({ data: updated })
    },
  })

  // ── CONFORMITÉ LÉGALE ─────────────────────────────────────────────────────
  /**
   * Retourne les alertes de conformité :
   * - Employés sans entretien professionnel depuis > 2 ans (art. L6315-1)
   * - Employés proches de l'échéance (dans < 3 mois)
   * - Employés approchant du bilan 6 ans
   * - Employés avec risque d'abondement CPF (critères insuffisants)
   */
  fastify.get('/compliance', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: {
      tags: ['careers'],
      summary: 'Alertes de conformité entretiens professionnels (L6315-1)',
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const today = new Date()
      const twoYearsAgo = new Date(today)
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)
      const twoYearsAgoPlus3Months = new Date(twoYearsAgo)
      twoYearsAgoPlus3Months.setMonth(twoYearsAgoPlus3Months.getMonth() - 3)
      const sixYearsAgo = new Date(today)
      sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 6)

      // Tous les employés actifs
      const allEmployees = await db
        .select({
          id: employees.id,
          firstName: employees.firstName,
          lastName: employees.lastName,
          jobTitle: employees.jobTitle,
          hireDate: employees.hireDate,
          departmentId: employees.departmentId,
        })
        .from(employees)
        .where(eq(employees.status, 'active'))

      // Derniers entretiens professionnels par employé
      const lastProfessionalInterviews = await db
        .select({
          employeeId: evaluations.employeeId,
          lastDate: sql<string>`MAX(${evaluations.completedAt})`.as('last_date'),
          count: sql<number>`COUNT(*)`.as('count'),
        })
        .from(evaluations)
        .where(and(
          eq(evaluations.type, 'professional'),
          eq(evaluations.status, 'completed'),
        ))
        .groupBy(evaluations.employeeId)

      // Bilans 6 ans
      const sixYearReviews = await db
        .select({ employeeId: evaluations.employeeId, cpfAbondement: evaluations.cpfAbondementRequired })
        .from(evaluations)
        .where(and(eq(evaluations.type, 'six_year_review'), eq(evaluations.status, 'completed')))

      const professionalByEmployee = new Map(lastProfessionalInterviews.map((r) => [r.employeeId, r]))
      const sixYearByEmployee = new Map(sixYearReviews.map((r) => [r.employeeId, r]))

      const overdue: typeof allEmployees = []
      const dueSoon: typeof allEmployees = []
      const sixYearDue: typeof allEmployees = []
      const cpfRisk: typeof allEmployees = []

      for (const emp of allEmployees) {
        const lastInterview = professionalByEmployee.get(emp.id)
        const hireDate = emp.hireDate ? new Date(emp.hireDate) : null

        if (!lastInterview) {
          // Jamais eu d'entretien professionnel
          if (hireDate && hireDate <= twoYearsAgo) {
            overdue.push(emp)
          } else if (hireDate && hireDate <= twoYearsAgoPlus3Months) {
            dueSoon.push(emp)
          }
        } else {
          const lastDate = new Date(lastInterview.lastDate)
          if (lastDate <= twoYearsAgo) {
            overdue.push(emp)
          } else if (lastDate <= twoYearsAgoPlus3Months) {
            dueSoon.push(emp)
          }
        }

        // Bilan 6 ans
        if (hireDate && hireDate <= sixYearsAgo) {
          const sixYear = sixYearByEmployee.get(emp.id)
          if (!sixYear) sixYearDue.push(emp)
          else if (sixYear.cpfAbondement) cpfRisk.push(emp)
        }
      }

      return reply.send({
        data: {
          summary: {
            overdue: overdue.length,
            dueSoon: dueSoon.length,
            sixYearDue: sixYearDue.length,
            cpfRisk: cpfRisk.length,
            totalActive: allEmployees.length,
            complianceRate:
              allEmployees.length > 0
                ? Math.round(((allEmployees.length - overdue.length) / allEmployees.length) * 100)
                : 100,
          },
          overdue,
          dueSoon,
          sixYearDue,
          cpfRisk,
        },
      })
    },
  })

  // ── ESPACE EMPLOYÉ — mes entretiens ──────────────────────────────────────
  fastify.get('/my-evaluations', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['careers'], summary: 'Mes entretiens (espace employé)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const user = request.user as { userId: string; employeeId?: string }

      // Retrouver l'employeeId depuis l'userId si non présent dans le token
      let employeeId = user.employeeId
      if (!employeeId) {
        const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.userId, user.userId))
        employeeId = emp?.id
      }
      if (!employeeId) return reply.status(404).send({ message: 'Profil employé introuvable' })

      const list = await db.query.evaluations.findMany({
        where: eq(evaluations.employeeId, employeeId),
        orderBy: [desc(evaluations.year), desc(evaluations.scheduledAt)],
      })

      return reply.send({ data: list })
    },
  })

  fastify.patch('/my-evaluations/:id/comments', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['careers'],
      summary: 'Ajouter mes commentaires sur un entretien',
      body: {
        type: 'object',
        required: ['comments'],
        properties: { comments: { type: 'string', maxLength: 2000 } },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const { comments } = request.body as { comments: string }
      const user = request.user as { userId: string }

      const ev = await db.query.evaluations.findFirst({ where: eq(evaluations.id, id) })
      if (!ev) return reply.status(404).send({ message: 'Entretien introuvable' })

      const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.userId, user.userId))
      if (!emp || emp.id !== ev.employeeId) return reply.status(403).send({ message: 'Non autorisé' })

      const [updated] = await db
        .update(evaluations)
        .set({ employeeComments: comments, updatedAt: new Date() } as never)
        .where(eq(evaluations.id, id))
        .returning()

      return reply.send({ data: updated })
    },
  })

  // ── PLANS DE DÉVELOPPEMENT (PDI) ──────────────────────────────────────────

  fastify.get('/development-plans', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: {
      tags: ['careers'],
      summary: 'Plans de développement individuel',
      querystring: {
        type: 'object',
        properties: { employeeId: { type: 'string' }, year: { type: 'number' } },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId, year } = request.query as { employeeId?: string; year?: number }

      const conditions = []
      if (employeeId) conditions.push(eq(developmentPlans.employeeId, employeeId))
      if (year) conditions.push(eq(developmentPlans.year, year))

      const list = await db
        .select({
          id: developmentPlans.id,
          year: developmentPlans.year,
          title: developmentPlans.title,
          status: developmentPlans.status,
          shortTermGoal: developmentPlans.shortTermGoal,
          updatedAt: developmentPlans.updatedAt,
          employeeId: developmentPlans.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
        })
        .from(developmentPlans)
        .innerJoin(employees, eq(developmentPlans.employeeId, employees.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(developmentPlans.year))

      return reply.send({ data: list })
    },
  })

  fastify.get('/development-plans/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['careers'], summary: 'Détail d\'un PDI' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const plan = await db.query.developmentPlans.findFirst({
        where: eq(developmentPlans.id, id),
      })
      if (!plan) return reply.status(404).send({ message: 'PDI introuvable' })
      return reply.send({ data: plan })
    },
  })

  fastify.post('/development-plans', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Créer un PDI' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const user = request.user as { userId: string }
      const [plan] = await db
        .insert(developmentPlans)
        .values({ ...(request.body as Record<string, unknown>), createdBy: user.userId } as any)
        .returning()
      return reply.status(201).send({ data: plan })
    },
  })

  fastify.patch('/development-plans/:id', {
    preHandler: [fastify.authorize('hr_manager', 'manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Modifier un PDI' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const [updated] = await db
        .update(developmentPlans)
        .set({ ...(request.body as Record<string, unknown>), updatedAt: new Date() })
        .where(eq(developmentPlans.id, id))
        .returning()
      if (!updated) return reply.status(404).send({ message: 'PDI introuvable' })
      return reply.send({ data: updated })
    },
  })

  fastify.get('/my-development-plan', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['careers'], summary: 'Mon PDI (espace employé)' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const user = request.user as { userId: string }
      const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.userId, user.userId))
      if (!emp) return reply.status(404).send({ message: 'Profil introuvable' })

      const plan = await db.query.developmentPlans.findFirst({
        where: and(eq(developmentPlans.employeeId, emp.id), eq(developmentPlans.status, 'active')),
        orderBy: [desc(developmentPlans.year)],
      })
      return reply.send({ data: plan ?? null })
    },
  })

  // ── PLANS DE CARRIÈRE ─────────────────────────────────────────────────────

  fastify.get('/career-paths', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: {
      tags: ['careers'],
      summary: 'Plans de carrière',
      querystring: {
        type: 'object',
        properties: { employeeId: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.query as { employeeId?: string }

      const list = await db
        .select({
          id: careerPaths.id,
          currentPosition: careerPaths.currentPosition,
          targetPosition: careerPaths.targetPosition,
          mobilityType: careerPaths.mobilityType,
          readinessLevel: careerPaths.readinessLevel,
          targetDate: careerPaths.targetDate,
          status: careerPaths.status,
          employeeId: careerPaths.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          employeeJobTitle: employees.jobTitle,
        })
        .from(careerPaths)
        .innerJoin(employees, eq(careerPaths.employeeId, employees.id))
        .where(employeeId ? eq(careerPaths.employeeId, employeeId) : undefined)
        .orderBy(desc(careerPaths.updatedAt))

      return reply.send({ data: list })
    },
  })

  fastify.post('/career-paths', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Créer un plan de carrière' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const [path] = await db.insert(careerPaths).values(request.body as any).returning()
      return reply.status(201).send({ data: path })
    },
  })

  fastify.patch('/career-paths/:id', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Modifier un plan de carrière' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const [updated] = await db
        .update(careerPaths)
        .set({ ...(request.body as Record<string, unknown>), updatedAt: new Date() })
        .where(eq(careerPaths.id, id))
        .returning()
      if (!updated) return reply.status(404).send({ message: 'Plan de carrière introuvable' })
      return reply.send({ data: updated })
    },
  })

  // ── MATRICE 9-BOX ─────────────────────────────────────────────────────────

  fastify.get('/nine-box', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: {
      tags: ['careers'],
      summary: 'Matrice 9-box',
      querystring: {
        type: 'object',
        properties: { year: { type: 'number' } },
      },
    },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { year } = request.query as { year?: number }

      const matrix = await db
        .select({
          id: nineBox.id,
          year: nineBox.year,
          box: nineBox.box,
          performanceAxis: nineBox.performanceAxis,
          potentialAxis: nineBox.potentialAxis,
          notes: nineBox.notes,
          employeeId: nineBox.employeeId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          employeeJobTitle: employees.jobTitle,
          employeePhoto: employees.photoUrl,
        })
        .from(nineBox)
        .innerJoin(employees, eq(nineBox.employeeId, employees.id))
        .where(year ? eq(nineBox.year, year) : undefined)
        .orderBy(asc(nineBox.box))

      return reply.send({ data: matrix })
    },
  })

  fastify.post('/nine-box', {
    preHandler: [fastify.authorize('hr_manager', 'admin')],
    schema: { tags: ['careers'], summary: 'Positionner un employé dans la 9-box' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const user = request.user as { userId: string }
      const body = request.body as { employeeId: string; year: number; performanceAxis: number; potentialAxis: number; notes?: string }
      const box = (body.potentialAxis - 1) * 3 + body.performanceAxis

      const [entry] = await db
        .insert(nineBox)
        .values({ ...body, box, createdBy: user.userId })
        .onConflictDoUpdate({
          target: [nineBox.employeeId, nineBox.year],
          set: { performanceAxis: body.performanceAxis, potentialAxis: body.potentialAxis, box, notes: body.notes ?? null },
        })
        .returning()

      return reply.status(201).send({ data: entry })
    },
  })
}

export default careersRoutes
