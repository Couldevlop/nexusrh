import type { FastifyPluginAsync } from 'fastify'
import { eq, and, desc, asc, sql, gte, lte, inArray, isNull, count, sum } from 'drizzle-orm'
import PDFDocument from 'pdfkit'
import { Pool } from 'pg'
import nodemailer from 'nodemailer'
import { getTenantDbForRequest } from '../../plugins/tenant'
import {
  getOrCreatePayPeriod,
  calculatePaySlip,
  generatePaySlipPdfAndUpload,
  getPayrollRules,
} from './payroll.service'
import {
  paySlips,
  payPeriods,
  payrollRules,
  variableElements,
} from '../../db/schema/payroll'
import { employees, departments, legalEntities } from '../../db/schema/employees'
import { config } from '../../config'

// ─── helpers ─────────────────────────────────────────────────────────────────

const PAYROLL_ROLES = ['admin', 'hr_manager', 'payroll_service'] as const
type PayrollRole = typeof PAYROLL_ROLES[number]

function maskIban(iban: string | null | undefined): string {
  if (!iban) return '—'
  const clean = iban.replace(/\s/g, '')
  if (clean.length < 8) return iban
  return clean.slice(0, 4) + ' **** **** **** ' + clean.slice(-4)
}

// ─── SEPA pain.001.001.03 ────────────────────────────────────────────────────

function buildSepaXml(params: {
  messageId: string
  creationDateTime: string
  totalAmount: number
  nbTransactions: number
  debtorName: string
  debtorIban: string
  debtorBic: string
  paymentInfoId: string
  requestedExecutionDate: string
  transactions: Array<{
    endToEndId: string
    amount: number
    creditorName: string
    creditorIban: string
    creditorBic: string
    remittanceInfo: string
  }>
}): string {
  const txLines = params.transactions
    .map(
      (tx) => `
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${tx.endToEndId}</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">${tx.amount.toFixed(2)}</InstdAmt>
        </Amt>
        <CdtrAgt>
          <FinInstnId>
            <BIC>${tx.creditorBic || 'NOTPROVIDED'}</BIC>
          </FinInstnId>
        </CdtrAgt>
        <Cdtr>
          <Nm>${escapeXml(tx.creditorName)}</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>${tx.creditorIban.replace(/\s/g, '')}</IBAN>
          </Id>
        </CdtrAcct>
        <RmtInf>
          <Ustrd>${escapeXml(tx.remittanceInfo)}</Ustrd>
        </RmtInf>
      </CdtTrfTxInf>`
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${params.messageId}</MsgId>
      <CreDtTm>${params.creationDateTime}</CreDtTm>
      <NbOfTxs>${params.nbTransactions}</NbOfTxs>
      <CtrlSum>${params.totalAmount.toFixed(2)}</CtrlSum>
      <InitgPty>
        <Nm>${escapeXml(params.debtorName)}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${params.paymentInfoId}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${params.nbTransactions}</NbOfTxs>
      <CtrlSum>${params.totalAmount.toFixed(2)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
      </PmtTpInf>
      <ReqdExctnDt>${params.requestedExecutionDate}</ReqdExctnDt>
      <Dbtr>
        <Nm>${escapeXml(params.debtorName)}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${params.debtorIban.replace(/\s/g, '')}</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BIC>${params.debtorBic || 'NOTPROVIDED'}</BIC>
        </FinInstnId>
      </DbtrAgt>
      ${txLines}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ─── routes ──────────────────────────────────────────────────────────────────

const payrollRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /payroll/legal-entities ──────────────────────────────────────────
  fastify.get('/legal-entities', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Entités juridiques du tenant' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const entities = await db
          .select({ id: legalEntities.id, name: legalEntities.name, siret: legalEntities.siret })
          .from(legalEntities)
          .orderBy(legalEntities.name)
        return reply.send({ data: entities })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/rules ───────────────────────────────────────────────────
  fastify.get('/rules', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Rubriques de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { entityId } = request.query as { entityId?: string }
        const rules = await getPayrollRules(entityId ?? '', db)
        return reply.send({ data: rules })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/rules ──────────────────────────────────────────────────
  fastify.post('/rules', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Créer une rubrique de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const body = request.body as {
          entityId: string
          code: string
          label: string
          type: string
          formula: string
          base?: string
          employeeRate?: number
          employerRate?: number
          ceilingSS?: number
          isActive?: boolean
          order?: number
          validFrom?: string
          validUntil?: string
          legalReference?: string
          appliesTo?: Record<string, unknown>
        }

        const [rule] = await db
          .insert(payrollRules)
          .values({
            entityId: body.entityId,
            code: body.code,
            label: body.label,
            type: body.type,
            formula: body.formula,
            base: body.base,
            employeeRate: body.employeeRate?.toString(),
            employerRate: body.employerRate?.toString(),
            ceilingSS: body.ceilingSS?.toString(),
            isActive: body.isActive ?? true,
            order: body.order ?? 0,
            validFrom: body.validFrom,
            validUntil: body.validUntil,
            legalReference: body.legalReference,
            appliesTo: (body.appliesTo as never) ?? {},
          })
          .returning()

        return reply.status(201).send({ data: rule })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PUT /payroll/rules/:id ───────────────────────────────────────────────
  fastify.put('/rules/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Modifier une rubrique de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        const body = request.body as {
          label?: string
          type?: string
          formula?: string
          base?: string
          employeeRate?: number
          employerRate?: number
          ceilingSS?: number
          isActive?: boolean
          order?: number
          validFrom?: string
          validUntil?: string
          legalReference?: string
          appliesTo?: Record<string, unknown>
        }

        const updateData: Record<string, unknown> = {}
        if (body.label !== undefined) updateData['label'] = body.label
        if (body.type !== undefined) updateData['type'] = body.type
        if (body.formula !== undefined) updateData['formula'] = body.formula
        if (body.base !== undefined) updateData['base'] = body.base
        if (body.employeeRate !== undefined) updateData['employeeRate'] = body.employeeRate.toString()
        if (body.employerRate !== undefined) updateData['employerRate'] = body.employerRate.toString()
        if (body.ceilingSS !== undefined) updateData['ceilingSS'] = body.ceilingSS.toString()
        if (body.isActive !== undefined) updateData['isActive'] = body.isActive
        if (body.order !== undefined) updateData['order'] = body.order
        if (body.validFrom !== undefined) updateData['validFrom'] = body.validFrom
        if (body.validUntil !== undefined) updateData['validUntil'] = body.validUntil
        if (body.legalReference !== undefined) updateData['legalReference'] = body.legalReference
        if (body.appliesTo !== undefined) updateData['appliesTo'] = body.appliesTo
        updateData['updatedAt'] = new Date()

        const [updated] = await db
          .update(payrollRules)
          .set(updateData as never)
          .where(eq(payrollRules.id, id))
          .returning()

        if (!updated) {
          return reply.status(404).send({ error: 'Rubrique introuvable' })
        }
        return reply.send({ data: updated })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── DELETE /payroll/rules/:id ────────────────────────────────────────────
  fastify.delete('/rules/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Supprimer une rubrique de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }

        await db.delete(payrollRules).where(eq(payrollRules.id, id))
        return reply.send({ ok: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/periods ────────────────────────────────────────────────
  fastify.post('/periods', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin', 'payroll_service')],
    schema: { tags: ['payroll'], summary: 'Créer/obtenir une période de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { entityId, year, month } = request.body as {
          entityId: string
          year: number
          month: number
        }
        const period = await getOrCreatePayPeriod(entityId, year, month, db)
        return reply.status(201).send({ data: period })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/periods ─────────────────────────────────────────────────
  fastify.get('/periods', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Liste des périodes de paie avec totaux' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)

        const periods = await db
          .select({
            id: payPeriods.id,
            entityId: payPeriods.entityId,
            year: payPeriods.year,
            month: payPeriods.month,
            status: payPeriods.status,
            openedAt: payPeriods.openedAt,
            validatedAt: payPeriods.validatedAt,
            closedAt: payPeriods.closedAt,
            totalGross: payPeriods.totalGross,
            totalNet: payPeriods.totalNet,
            totalEmployerCost: payPeriods.totalEmployerCost,
            paymentDate: payPeriods.paymentDate,
            slipCount: count(paySlips.id),
            entityName: legalEntities.name,
          })
          .from(payPeriods)
          .leftJoin(paySlips, eq(paySlips.periodId, payPeriods.id))
          .leftJoin(legalEntities, eq(legalEntities.id, payPeriods.entityId))
          .groupBy(
            payPeriods.id,
            payPeriods.entityId,
            payPeriods.year,
            payPeriods.month,
            payPeriods.status,
            payPeriods.openedAt,
            payPeriods.validatedAt,
            payPeriods.closedAt,
            payPeriods.totalGross,
            payPeriods.totalNet,
            payPeriods.totalEmployerCost,
            payPeriods.paymentDate,
            legalEntities.name,
          )
          .orderBy(desc(payPeriods.year), desc(payPeriods.month))

        return reply.send({ data: periods })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/periods/:id ─────────────────────────────────────────────
  fastify.get('/periods/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Détail d\'une période de paie avec bulletins' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }

        const [period] = await db
          .select({
            id: payPeriods.id,
            entityId: payPeriods.entityId,
            year: payPeriods.year,
            month: payPeriods.month,
            status: payPeriods.status,
            totalGross: payPeriods.totalGross,
            totalNet: payPeriods.totalNet,
            totalEmployerCost: payPeriods.totalEmployerCost,
            paymentDate: payPeriods.paymentDate,
            openedAt: payPeriods.openedAt,
            closedAt: payPeriods.closedAt,
            entityName: legalEntities.name,
          })
          .from(payPeriods)
          .leftJoin(legalEntities, eq(legalEntities.id, payPeriods.entityId))
          .where(eq(payPeriods.id, id))
          .limit(1)

        if (!period) {
          return reply.status(404).send({ error: 'Période introuvable' })
        }

        const slips = await db
          .select({
            id: paySlips.id,
            employeeId: paySlips.employeeId,
            year: paySlips.year,
            month: paySlips.month,
            grossSalary: paySlips.grossSalary,
            netPayable: paySlips.netPayable,
            employerCost: paySlips.employerCost,
            status: paySlips.status,
            generatedAt: paySlips.generatedAt,
            sentAt: paySlips.sentAt,
            viewedByEmployeeAt: paySlips.viewedByEmployeeAt,
            pdfUrl: paySlips.pdfUrl,
            employeeFirstName: employees.firstName,
            employeeLastName: employees.lastName,
            jobTitle: employees.jobTitle,
            deptId: employees.departmentId,
          })
          .from(paySlips)
          .leftJoin(employees, eq(employees.id, paySlips.employeeId))
          .where(eq(paySlips.periodId, id))
          .orderBy(asc(employees.lastName))

        return reply.send({ data: { period, slips } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/periods/:id/calculate-all ──────────────────────────────
  fastify.post('/periods/:id/calculate-all', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Calculer tous les bulletins d\'une période' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id: periodId } = request.params as { id: string }

        const [period] = await db
          .select()
          .from(payPeriods)
          .where(eq(payPeriods.id, periodId))
          .limit(1)

        if (!period) {
          return reply.status(404).send({ error: 'Période introuvable' })
        }

        // Mise à jour statut → calculating
        await db
          .update(payPeriods)
          .set({ status: 'calculating' })
          .where(eq(payPeriods.id, periodId))

        // Trouver tous les employés actifs de l'entité
        const activeEmployees = await db
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.entityId, period.entityId),
              eq(employees.status, 'active'),
              isNull(employees.deletedAt),
            )
          )

        const results: Array<{ employeeId: string; status: 'ok' | 'error'; message?: string }> = []

        for (const emp of activeEmployees) {
          try {
            await calculatePaySlip(emp.id, periodId, db)
            results.push({ employeeId: emp.id, status: 'ok' })
          } catch (calcErr) {
            const msg = calcErr instanceof Error ? calcErr.message : 'Erreur inconnue'
            results.push({ employeeId: emp.id, status: 'error', message: msg })
          }
        }

        // Recalculer les totaux de la période
        const [totals] = await db
          .select({
            totalGross: sum(paySlips.grossSalary),
            totalNet: sum(paySlips.netPayable),
            totalEmployerCost: sum(paySlips.employerCost),
          })
          .from(paySlips)
          .where(eq(paySlips.periodId, periodId))

        await db
          .update(payPeriods)
          .set({
            status: 'review',
            totalGross: totals?.totalGross ?? '0',
            totalNet: totals?.totalNet ?? '0',
            totalEmployerCost: totals?.totalEmployerCost ?? '0',
          })
          .where(eq(payPeriods.id, periodId))

        const ok = results.filter((r) => r.status === 'ok').length
        const errors = results.filter((r) => r.status === 'error').length

        return reply.send({
          data: {
            total: results.length,
            ok,
            errors,
            details: results,
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PATCH /payroll/periods/:id ───────────────────────────────────────────
  fastify.patch('/periods/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Modifier le statut ou la date de paiement d\'une période' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        const body = request.body as {
          status?: string
          paymentDate?: string
        }

        const updateData: Record<string, unknown> = {}
        if (body.status !== undefined) {
          updateData['status'] = body.status
          if (body.status === 'validated') updateData['validatedAt'] = new Date()
          if (body.status === 'closed') updateData['closedAt'] = new Date()
        }
        if (body.paymentDate !== undefined) updateData['paymentDate'] = body.paymentDate

        const [updated] = await db
          .update(payPeriods)
          .set(updateData as never)
          .where(eq(payPeriods.id, id))
          .returning()

        if (!updated) {
          return reply.status(404).send({ error: 'Période introuvable' })
        }
        return reply.send({ data: updated })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/calculate ──────────────────────────────────────────────
  fastify.post('/calculate', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin', 'payroll_service')],
    schema: { tags: ['payroll'], summary: 'Calculer un bulletin de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { employeeId, periodId } = request.body as {
          employeeId: string
          periodId: string
        }
        const result = await calculatePaySlip(employeeId, periodId, db)
        return reply.send({ data: result })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/payslips ────────────────────────────────────────────────
  fastify.get('/payslips', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Liste paginée des bulletins de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const query = request.query as {
          periodId?: string
          status?: string
          departmentId?: string
          search?: string
          page?: string
          limit?: string
        }

        const page = Math.max(1, Number(query.page ?? 1))
        const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)))
        const offset = (page - 1) * limit

        const conditions: ReturnType<typeof eq>[] = []
        if (query.periodId) conditions.push(eq(paySlips.periodId, query.periodId))
        if (query.status) conditions.push(eq(paySlips.status, query.status))
        if (query.departmentId) conditions.push(eq(employees.departmentId, query.departmentId))

        const baseQuery = db
          .select({
            id: paySlips.id,
            employeeId: paySlips.employeeId,
            periodId: paySlips.periodId,
            year: paySlips.year,
            month: paySlips.month,
            grossSalary: paySlips.grossSalary,
            netPayable: paySlips.netPayable,
            employerCost: paySlips.employerCost,
            status: paySlips.status,
            generatedAt: paySlips.generatedAt,
            sentAt: paySlips.sentAt,
            viewedByEmployeeAt: paySlips.viewedByEmployeeAt,
            pdfUrl: paySlips.pdfUrl,
            employeeFirstName: employees.firstName,
            employeeLastName: employees.lastName,
            jobTitle: employees.jobTitle,
            departmentId: employees.departmentId,
            departmentName: departments.name,
          })
          .from(paySlips)
          .leftJoin(employees, eq(employees.id, paySlips.employeeId))
          .leftJoin(departments, eq(departments.id, employees.departmentId))

        const rows = conditions.length > 0
          ? await baseQuery
              .where(and(...conditions))
              .orderBy(desc(paySlips.year), desc(paySlips.month), asc(employees.lastName))
              .limit(limit)
              .offset(offset)
          : await baseQuery
              .orderBy(desc(paySlips.year), desc(paySlips.month), asc(employees.lastName))
              .limit(limit)
              .offset(offset)

        const filtered = query.search
          ? rows.filter((r) => {
              const name = `${r.employeeFirstName ?? ''} ${r.employeeLastName ?? ''}`.toLowerCase()
              return name.includes(query.search!.toLowerCase())
            })
          : rows

        return reply.send({ data: filtered, page, limit })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PATCH /payroll/payslips/:id ──────────────────────────────────────────
  fastify.patch('/payslips/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Mettre à jour le statut d\'un bulletin' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        const body = request.body as { status: string }

        const updateData: Record<string, unknown> = { status: body.status }
        if (body.status === 'sent') updateData['sentAt'] = new Date()

        const [updated] = await db
          .update(paySlips)
          .set(updateData as never)
          .where(eq(paySlips.id, id))
          .returning()

        if (!updated) {
          return reply.status(404).send({ error: 'Bulletin introuvable' })
        }
        return reply.send({ data: updated })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/payslips/bulk-generate ─────────────────────────────────
  fastify.post('/payslips/bulk-generate', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Générer les PDFs de tous les bulletins d\'une période' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { periodId } = request.body as { periodId: string }

        const slips = await db
          .select({ id: paySlips.id })
          .from(paySlips)
          .where(eq(paySlips.periodId, periodId))

        const results: Array<{ id: string; status: 'ok' | 'error'; message?: string }> = []

        for (const slip of slips) {
          try {
            await generatePaySlipPdfAndUpload(slip.id, db)
            results.push({ id: slip.id, status: 'ok' })
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Erreur inconnue'
            results.push({ id: slip.id, status: 'error', message: msg })
          }
        }

        return reply.send({
          data: {
            total: results.length,
            ok: results.filter((r) => r.status === 'ok').length,
            errors: results.filter((r) => r.status === 'error').length,
            details: results,
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/payslips/:id/pdf ───────────────────────────────────────
  fastify.post('/payslips/:id/pdf', {
    preHandler: [fastify.authorize('hr_manager', 'admin', 'super_admin', 'payroll_service')],
    schema: {
      tags: ['payroll'],
      summary: 'Générer le PDF d\'un bulletin',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
        required: ['id'],
      },
    },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        const result = await generatePaySlipPdfAndUpload(id, db)
        return reply.send({ data: { pdfUrl: result.pdfUrl } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/payslips/employee/:employeeId ───────────────────────────
  fastify.get('/payslips/employee/:employeeId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['payroll'],
      summary: 'Bulletins de paie d\'un collaborateur',
      params: {
        type: 'object',
        properties: { employeeId: { type: 'string', format: 'uuid' } },
        required: ['employeeId'],
      },
    },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { employeeId } = request.params as { employeeId: string }
        const slips = await db.query.paySlips.findMany({
          where: eq(paySlips.employeeId, employeeId),
          orderBy: [paySlips.createdAt],
        })
        return reply.send({ data: slips })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/variable-elements ──────────────────────────────────────
  fastify.get('/variable-elements', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Éléments variables d\'une période' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { periodId } = request.query as { periodId?: string }

        const conditions = periodId
          ? [eq(variableElements.periodId, periodId)]
          : []

        const rows = conditions.length > 0
          ? await db
              .select({
                id: variableElements.id,
                employeeId: variableElements.employeeId,
                periodId: variableElements.periodId,
                ruleCode: variableElements.ruleCode,
                label: variableElements.label,
                amount: variableElements.amount,
                quantity: variableElements.quantity,
                rate: variableElements.rate,
                note: variableElements.note,
                source: variableElements.source,
                createdAt: variableElements.createdAt,
                employeeFirstName: employees.firstName,
                employeeLastName: employees.lastName,
              })
              .from(variableElements)
              .leftJoin(employees, eq(employees.id, variableElements.employeeId))
              .where(and(...conditions))
              .orderBy(asc(employees.lastName))
          : await db
              .select({
                id: variableElements.id,
                employeeId: variableElements.employeeId,
                periodId: variableElements.periodId,
                ruleCode: variableElements.ruleCode,
                label: variableElements.label,
                amount: variableElements.amount,
                quantity: variableElements.quantity,
                rate: variableElements.rate,
                note: variableElements.note,
                source: variableElements.source,
                createdAt: variableElements.createdAt,
                employeeFirstName: employees.firstName,
                employeeLastName: employees.lastName,
              })
              .from(variableElements)
              .leftJoin(employees, eq(employees.id, variableElements.employeeId))
              .orderBy(asc(employees.lastName))

        return reply.send({ data: rows })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── POST /payroll/variable-elements ─────────────────────────────────────
  fastify.post('/variable-elements', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Créer un élément variable' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const body = request.body as {
          employeeId: string
          periodId: string
          ruleCode: string
          label?: string
          amount?: number
          quantity?: number
          rate?: number
          note?: string
        }

        const [ve] = await db
          .insert(variableElements)
          .values({
            employeeId: body.employeeId,
            periodId: body.periodId,
            ruleCode: body.ruleCode,
            label: body.label,
            amount: body.amount?.toString(),
            quantity: body.quantity?.toString(),
            rate: body.rate?.toString(),
            note: body.note,
            source: 'manual',
            createdBy: request.user.sub,
          })
          .returning()

        return reply.status(201).send({ data: ve })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PUT /payroll/variable-elements/:id ──────────────────────────────────
  fastify.put('/variable-elements/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Modifier un élément variable' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        const body = request.body as {
          label?: string
          amount?: number
          quantity?: number
          rate?: number
          note?: string
        }

        const updateData: Record<string, unknown> = {}
        if (body.label !== undefined) updateData['label'] = body.label
        if (body.amount !== undefined) updateData['amount'] = body.amount.toString()
        if (body.quantity !== undefined) updateData['quantity'] = body.quantity.toString()
        if (body.rate !== undefined) updateData['rate'] = body.rate.toString()
        if (body.note !== undefined) updateData['note'] = body.note

        const [updated] = await db
          .update(variableElements)
          .set(updateData as never)
          .where(eq(variableElements.id, id))
          .returning()

        if (!updated) {
          return reply.status(404).send({ error: 'Élément variable introuvable' })
        }
        return reply.send({ data: updated })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── DELETE /payroll/variable-elements/:id ───────────────────────────────
  fastify.delete('/variable-elements/:id', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Supprimer un élément variable' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        await db.delete(variableElements).where(eq(variableElements.id, id))
        return reply.send({ ok: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/dashboard ───────────────────────────────────────────────
  fastify.get('/dashboard', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'KPIs paie et évolution 6 mois' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)

        // Dernière période non clôturée ou la plus récente
        const [latestPeriod] = await db
          .select()
          .from(payPeriods)
          .orderBy(desc(payPeriods.year), desc(payPeriods.month))
          .limit(1)

        // KPIs de la période courante
        let currentKpis = {
          totalGross: 0,
          totalNet: 0,
          totalEmployerCost: 0,
          bulletinCount: 0,
        }

        if (latestPeriod) {
          const [kpis] = await db
            .select({
              totalGross: sum(paySlips.grossSalary),
              totalNet: sum(paySlips.netPayable),
              totalEmployerCost: sum(paySlips.employerCost),
              bulletinCount: count(paySlips.id),
            })
            .from(paySlips)
            .where(eq(paySlips.periodId, latestPeriod.id))

          currentKpis = {
            totalGross: Number(kpis?.totalGross ?? 0),
            totalNet: Number(kpis?.totalNet ?? 0),
            totalEmployerCost: Number(kpis?.totalEmployerCost ?? 0),
            bulletinCount: Number(kpis?.bulletinCount ?? 0),
          }
        }

        // Évolution 6 derniers mois
        const sixMonthsAgo = new Date()
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
        const minYear = sixMonthsAgo.getFullYear()
        const minMonth = sixMonthsAgo.getMonth() + 1

        const evolution = await db
          .select({
            year: payPeriods.year,
            month: payPeriods.month,
            totalGross: payPeriods.totalGross,
            totalNet: payPeriods.totalNet,
            totalEmployerCost: payPeriods.totalEmployerCost,
            slipCount: count(paySlips.id),
          })
          .from(payPeriods)
          .leftJoin(paySlips, eq(paySlips.periodId, payPeriods.id))
          .where(
            sql`(${payPeriods.year} * 100 + ${payPeriods.month}) >= ${minYear * 100 + minMonth}`
          )
          .groupBy(
            payPeriods.id,
            payPeriods.year,
            payPeriods.month,
            payPeriods.totalGross,
            payPeriods.totalNet,
            payPeriods.totalEmployerCost,
          )
          .orderBy(asc(payPeriods.year), asc(payPeriods.month))

        // DSN deadline
        const now = new Date()
        const nextDsnDate = now.getDate() <= 5
          ? new Date(now.getFullYear(), now.getMonth(), 5)
          : new Date(now.getFullYear(), now.getMonth() + 1, 5)

        const daysUntilDsn = Math.ceil(
          (nextDsnDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        )

        return reply.send({
          data: {
            currentPeriod: latestPeriod,
            kpis: currentKpis,
            evolution: evolution.map((e) => ({
              year: Number(e.year),
              month: Number(e.month),
              totalGross: Number(e.totalGross ?? 0),
              totalNet: Number(e.totalNet ?? 0),
              totalEmployerCost: Number(e.totalEmployerCost ?? 0),
              slipCount: Number(e.slipCount),
              label: new Date(Number(e.year), Number(e.month) - 1)
                .toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }),
            })),
            alerts: {
              dsnDaysLeft: daysUntilDsn,
              nextDsnDate: nextDsnDate.toISOString().slice(0, 10),
            },
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/reporting ───────────────────────────────────────────────
  fastify.get('/reporting', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Reporting paie 12 mois par département' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)

        // Évolution 12 derniers mois
        const twelveMonthsAgo = new Date()
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12)
        const minYear = twelveMonthsAgo.getFullYear()
        const minMonth = twelveMonthsAgo.getMonth() + 1

        const monthlyEvolution = await db
          .select({
            year: payPeriods.year,
            month: payPeriods.month,
            totalGross: sum(paySlips.grossSalary),
            totalNet: sum(paySlips.netPayable),
            totalEmployerCost: sum(paySlips.employerCost),
            count: count(paySlips.id),
          })
          .from(payPeriods)
          .leftJoin(paySlips, eq(paySlips.periodId, payPeriods.id))
          .where(
            sql`(${payPeriods.year} * 100 + ${payPeriods.month}) >= ${minYear * 100 + minMonth}`
          )
          .groupBy(payPeriods.year, payPeriods.month)
          .orderBy(asc(payPeriods.year), asc(payPeriods.month))

        // Répartition par département (toutes périodes confondues)
        const byDepartment = await db
          .select({
            departmentName: departments.name,
            totalGross: sum(paySlips.grossSalary),
            count: count(paySlips.id),
          })
          .from(paySlips)
          .leftJoin(employees, eq(employees.id, paySlips.employeeId))
          .leftJoin(departments, eq(departments.id, employees.departmentId))
          .groupBy(departments.name)
          .orderBy(desc(sum(paySlips.grossSalary)))

        return reply.send({
          data: {
            monthlyEvolution: monthlyEvolution.map((e) => ({
              year: Number(e.year),
              month: Number(e.month),
              totalGross: Number(e.totalGross ?? 0),
              totalNet: Number(e.totalNet ?? 0),
              totalEmployerCost: Number(e.totalEmployerCost ?? 0),
              count: Number(e.count),
              label: new Date(Number(e.year), Number(e.month) - 1)
                .toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }),
            })),
            byDepartment: byDepartment.map((d) => ({
              deptName: d.departmentName ?? 'Non affecté',
              totalGross: Number(d.totalGross ?? 0),
              count: Number(d.count),
            })),
          },
        })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/sepa/:periodId ──────────────────────────────────────────
  fastify.get('/sepa/:periodId', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Générer le fichier SEPA pain.001.001.03' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { periodId } = request.params as { periodId: string }

        const [period] = await db
          .select({
            id: payPeriods.id,
            year: payPeriods.year,
            month: payPeriods.month,
            paymentDate: payPeriods.paymentDate,
            entityName: legalEntities.name,
            entitySiret: legalEntities.siret,
          })
          .from(payPeriods)
          .leftJoin(legalEntities, eq(legalEntities.id, payPeriods.entityId))
          .where(eq(payPeriods.id, periodId))
          .limit(1)

        if (!period) {
          return reply.status(404).send({ error: 'Période introuvable' })
        }

        const slips = await db
          .select({
            id: paySlips.id,
            netPayable: paySlips.netPayable,
            firstName: employees.firstName,
            lastName: employees.lastName,
            iban: employees.iban,
            bic: employees.bic,
          })
          .from(paySlips)
          .leftJoin(employees, eq(employees.id, paySlips.employeeId))
          .where(eq(paySlips.periodId, periodId))

        const validSlips = slips.filter((s) => s.iban && Number(s.netPayable) > 0)
        const totalAmount = validSlips.reduce((a, s) => a + Number(s.netPayable), 0)

        const executionDate =
          period.paymentDate ??
          new Date(Number(period.year), Number(period.month), 0).toISOString().slice(0, 10)

        const now = new Date()
        const messageId = `NEXUSRH-${period.year}${String(period.month).padStart(2, '0')}-${now.getTime()}`
        const paymentInfoId = `PMT-${period.year}${String(period.month).padStart(2, '0')}`

        // IBAN de débit employeur (placeholder si non configuré)
        const debtorIban = 'FR7630006000011234567890189'
        const debtorBic = 'BNPAFRPP'

        const xml = buildSepaXml({
          messageId,
          creationDateTime: now.toISOString().replace(/\.\d{3}Z/, '+00:00'),
          totalAmount,
          nbTransactions: validSlips.length,
          debtorName: period.entityName ?? 'Entreprise',
          debtorIban,
          debtorBic,
          paymentInfoId,
          requestedExecutionDate: executionDate,
          transactions: validSlips.map((s) => ({
            endToEndId: `SAL-${s.id.slice(0, 8).toUpperCase()}`,
            amount: Number(s.netPayable),
            creditorName: `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim(),
            creditorIban: (s.iban ?? '').replace(/\s/g, ''),
            creditorBic: s.bic ?? 'NOTPROVIDED',
            remittanceInfo: `Salaire ${period.year}/${String(period.month).padStart(2, '0')}`,
          })),
        })

        const filename = `SEPA-${period.year}-${String(period.month).padStart(2, '0')}.xml`

        return reply
          .header('Content-Type', 'application/xml')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(xml)
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/my-payslips ─────────────────────────────────────────────
  fastify.get('/my-payslips', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Mes bulletins de paie' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const employeeId = request.user.employeeId ?? request.user.sub
        const query = request.query as { limit?: string }
        const slips = await db.query.paySlips.findMany({
          where: eq(paySlips.employeeId, employeeId),
          orderBy: [paySlips.createdAt],
          limit: query.limit ? Number(query.limit) : undefined,
        })
        return reply.send({ data: slips })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── PATCH /payroll/my-payslips/:id/viewed ───────────────────────────────
  fastify.patch('/my-payslips/:id/viewed', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Marquer un bulletin comme consulté' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        await db
          .update(paySlips)
          .set({ viewedByEmployeeAt: new Date() })
          .where(eq(paySlips.id, id))
        return reply.send({ ok: true })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // ── GET /payroll/my-payslips/:id/pdf ─────────────────────────────────────
  fastify.get('/my-payslips/:id/pdf', {
    preHandler: [fastify.authenticate],
    schema: { tags: ['payroll'], summary: 'Télécharger son bulletin en PDF' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const { id } = request.params as { id: string }
        const employeeId = request.user.employeeId ?? request.user.sub

        const slip = await db.query.paySlips.findFirst({ where: eq(paySlips.id, id) })
        if (!slip || slip.employeeId !== employeeId) {
          return reply.status(404).send({ error: 'Bulletin introuvable' })
        }

        const [emp] = await db
          .select({
            firstName: employees.firstName,
            lastName: employees.lastName,
            jobTitle: employees.jobTitle,
          })
          .from(employees)
          .where(eq(employees.id, slip.employeeId))
          .limit(1)

        // Récupérer les infos du tenant depuis platform
        const platformPool = new Pool({ connectionString: config.database.url })
        let tenantName = 'Entreprise'
        let tenantLogoUrl: string | null = null
        try {
          const tenantRes = await platformPool.query<{ name: string; logo_url: string | null }>(
            `SELECT name, logo_url FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
            [request.user.schemaName ?? ''],
          )
          if (tenantRes.rows[0]) {
            tenantName = tenantRes.rows[0].name
            tenantLogoUrl = tenantRes.rows[0].logo_url
          }
        } catch { /* non bloquant */ } finally {
          await platformPool.end().catch(() => undefined)
        }

        let logoBuffer: Buffer | null = null
        if (tenantLogoUrl) {
          try {
            const response = await fetch(tenantLogoUrl)
            if (response.ok) {
              const arrayBuf = await response.arrayBuffer()
              logoBuffer = Buffer.from(arrayBuf)
            }
          } catch { /* logo optionnel */ }
        }

        const monthName = new Date(slip.year ?? 0, (slip.month ?? 1) - 1)
          .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

        const fmt = (n: number) =>
          n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'

        const lines = (slip.lines ?? []) as Array<{
          label: string; type: string
          base?: number; rate?: number
          employeeAmount?: number; employerAmount?: number
        }>

        const earnings = lines.filter((l) => l.type === 'earning')
        const employeeContribs = lines.filter(
          (l) => l.type === 'employee_contribution' || l.type === 'deduction'
        )
        const employerContribs = lines.filter((l) => l.type === 'employer_contribution')

        const totalEmployeeContribs = employeeContribs.reduce(
          (s, l) => s + (l.employeeAmount ?? 0), 0
        )
        const totalEmployerContribs = employerContribs.reduce(
          (s, l) => s + (l.employerAmount ?? 0), 0
        )

        const chunks: Buffer[] = []
        await new Promise<void>((resolve, reject) => {
          const doc = new PDFDocument({
            size: 'A4',
            margin: 40,
            info: { Title: `Bulletin de paie ${monthName}` },
          })
          doc.on('data', (c: Buffer) => chunks.push(c))
          doc.on('end', resolve)
          doc.on('error', reject)

          const L = 40
          const R = 555
          const W = R - L

          let headerY = 40
          if (logoBuffer) {
            try {
              doc.image(logoBuffer, L, headerY, { height: 48, fit: [120, 48] })
            } catch { /* si image non lisible, ignorer */ }
          } else {
            doc.rect(L, headerY, 48, 48).fill('#4F46E5')
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18)
            const initials = tenantName
              .split(' ')
              .map((w) => w[0] ?? '')
              .slice(0, 2)
              .join('')
              .toUpperCase()
            doc.text(initials, L, headerY + 14, { width: 48, align: 'center' })
            doc.fillColor('#000000')
          }

          doc.font('Helvetica-Bold').fontSize(14).fillColor('#1e293b')
          doc.text(tenantName.toUpperCase(), L + 60, headerY + 4, { width: W - 60 })
          doc.font('Helvetica').fontSize(8).fillColor('#64748b')
          doc.text('Numéro SIRET : 000 000 000 00000', L + 60, headerY + 22, { width: W - 60 })
          doc.text('Code APE : 6201Z — Programmation informatique', L + 60, headerY + 32, {
            width: W - 60,
          })
          headerY += 60

          doc.rect(L, headerY, W, 24).fill('#1e3a8a')
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
          doc.text(
            `BULLETIN DE PAIE — ${monthName.toUpperCase()}`,
            L, headerY + 6,
            { width: W, align: 'center' }
          )
          doc.fillColor('#000000')
          headerY += 32

          const empBlockH = 56
          doc.rect(L, headerY, W / 2 - 4, empBlockH).fill('#f8fafc').stroke('#e2e8f0')
          doc.rect(L + W / 2 + 4, headerY, W / 2 - 4, empBlockH).fill('#f8fafc').stroke('#e2e8f0')

          doc.fillColor('#94a3b8').font('Helvetica-Bold').fontSize(7)
          doc.text('SALARIÉ', L + 8, headerY + 6)
          doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(10)
          doc.text(`${emp?.firstName ?? ''} ${emp?.lastName ?? ''}`, L + 8, headerY + 16)
          doc.fillColor('#64748b').font('Helvetica').fontSize(8)
          doc.text(emp?.jobTitle ?? '', L + 8, headerY + 30)
          doc.text(`Matricule : ${slip.employeeId.slice(0, 8).toUpperCase()}`, L + 8, headerY + 41)

          const col2X = L + W / 2 + 12
          doc.fillColor('#94a3b8').font('Helvetica-Bold').fontSize(7)
          doc.text('PÉRIODE DE PAIE', col2X, headerY + 6)
          doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(10)
          doc.text(
            monthName.charAt(0).toUpperCase() + monthName.slice(1),
            col2X, headerY + 16
          )
          doc.fillColor('#64748b').font('Helvetica').fontSize(8)
          doc.text('Durée du travail : 151,67 h', col2X, headerY + 30)
          doc.text('Convention : SYNTEC', col2X, headerY + 41)
          headerY += empBlockH + 12

          const colX = [L, L + 230, L + 320, L + 410, L + 500]
          const colW = [230, 85, 85, 85, 55]

          doc.rect(L, headerY, W, 16).fill('#334155')
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
          const thY = headerY + 4
          doc.text('DÉSIGNATION', colX[0]! + 4, thY, { width: colW[0]! - 8 })
          doc.text('BASE', colX[1]!, thY, { width: colW[1]!, align: 'right' })
          doc.text('TAUX SAL.', colX[2]!, thY, { width: colW[2]!, align: 'right' })
          doc.text('MONTANT SAL.', colX[3]!, thY, { width: colW[3]!, align: 'right' })
          doc.text('MONTANT PAT.', colX[4]!, thY, { width: colW[4]!, align: 'right' })
          doc.fillColor('#000000')
          headerY += 16

          const drawSectionHeader = (label: string, y: number): number => {
            doc.rect(L, y, W, 14).fill('#e2e8f0')
            doc.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(7.5)
            doc.text(label, L + 4, y + 3, { width: W - 8 })
            doc.fillColor('#000000')
            return y + 14
          }

          const drawLine = (
            line: (typeof lines)[0],
            y: number,
            shade: boolean
          ): number => {
            if (shade) doc.rect(L, y, W, 13).fill('#f8fafc')
            doc.font('Helvetica').fontSize(7.5).fillColor('#1e293b')
            doc.text(line.label, colX[0]! + 4, y + 3, { width: colW[0]! - 8 })
            const base = line.base ?? 0
            const rate = line.rate ?? 0
            const empAmt = line.employeeAmount ?? 0
            const patAmt = line.employerAmount ?? 0
            doc.text(base > 0 ? fmt(base) : '', colX[1]!, y + 3, { width: colW[1]!, align: 'right' })
            doc.text(
              rate > 0 ? `${(rate * 100).toFixed(2)} %` : '',
              colX[2]!, y + 3,
              { width: colW[2]!, align: 'right' }
            )
            doc.fillColor(empAmt < 0 ? '#dc2626' : '#1e293b')
            doc.text(empAmt !== 0 ? fmt(empAmt) : '', colX[3]!, y + 3, {
              width: colW[3]!,
              align: 'right',
            })
            doc.fillColor('#64748b')
            doc.text(patAmt !== 0 ? fmt(patAmt) : '', colX[4]!, y + 3, {
              width: colW[4]!,
              align: 'right',
            })
            doc.fillColor('#000000')
            doc.moveTo(L, y + 13).lineTo(R, y + 13).strokeColor('#e2e8f0').lineWidth(0.5).stroke()
            return y + 13
          }

          let cy = drawSectionHeader('ÉLÉMENTS DE RÉMUNÉRATION', headerY)
          earnings.forEach((l, i) => { cy = drawLine(l, cy, i % 2 === 1) })

          cy = drawSectionHeader('COTISATIONS SALARIALES', cy)
          employeeContribs.forEach((l, i) => { cy = drawLine(l, cy, i % 2 === 1) })

          cy = drawSectionHeader('COTISATIONS PATRONALES', cy)
          employerContribs.forEach((l, i) => { cy = drawLine(l, cy, i % 2 === 1) })

          cy += 8
          doc.moveTo(L, cy).lineTo(R, cy).strokeColor('#334155').lineWidth(1).stroke()
          cy += 6

          const drawTotal = (
            label: string,
            value: string,
            bold: boolean,
            color = '#1e293b'
          ) => {
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color)
            doc.text(label, L + 4, cy)
            doc.text(value, L + 4, cy, { width: W - 8, align: 'right' })
            cy += 14
          }

          drawTotal('Salaire brut :', fmt(Number(slip.grossSalary)), false)
          drawTotal(
            'Total cotisations salariales :',
            fmt(totalEmployeeContribs),
            false,
            '#dc2626'
          )
          drawTotal(
            'Total cotisations patronales :',
            fmt(totalEmployerContribs),
            false,
            '#64748b'
          )
          cy += 2

          doc.rect(L, cy, W, 26).fill('#1e3a8a')
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12)
          doc.text('NET À PAYER :', L + 8, cy + 7)
          doc.text(fmt(Number(slip.netPayable)), L + 8, cy + 7, {
            width: W - 16,
            align: 'right',
          })
          cy += 34

          doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
          doc.text(
            `Coût total employeur : ${fmt(
              Number(slip.grossSalary) + totalEmployerContribs
            )}  |  Net imposable : ${fmt(Number(slip.netPayable))}`,
            L, cy,
            { width: W, align: 'center' }
          )
          cy += 16

          doc.moveTo(L, cy).lineTo(R, cy).strokeColor('#e2e8f0').lineWidth(0.5).stroke()
          cy += 6
          doc.font('Helvetica').fontSize(6.5).fillColor('#94a3b8')
          doc.text(
            'Ce bulletin de paie doit être conservé sans limitation de durée (art. L3243-4 du Code du travail).',
            L, cy,
            { width: W, align: 'center' }
          )

          doc.end()
        })

        const pdfBuffer = Buffer.concat(chunks)
        const filename = `bulletin-${slip.year}-${String(slip.month).padStart(2, '0')}.pdf`

        await db
          .update(paySlips)
          .set({ viewedByEmployeeAt: new Date() })
          .where(eq(paySlips.id, id))

        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `inline; filename="${filename}"`)
          .send(pdfBuffer)
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })
  // ── POST /payroll/send-report — Envoyer le rapport de paie par email ────────
  fastify.post('/send-report', {
    preHandler: [fastify.authorize(...(PAYROLL_ROLES as unknown as PayrollRole[]))],
    schema: { tags: ['payroll'], summary: 'Envoyer le rapport de paie par email (comptabilité/banque)' },
    handler: async (request, reply) => {
      try {
        const db = getTenantDbForRequest(request)
        const body = request.body as {
          periodId: string
          recipients: string[]          // e.g. ['compta@entreprise.com', 'banque@bnpparibas.fr']
          reportType: 'journal' | 'sepa' | 'both'
          message?: string
        }

        if (!body.periodId || !body.recipients?.length || !body.reportType) {
          return reply.status(422).send({ error: 'periodId, recipients et reportType sont requis' })
        }

        // Validate email addresses
        const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        const invalid = body.recipients.filter((r) => !emailRx.test(r))
        if (invalid.length > 0) {
          return reply.status(422).send({ error: `Adresse(s) email invalide(s) : ${invalid.join(', ')}` })
        }

        // Fetch period + slips
        const [period] = await db
          .select({
            id: payPeriods.id,
            year: payPeriods.year,
            month: payPeriods.month,
            totalGross: payPeriods.totalGross,
            totalNet: payPeriods.totalNet,
            totalEmployerCost: payPeriods.totalEmployerCost,
            paymentDate: payPeriods.paymentDate,
            entityName: legalEntities.name,
            entitySiret: legalEntities.siret,
          })
          .from(payPeriods)
          .leftJoin(legalEntities, eq(legalEntities.id, payPeriods.entityId))
          .where(eq(payPeriods.id, body.periodId))
          .limit(1)

        if (!period) {
          return reply.status(404).send({ error: 'Période introuvable' })
        }

        const slips = await db
          .select({
            id: paySlips.id,
            employeeId: paySlips.employeeId,
            grossSalary: paySlips.grossSalary,
            netPayable: paySlips.netPayable,
            employerCost: paySlips.employerCost,
            firstName: employees.firstName,
            lastName: employees.lastName,
            iban: employees.iban,
            bic: employees.bic,
          })
          .from(paySlips)
          .leftJoin(employees, eq(employees.id, paySlips.employeeId))
          .where(eq(paySlips.periodId, body.periodId))
          .orderBy(asc(employees.lastName))

        const monthName = new Date(period.year!, (period.month ?? 1) - 1)
          .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

        const fmt = (n: string | null) =>
          n ? parseFloat(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
            : '—'

        const attachments: Array<{ filename: string; content: Buffer | string; contentType: string }> = []

        // ── Build journal PDF ─────────────────────────────────────────────────
        if (body.reportType === 'journal' || body.reportType === 'both') {
          const doc = new PDFDocument({ size: 'A4', margin: 40 })
          const chunks: Buffer[] = []
          doc.on('data', (c: Buffer) => chunks.push(c))

          doc.font('Helvetica-Bold').fontSize(16).text(`Journal de paie — ${monthName}`, { align: 'center' })
          doc.fontSize(10).font('Helvetica').text(`${period.entityName ?? ''}  |  SIRET : ${period.entitySiret ?? ''}`, { align: 'center' })
          doc.moveDown()

          // Summary box
          doc.roundedRect(40, doc.y, 515, 70, 5).fill('#F5F3FF')
          const summaryY = doc.y + 10
          doc.fill('#1E1B4B').font('Helvetica-Bold').fontSize(10)
          doc.text(`Masse salariale brute :   ${fmt(period.totalGross)}`, 60, summaryY)
          doc.text(`Total net à payer :        ${fmt(period.totalNet)}`, 60, summaryY + 18)
          doc.text(`Coût employeur total :     ${fmt(period.totalEmployerCost)}`, 60, summaryY + 36)
          doc.moveDown(5)

          // Table header
          doc.fill('#4F46E5').rect(40, doc.y, 515, 20).fill()
          const cols = [40, 200, 290, 380, 460]
          const headers = ['Nom Prénom', 'Brut', 'Net à payer', 'Coût employeur']
          doc.fill('white').font('Helvetica-Bold').fontSize(9)
          headers.forEach((h, i) => doc.text(h, cols[i]! + 4, doc.y - 16))
          doc.moveDown()

          // Rows
          slips.forEach((slip, idx) => {
            const rowY = doc.y
            if (idx % 2 === 0) {
              doc.fill('#F5F3FF').rect(40, rowY, 515, 16).fill()
            }
            doc.fill('#111827').font('Helvetica').fontSize(9)
            doc.text(`${slip.lastName ?? ''} ${slip.firstName ?? ''}`, cols[0]! + 4, rowY + 3, { width: 155 })
            doc.text(fmt(slip.grossSalary),    cols[1]! + 4, rowY + 3, { width: 85, align: 'right' })
            doc.text(fmt(slip.netPayable),     cols[2]! + 4, rowY + 3, { width: 85, align: 'right' })
            doc.text(fmt(slip.employerCost),   cols[3]! + 4, rowY + 3, { width: 80, align: 'right' })
            doc.moveDown(0.9)
          })

          // Total row
          doc.fill('#E0E7FF').rect(40, doc.y, 515, 18).fill()
          doc.fill('#4F46E5').font('Helvetica-Bold').fontSize(9)
          doc.text('TOTAL', cols[0]! + 4, doc.y - 14)
          doc.text(fmt(period.totalGross),         cols[1]! + 4, doc.y - 14, { width: 85, align: 'right' })
          doc.text(fmt(period.totalNet),            cols[2]! + 4, doc.y - 14, { width: 85, align: 'right' })
          doc.text(fmt(period.totalEmployerCost),   cols[3]! + 4, doc.y - 14, { width: 80, align: 'right' })

          doc.end()
          await new Promise<void>((resolve) => doc.on('end', resolve))
          const pdfBuf = Buffer.concat(chunks)
          attachments.push({
            filename: `journal_paie_${period.year}_${String(period.month).padStart(2, '0')}.pdf`,
            content: pdfBuf,
            contentType: 'application/pdf',
          })
        }

        // ── Build SEPA XML ────────────────────────────────────────────────────
        if (body.reportType === 'sepa' || body.reportType === 'both') {
          const paymentDate = period.paymentDate
            ? new Date(period.paymentDate).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0]
          const totalAmount = slips
            .reduce((s, slip) => s + parseFloat(slip.netPayable ?? '0'), 0)
            .toFixed(2)

          const txns = slips
            .filter((s) => s.iban && s.netPayable)
            .map((s) => `
    <CdtTrfTxInf>
      <PmtId><EndToEndId>SALAIRE-${period.year}${String(period.month).padStart(2, '0')}-${s.id?.slice(0, 8)}</EndToEndId></PmtId>
      <Amt><InstdAmt Ccy="EUR">${parseFloat(s.netPayable ?? '0').toFixed(2)}</InstdAmt></Amt>
      <CdtrAgt><FinInstnId><BIC>${s.bic ?? 'NOTPROVIDED'}</BIC></FinInstnId></CdtrAgt>
      <Cdtr><Nm>${s.lastName ?? ''} ${s.firstName ?? ''}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${(s.iban ?? '').replace(/\s/g, '')}</IBAN></Id></CdtrAcct>
      <RmtInf><Ustrd>SALAIRE ${monthName.toUpperCase()}</Ustrd></RmtInf>
    </CdtTrfTxInf>`).join('')

          const sepaXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>NEXUSRH-${Date.now()}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
      <NbOfTxs>${slips.filter((s) => s.iban).length}</NbOfTxs>
      <CtrlSum>${totalAmount}</CtrlSum>
      <InitgPty><Nm>${period.entityName ?? 'ENTREPRISE'}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PMT-${period.year}-${period.month}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${slips.filter((s) => s.iban).length}</NbOfTxs>
      <CtrlSum>${totalAmount}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${paymentDate}</ReqdExctnDt>
      <Dbtr><Nm>${period.entityName ?? 'ENTREPRISE'}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>FR0000000000000000000000000</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>BNPAFRPPXXX</BIC></FinInstnId></DbtrAgt>
      ${txns}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`

          attachments.push({
            filename: `sepa_${period.year}_${String(period.month).padStart(2, '0')}.xml`,
            content: Buffer.from(sepaXml, 'utf-8'),
            contentType: 'application/xml',
          })
        }

        // ── Send email via SMTP ───────────────────────────────────────────────
        const transporter = nodemailer.createTransport({
          host: config.email.host,
          port: config.email.port,
          secure: config.email.secure,
          auth: config.email.user ? {
            user: config.email.user,
            pass: config.email.pass,
          } : undefined,
        })

        const typeLabel = {
          journal: 'Journal de paie (PDF)',
          sepa: 'Fichier virement SEPA (XML)',
          both: 'Journal de paie (PDF) + Virement SEPA (XML)',
        }[body.reportType]

        await transporter.sendMail({
          from: config.email.from,
          to: body.recipients.join(', '),
          subject: `[NexusRH] Paie ${monthName} — ${typeLabel}`,
          html: `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#4F46E5;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="color:white;margin:0;font-size:20px">📊 Rapport de paie — ${monthName}</h1>
  </div>
  <div style="background:#F9FAFB;padding:24px 32px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px">
    <p style="color:#374151;margin:0 0 16px">Bonjour,</p>
    <p style="color:#374151;margin:0 0 16px">
      Vous trouverez ci-joint le <strong>${typeLabel}</strong> pour la période de paie de <strong>${monthName}</strong>.
    </p>
    ${body.message ? `<div style="background:#EEF2FF;border-left:3px solid #4F46E5;padding:12px 16px;border-radius:4px;margin:0 0 16px"><p style="margin:0;color:#3730A3;font-size:14px">${body.message}</p></div>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
      <tr style="background:#E0E7FF">
        <th style="padding:8px 12px;text-align:left;color:#1E1B4B">Indicateur</th>
        <th style="padding:8px 12px;text-align:right;color:#1E1B4B">Montant</th>
      </tr>
      <tr style="background:white">
        <td style="padding:8px 12px;color:#374151;border-top:1px solid #E5E7EB">Masse salariale brute</td>
        <td style="padding:8px 12px;color:#374151;text-align:right;border-top:1px solid #E5E7EB">${fmt(period.totalGross)}</td>
      </tr>
      <tr style="background:#F9FAFB">
        <td style="padding:8px 12px;color:#374151;border-top:1px solid #E5E7EB">Total net à virer</td>
        <td style="padding:8px 12px;color:#059669;font-weight:bold;text-align:right;border-top:1px solid #E5E7EB">${fmt(period.totalNet)}</td>
      </tr>
      <tr style="background:white">
        <td style="padding:8px 12px;color:#374151;border-top:1px solid #E5E7EB">Coût employeur total</td>
        <td style="padding:8px 12px;color:#374151;text-align:right;border-top:1px solid #E5E7EB">${fmt(period.totalEmployerCost)}</td>
      </tr>
      <tr style="background:#F9FAFB">
        <td style="padding:8px 12px;color:#374151;border-top:1px solid #E5E7EB">Nombre de bulletins</td>
        <td style="padding:8px 12px;color:#374151;text-align:right;border-top:1px solid #E5E7EB">${slips.length}</td>
      </tr>
    </table>
    <p style="color:#6B7280;font-size:12px;margin:16px 0 0">
      Envoyé automatiquement par NexusRH — SIRH SaaS multi-tenant<br>
      ${period.entityName ?? ''}  |  SIRET : ${period.entitySiret ?? ''}
    </p>
  </div>
</div>`,
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        })

        return reply.send({
          success: true,
          message: `Rapport envoyé avec succès à ${body.recipients.length} destinataire(s)`,
          sentTo: body.recipients,
          attachments: attachments.map((a) => a.filename),
        })
      } catch (err) {
        fastify.log.error(err)
        const msg = err instanceof Error ? err.message : 'Erreur serveur'
        return reply.status(500).send({ error: `Échec de l'envoi : ${msg}` })
      }
    },
  })
  // ── GET /payroll/dsn/:periodId — Export DSN (N4DS) ───────────────────────
  fastify.get('/dsn/:periodId', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'payroll_service')],
    schema: { tags: ['payroll'], summary: 'Export DSN N4DS pour une période' },
    handler: async (request, reply) => {
      const { periodId } = request.params as { periodId: string }
      const db = getTenantDbForRequest(request)
      const pool = new Pool({ connectionString: config.database.url })

      try {
        // Récupérer la période et l'entité
        const [period] = await db.select().from(payPeriods).where(eq(payPeriods.id, periodId)).limit(1)
        if (!period) return reply.status(404).send({ error: 'Période non trouvée' })

        const slipRows = await db
          .select({
            slip: paySlips,
            employee: employees,
          })
          .from(paySlips)
          .innerJoin(employees, eq(paySlips.employeeId, employees.id))
          .where(eq(paySlips.periodId, periodId))

        if (slipRows.length === 0) {
          return reply.status(404).send({ error: 'Aucun bulletin pour cette période' })
        }

        const [entity] = await db
          .select()
          .from(legalEntities)
          .where(eq(legalEntities.id, slipRows[0]!.employee.entityId ?? ''))
          .limit(1)

        const year = period.year
        const month = String(period.month).padStart(2, '0')
        // DSN due date : avant le 5 M+1 (≥50) ou 15 M+1 (<50)
        const dsnDueDay = slipRows.length >= 50 ? '05' : '15'
        const nextMonth = period.month === 12 ? 1 : period.month + 1
        const nextYear = period.month === 12 ? year + 1 : year
        const dsnDueDate = `${nextYear}${String(nextMonth).padStart(2, '0')}${dsnDueDay}`
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const siret = entity?.siret ?? '00000000000000'
        const entityName = entity?.name ?? 'ENTREPRISE'

        // ── Construction DSN N4DS (format CTEXT simplifié) ─────────────────
        const lines: string[] = []

        // Bloc S10 — Envoi
        lines.push(`S10.G00.00.001:'${siret.slice(0, 9)}'`)
        lines.push(`S10.G00.00.002:'${siret}'`)
        lines.push(`S10.G00.00.003:'${entityName.slice(0, 50).toUpperCase()}'`)
        lines.push(`S10.G00.00.005:'${today}'`)
        lines.push(`S10.G00.00.006:'${today}T000000'`)
        lines.push(`S10.G00.00.008:'01'`) // type DSN mensuelle
        lines.push(`S10.G00.00.009:'${year}${month}'`)
        lines.push(`S10.G00.00.011:'${dsnDueDate}'`)
        lines.push(`S10.G00.00.012:'NexusRH'`) // logiciel
        lines.push(`S10.G00.00.013:'1.0.0'`)
        lines.push(`S10.G00.00.014:'01'`) // 01 = production

        // Bloc S20 — Entreprise
        lines.push(`S20.G00.05.001:'${siret}'`)
        lines.push(`S20.G00.05.002:'${entityName.slice(0, 50).toUpperCase()}'`)
        if (entity?.address) lines.push(`S20.G00.05.004:'${(entity.address.street + ' ' + entity.address.city).slice(0, 50)}'`)
        if (entity?.apeCode) lines.push(`S20.G00.05.007:'${entity.apeCode}'`)
        lines.push(`S20.G00.05.012:'${entity?.collectiveAgreement ?? '1486'}'`) // SYNTEC par défaut

        // Blocs S21 — Individus (un par employé)
        for (const { slip, employee: emp } of slipRows) {
          const matricule = emp.employeeNumber ?? emp.id.slice(0, 8).toUpperCase()
          const lastName = (emp.lastName ?? '').toUpperCase().slice(0, 80)
          const firstName = (emp.firstName ?? '').slice(0, 80)
          const birthDate = emp.birthDate ? emp.birthDate.replace(/-/g, '') : ''
          const grossSalary = Number(slip.grossSalary ?? 0)
          const netPayable = Number(slip.netPayable ?? 0)

          // Identification
          lines.push(`S21.G00.30.001:'${matricule}'`)
          lines.push(`S21.G00.30.002:'${lastName}'`)
          lines.push(`S21.G00.30.004:'${firstName}'`)
          if (birthDate) lines.push(`S21.G00.30.006:'${birthDate}'`)
          lines.push(`S21.G00.30.009:'${emp.nationality ?? 'FR'}'`)

          // Contrat
          lines.push(`S21.G00.40.001:'${emp.hireDate ? emp.hireDate.replace(/-/g, '') : ''}'`)
          lines.push(`S21.G00.40.007:'01'`) // CDI par défaut (DSN simplifié)

          // Rémunération
          lines.push(`S21.G00.51.001:'${grossSalary.toFixed(2)}'`)
          lines.push(`S21.G00.51.002:'${netPayable.toFixed(2)}'`)
          lines.push(`S21.G00.51.011:'${Number(emp.weeklyHours ?? '35.00').toFixed(2)}'`)

          // Cotisations agrégées
          const lines_cotisations = (slip.lines as Array<{ type: string; employeeAmount?: number; employerAmount?: number }> | null) ?? []
          const totalEmpSal = lines_cotisations
            .filter((l) => l.type === 'employee_contribution' || l.type === 'deduction')
            .reduce((s, l) => s + Math.abs(Number(l.employeeAmount ?? 0)), 0)
          const totalEmpPat = lines_cotisations
            .filter((l) => l.type === 'employer_contribution')
            .reduce((s, l) => s + Number(l.employerAmount ?? 0), 0)

          lines.push(`S21.G00.78.001:'${totalEmpSal.toFixed(2)}'`)
          lines.push(`S21.G00.78.002:'${totalEmpPat.toFixed(2)}'`)
        }

        // Totaux S40
        const totalGross = slipRows.reduce((s, { slip }) => s + Number(slip.grossSalary ?? 0), 0)
        const totalNet = slipRows.reduce((s, { slip }) => s + Number(slip.netPayable ?? 0), 0)
        lines.push(`S40.G00.90.001:'${slipRows.length}'`)
        lines.push(`S40.G00.90.002:'${totalGross.toFixed(2)}'`)
        lines.push(`S40.G00.90.003:'${totalNet.toFixed(2)}'`)

        pool.end().catch(() => {})

        const dsnContent = lines.join('\r\n') + '\r\n'
        const filename = `DSN_${siret}_${year}${month}_${today}.dsn`

        reply.header('Content-Type', 'text/plain; charset=utf-8')
        reply.header('Content-Disposition', `attachment; filename="${filename}"`)
        return reply.send(dsnContent)
      } catch (err) {
        fastify.log.error({ err }, 'DSN export error')
        pool.end().catch(() => {})
        return reply.status(500).send({ error: 'Erreur génération DSN' })
      }
    },
  })
}

export default payrollRoutes
