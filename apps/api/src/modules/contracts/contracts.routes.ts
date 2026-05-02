import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { getTenantDbForRequest } from '../../plugins/tenant'
import { contracts } from '../../db/schema/payroll'

const contractsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /contracts?employeeId=
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['contracts'], summary: 'Liste des contrats' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { employeeId } = request.query as { employeeId?: string }
      const list = await db.query.contracts.findMany({
        where: employeeId ? eq(contracts.employeeId, employeeId) : undefined,
        orderBy: [contracts.createdAt],
      })
      return reply.send({ data: list })
    },
  })

  // GET /contracts/:id
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['contracts'], summary: 'Détail d\'un contrat' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const contract = await db.query.contracts.findFirst({
        where: eq(contracts.id, id),
      })
      if (!contract) return reply.status(404).send({ error: 'Contrat introuvable' })
      return reply.send({ data: contract })
    },
  })

  // POST /contracts
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['contracts'], summary: 'Créer un contrat' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        employeeId: string
        type: string
        startDate: string
        endDate?: string
        trialPeriodEnd?: string
        grossSalary: number | string
        salaryBasis?: string
        workingHoursPerWeek?: number | string
        collectiveAgreement?: string
        jobClassification?: string
        nonCompetitionClause?: boolean
        telecommutingDays?: number
      }

      if (!body.employeeId) {
        return reply.status(422).send({ error: 'employeeId est requis' })
      }
      if (!body.type) {
        return reply.status(422).send({ error: 'Le type de contrat est requis' })
      }
      if (!body.startDate) {
        return reply.status(422).send({ error: 'La date de début est requise' })
      }
      if (!body.grossSalary) {
        return reply.status(422).send({ error: 'Le salaire brut est requis' })
      }

      const [contract] = await db
        .insert(contracts)
        .values({
          employeeId: body.employeeId,
          type: body.type,
          startDate: body.startDate,
          endDate: body.endDate ?? null,
          trialPeriodEnd: body.trialPeriodEnd ?? null,
          grossSalary: String(body.grossSalary),
          salaryBasis: body.salaryBasis ?? 'monthly',
          workingHoursPerWeek: String(body.workingHoursPerWeek ?? 35),
          collectiveAgreement: body.collectiveAgreement ?? null,
          jobClassification: body.jobClassification ?? null,
          nonCompetitionClause: body.nonCompetitionClause ?? false,
          telecommutingDays: body.telecommutingDays ?? 0,
          status: 'active',
        } as never)
        .returning()

      return reply.status(201).send({ data: contract })
    },
  })

  // ── POST /contracts/:id/send-for-signature — YouSign ─────────────────────
  fastify.post('/:id/send-for-signature', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    schema: { tags: ['contracts'], summary: 'Envoyer un contrat pour signature électronique' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db = getTenantDbForRequest(request)
      const body = request.body as {
        signerEmail?: string
        signerFirstName?: string
        signerLastName?: string
        message?: string
        documentBase64?: string
      }

      try {
        const contract = await db.query.contracts.findFirst({ where: eq(contracts.id, id) })
        if (!contract) return reply.status(404).send({ error: 'Contrat introuvable' })
        if (contract.signatureStatus === 'signed') {
          return reply.status(409).send({ error: 'Contrat déjà signé' })
        }

        const {
          createSignatureRequest,
          isYouSignConfigured,
          mockSignatureRequest,
        } = await import('../../services/yousign.service')

        const signerEmail = body.signerEmail ?? 'employe@example.com'
        const signerFirstName = body.signerFirstName ?? 'Employé'
        const signerLastName = body.signerLastName ?? ''
        const documentName = `Contrat_${contract.type}_${id.slice(0, 8)}.pdf`
        const webhookUrl = `${process.env['API_URL'] ?? 'http://localhost:4000'}/contracts/${id}/signature-webhook`

        let result
        if (isYouSignConfigured() && body.documentBase64) {
          result = await createSignatureRequest({
            documentName,
            documentBase64: body.documentBase64,
            signers: [{ email: signerEmail, firstName: signerFirstName, lastName: signerLastName }],
            message: body.message,
            webhookCallbackUrl: webhookUrl,
          })
        } else {
          result = mockSignatureRequest(id)
        }

        await db.update(contracts).set({
          signatureRequestId: result.signatureRequestId,
          signatureStatus: 'pending',
          updatedAt: new Date(),
        } as never).where(eq(contracts.id, id))

        return reply.send({
          data: {
            signatureRequestId: result.signatureRequestId,
            signingLink: result.signingLink,
            status: result.status,
            expiresAt: result.expiresAt,
            mock: !isYouSignConfigured(),
          },
          message: isYouSignConfigured()
            ? `Demande de signature envoyée à ${signerEmail}`
            : 'Mode démonstration — configurez YOUSIGN_API_KEY pour activer la vraie signature',
        })
      } catch (err) {
        fastify.log.error({ err }, 'send-for-signature error')
        const msg = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: `Erreur signature : ${msg}` })
      }
    },
  })

  // ── GET /contracts/:id/signature-status ───────────────────────────────────
  fastify.get('/:id/signature-status', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['contracts'], summary: 'Statut de la signature électronique' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const db = getTenantDbForRequest(request)

      const contract = await db.query.contracts.findFirst({ where: eq(contracts.id, id) })
      if (!contract) return reply.status(404).send({ error: 'Contrat introuvable' })

      if (!contract.signatureRequestId) {
        return reply.send({ data: { status: 'not_sent', signers: [] } })
      }

      try {
        const { getSignatureStatus, isYouSignConfigured } = await import('../../services/yousign.service')
        if (!isYouSignConfigured()) {
          return reply.send({ data: { status: contract.signatureStatus ?? 'pending', signers: [], mock: true } })
        }
        const status = await getSignatureStatus(contract.signatureRequestId)

        if (status.status === 'done') {
          await db.update(contracts).set({
            signatureStatus: 'signed',
            signedAt: new Date(),
            updatedAt: new Date(),
          } as never).where(eq(contracts.id, id))
        }

        return reply.send({ data: status })
      } catch (err) {
        fastify.log.error({ err }, 'signature-status error')
        return reply.status(500).send({ error: 'Erreur récupération statut signature' })
      }
    },
  })

  // ── POST /contracts/:id/signature-webhook — callback YouSign ─────────────
  fastify.post('/:id/signature-webhook', {
    schema: { tags: ['contracts'], summary: 'Webhook YouSign (callback interne)' },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as { event_name?: string; data?: { status?: string } }
      const signature = (request.headers['x-yousign-signature-256'] as string) ?? ''

      try {
        const { verifyYouSignWebhook } = await import('../../services/yousign.service')
        const rawBody = JSON.stringify(request.body)
        if (!verifyYouSignWebhook(rawBody, signature)) {
          return reply.status(401).send({ error: 'Signature webhook invalide' })
        }

        const db = getTenantDbForRequest(request)

        if (body.event_name === 'signature_request.done') {
          await db.update(contracts).set({
            signatureStatus: 'signed',
            signedAt: new Date(),
            updatedAt: new Date(),
          } as never).where(eq(contracts.id, id))
        } else if (body.event_name === 'signature_request.declined') {
          await db.update(contracts).set({
            signatureStatus: 'declined',
            updatedAt: new Date(),
          } as never).where(eq(contracts.id, id))
        }

        return reply.send({ received: true })
      } catch (err) {
        fastify.log.error({ err }, 'signature-webhook error')
        return reply.status(500).send({ error: 'Erreur traitement webhook' })
      }
    },
  })

  // PATCH /contracts/:id
  fastify.patch('/:id', {
    preHandler: [fastify.authorize('hr_manager', 'hr_officer', 'admin', 'super_admin')],
    schema: { tags: ['contracts'], summary: 'Modifier un contrat' },
    handler: async (request, reply) => {
      const db = getTenantDbForRequest(request)
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      const allowed = [
        'type', 'startDate', 'endDate', 'trialPeriodEnd', 'grossSalary',
        'salaryBasis', 'workingHoursPerWeek', 'collectiveAgreement',
        'jobClassification', 'nonCompetitionClause', 'telecommutingDays', 'status',
      ]
      const set: Record<string, unknown> = { updatedAt: new Date() }
      for (const key of allowed) {
        if (body[key] !== undefined) set[key] = body[key]
      }

      const [updated] = await db
        .update(contracts)
        .set(set as never)
        .where(eq(contracts.id, id))
        .returning()

      if (!updated) return reply.status(404).send({ error: 'Contrat introuvable' })
      return reply.send({ data: updated })
    },
  })
}

export default contractsRoutes
