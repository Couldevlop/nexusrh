import { z } from 'zod'

export const createVariableElementSchema = z.object({
  employeeId: z.string().uuid(),
  periodId: z.string().uuid(),
  ruleCode: z.string().min(1).max(50),
  label: z.string().max(255).optional(),
  amount: z.string().optional(),
  quantity: z.string().optional(),
  rate: z.string().optional(),
  note: z.string().optional(),
  source: z
    .enum(['manual', 'import', 'automatic', 'absence', 'overtime'])
    .optional()
    .default('manual'),
})

export const createPayPeriodSchema = z.object({
  entityId: z.string().uuid(),
  year: z.number().min(2020).max(2099),
  month: z.number().min(1).max(12),
  paymentDate: z.string().date().optional(),
})

export const payrollRuleSchema = z.object({
  entityId: z.string().uuid(),
  code: z.string().min(1).max(50),
  label: z.string().min(1).max(255),
  type: z.enum([
    'earning',
    'deduction',
    'employer_contribution',
    'employee_contribution',
    'info',
  ]),
  formula: z.string().min(1),
  base: z.string().optional(),
  employeeRate: z.string().optional(),
  employerRate: z.string().optional(),
  ceilingSS: z.string().optional(),
  isActive: z.boolean().optional().default(true),
  order: z.number().int().optional().default(0),
  appliesTo: z
    .object({
      profileTypes: z.array(z.string()).optional(),
      departments: z.array(z.string().uuid()).optional(),
      collectiveAgreements: z.array(z.string()).optional(),
    })
    .optional()
    .default({}),
  validFrom: z.string().date().optional(),
  validUntil: z.string().date().optional(),
  legalReference: z.string().max(255).optional(),
})

export type CreateVariableElementInput = z.infer<typeof createVariableElementSchema>
export type CreatePayPeriodInput = z.infer<typeof createPayPeriodSchema>
export type PayrollRuleInput = z.infer<typeof payrollRuleSchema>
