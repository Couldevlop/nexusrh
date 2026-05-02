import {
  pgTable,
  uuid,
  varchar,
  date,
  decimal,
  boolean,
  timestamp,
  text,
  jsonb,
  smallint,
  integer,
} from 'drizzle-orm/pg-core'
import { employees, legalEntities } from './employees'
import { users } from './auth'

export const contracts = pgTable('contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  type: varchar('type', { length: 30 }).notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  trialPeriodEnd: date('trial_period_end'),
  grossSalary: decimal('gross_salary', { precision: 12, scale: 2 }).notNull(),
  salaryBasis: varchar('salary_basis', { length: 20 }).default('monthly'),
  workingHoursPerWeek: decimal('working_hours_per_week', {
    precision: 5,
    scale: 2,
  }).default('35'),
  collectiveAgreement: varchar('collective_agreement', { length: 100 }),
  jobClassification: varchar('job_classification', { length: 50 }),
  nonCompetitionClause: boolean('non_competition_clause').default(false),
  telecommutingDays: smallint('telecommuting_days').default(0),
  documentUrl: text('document_url'),
  signatureStatus: varchar('signature_status', { length: 30 }),
  signatureRequestId: varchar('signature_request_id', { length: 255 }),
  status: varchar('status', { length: 20 }).default('active'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const payrollRules = pgTable('payroll_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  code: varchar('code', { length: 50 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  type: varchar('type', { length: 30 }).notNull(),
  formula: text('formula').notNull(),
  base: varchar('base', { length: 100 }),
  employeeRate: decimal('employee_rate', { precision: 8, scale: 6 }),
  employerRate: decimal('employer_rate', { precision: 8, scale: 6 }),
  ceilingSS: decimal('ceiling_ss', { precision: 3, scale: 2 }),
  isActive: boolean('is_active').notNull().default(true),
  order: integer('order').notNull().default(0),
  appliesTo: jsonb('applies_to')
    .$type<{
      profileTypes?: string[]
      departments?: string[]
      collectiveAgreements?: string[]
    }>()
    .default({}),
  validFrom: date('valid_from'),
  validUntil: date('valid_until'),
  legalReference: varchar('legal_reference', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const payPeriods = pgTable('pay_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  year: smallint('year').notNull(),
  month: smallint('month').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => users.id),
  totalGross: decimal('total_gross', { precision: 14, scale: 2 }),
  totalNet: decimal('total_net', { precision: 14, scale: 2 }),
  totalEmployerCost: decimal('total_employer_cost', {
    precision: 14,
    scale: 2,
  }),
  paymentDate: date('payment_date'),
})

export const paySlips = pgTable('pay_slips', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  periodId: uuid('period_id')
    .notNull()
    .references(() => payPeriods.id),
  year: smallint('year').notNull(),
  month: smallint('month').notNull(),
  grossSalary: decimal('gross_salary', { precision: 12, scale: 2 }).notNull(),
  netBeforeTax: decimal('net_before_tax', { precision: 12, scale: 2 }),
  incomeTax: decimal('income_tax', { precision: 12, scale: 2 }).default('0'),
  netPayable: decimal('net_payable', { precision: 12, scale: 2 }).notNull(),
  employerCost: decimal('employer_cost', { precision: 12, scale: 2 }),
  lines: jsonb('lines')
    .$type<
      Array<{
        ruleCode: string
        label: string
        base: number
        quantity?: number
        employeeRate?: number
        employerRate?: number
        employeeAmount: number
        employerAmount: number
        type: string
      }>
    >()
    .notNull(),
  variableElements: jsonb('variable_elements')
    .$type<Array<{ ruleCode: string; label: string; amount: number }>>()
    .default([]),
  workingDays: decimal('working_days', { precision: 5, scale: 2 }),
  pdfUrl: text('pdf_url'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  generatedAt: timestamp('generated_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  viewedByEmployeeAt: timestamp('viewed_by_employee_at', {
    withTimezone: true,
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const variableElements = pgTable('variable_elements', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  periodId: uuid('period_id')
    .notNull()
    .references(() => payPeriods.id),
  ruleCode: varchar('rule_code', { length: 50 }).notNull(),
  label: varchar('label', { length: 255 }),
  amount: decimal('amount', { precision: 12, scale: 2 }),
  quantity: decimal('quantity', { precision: 8, scale: 2 }),
  rate: decimal('rate', { precision: 8, scale: 6 }),
  note: text('note'),
  source: varchar('source', { length: 30 }).default('manual'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type Contract = typeof contracts.$inferSelect
export type NewContract = typeof contracts.$inferInsert
export type PayrollRule = typeof payrollRules.$inferSelect
export type NewPayrollRule = typeof payrollRules.$inferInsert
export type PayPeriod = typeof payPeriods.$inferSelect
export type NewPayPeriod = typeof payPeriods.$inferInsert
export type PaySlip = typeof paySlips.$inferSelect
export type NewPaySlip = typeof paySlips.$inferInsert
export type VariableElement = typeof variableElements.$inferSelect
export type NewVariableElement = typeof variableElements.$inferInsert
