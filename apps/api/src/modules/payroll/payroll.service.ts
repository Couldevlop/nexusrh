import { eq, and } from 'drizzle-orm'
import { getDb, type TenantDb } from '../../db/client'
import {
  payPeriods,
  paySlips,
  payrollRules,
  variableElements,
  contracts,
} from '../../db/schema/payroll'
import { employees, legalEntities } from '../../db/schema/employees'
import { payrollEngine } from './payroll.engine'
import { NotFoundError, ConflictError, BadRequestError } from '../../utils/errors'
import { generatePaySlipPdf } from '../../services/pdf.service'
import { uploadFile } from '../../services/storage.service'
import type { Employee, Contract, PayrollRule } from '@nexusrh/shared'

type Db = TenantDb | ReturnType<typeof getDb>

export async function getOrCreatePayPeriod(
  entityId: string,
  year: number,
  month: number,
  db?: Db
) {
  const dbInstance = db ?? getDb()

  const existing = await dbInstance.query.payPeriods.findFirst({
    where: and(
      eq(payPeriods.entityId, entityId),
      eq(payPeriods.year, year),
      eq(payPeriods.month, month)
    ),
  })

  if (existing) return existing

  const [period] = await dbInstance
    .insert(payPeriods)
    .values({
      entityId,
      year,
      month,
      status: 'open',
      openedAt: new Date(),
    })
    .returning()

  return period
}

export async function calculatePaySlip(
  employeeId: string,
  periodId: string,
  db?: Db
) {
  const dbInstance = db ?? getDb()

  const employee = await dbInstance.query.employees.findFirst({
    where: eq(employees.id, employeeId),
  })
  if (!employee) throw new NotFoundError('Collaborateur', employeeId)

  const period = await dbInstance.query.payPeriods.findFirst({
    where: eq(payPeriods.id, periodId),
  })
  if (!period) throw new NotFoundError('Période de paie', periodId)

  const contract = await dbInstance.query.contracts.findFirst({
    where: and(
      eq(contracts.employeeId, employeeId),
      eq(contracts.status, 'active')
    ),
  })
  if (!contract) throw new BadRequestError(`Aucun contrat actif pour le collaborateur ${employeeId}`)

  const rules = await dbInstance.query.payrollRules.findMany({
    where: and(
      eq(payrollRules.entityId, employee.entityId),
      eq(payrollRules.isActive, true)
    ),
    orderBy: [payrollRules.order],
  })

  const varElements = await dbInstance.query.variableElements.findMany({
    where: and(
      eq(variableElements.employeeId, employeeId),
      eq(variableElements.periodId, periodId)
    ),
  })

  const result = payrollEngine.calculate({
    employee: employee as unknown as Employee,
    contract: contract as unknown as Contract,
    period: { year: Number(period.year), month: Number(period.month) },
    variableElements: varElements.map((ve) => ({
      ruleCode: ve.ruleCode,
      amount: ve.amount,
      quantity: ve.quantity,
      rate: ve.rate,
    })),
    rules: rules as unknown as PayrollRule[],
  })

  const [paySlip] = await dbInstance
    .insert(paySlips)
    .values({
      employeeId,
      periodId,
      year: Number(period.year),
      month: Number(period.month),
      grossSalary: result.grossSalary.toString(),
      netBeforeTax: result.netBeforeTax.toString(),
      incomeTax: result.incomeTax.toString(),
      netPayable: result.netPayable.toString(),
      employerCost: result.employerCost.toString(),
      lines: result.lines as never,
      variableElements: [],
      workingDays: result.workingDays.toString(),
      status: 'generated',
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [paySlips.employeeId, paySlips.periodId],
      set: {
        grossSalary: result.grossSalary.toString(),
        netBeforeTax: result.netBeforeTax.toString(),
        netPayable: result.netPayable.toString(),
        employerCost: result.employerCost.toString(),
        lines: result.lines as never,
        status: 'generated',
        generatedAt: new Date(),
      },
    })
    .returning()

  return { paySlip, calculation: result }
}

export async function generatePaySlipPdfAndUpload(paySlipId: string, db?: Db) {
  const dbInstance = db ?? getDb()

  const paySlip = await dbInstance.query.paySlips.findFirst({
    where: eq(paySlips.id, paySlipId),
  })
  if (!paySlip) throw new NotFoundError('Bulletin de paie', paySlipId)

  const employee = await dbInstance.query.employees.findFirst({
    where: eq(employees.id, paySlip.employeeId),
  })
  if (!employee) throw new NotFoundError('Collaborateur', paySlip.employeeId)

  const entity = await dbInstance.query.legalEntities.findFirst({
    where: eq(legalEntities.id, employee.entityId),
  })
  if (!entity) throw new NotFoundError('Entité légale', employee.entityId)

  const pdfBuffer = await generatePaySlipPdf({
    ...paySlip,
    employee,
    entity,
  } as never)

  const { url } = await uploadFile(
    pdfBuffer,
    `bulletin-${paySlip.year}-${String(paySlip.month).padStart(2, '0')}-${employee.employeeNumber}.pdf`,
    `payslips/${employee.entityId}/${paySlip.year}`,
    'application/pdf'
  )

  await dbInstance
    .update(paySlips)
    .set({ pdfUrl: url, status: 'generated' })
    .where(eq(paySlips.id, paySlipId))

  return { pdfUrl: url, pdfBuffer }
}

export async function listPaySlips(employeeId: string, db?: Db) {
  const dbInstance = db ?? getDb()
  return dbInstance.query.paySlips.findMany({
    where: eq(paySlips.employeeId, employeeId),
    orderBy: [paySlips.year, paySlips.month],
  })
}

export async function getPayrollRules(entityId: string, db?: Db) {
  const dbInstance = db ?? getDb()
  if (entityId) {
    return dbInstance.query.payrollRules.findMany({
      where: eq(payrollRules.entityId, entityId),
      orderBy: [payrollRules.order],
    })
  }
  return dbInstance.query.payrollRules.findMany({
    orderBy: [payrollRules.order],
  })
}
