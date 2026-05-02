import {
  pgTable,
  uuid,
  varchar,
  date,
  decimal,
  integer,
  boolean,
  timestamp,
  text,
  jsonb,
} from 'drizzle-orm/pg-core'
import { employees, legalEntities } from './employees'
import { users } from './auth'

export const absenceTypes = pgTable('absence_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  code: varchar('code', { length: 20 }).notNull(),
  label: varchar('label', { length: 100 }).notNull(),
  category: varchar('category', { length: 30 }).notNull(),
  countingUnit: varchar('counting_unit', { length: 20 }).default('working_days'),
  requiresJustification: boolean('requires_justification').default(false),
  requiresApproval: boolean('requires_approval').default(true),
  isPaid: boolean('is_paid').default(true),
  impactsPayroll: boolean('impacts_payroll').default(false),
  isActive: boolean('is_active').default(true),
  color: varchar('color', { length: 7 }).default('#4F46E5'),
  maxDaysPerYear: decimal('max_days_per_year', { precision: 5, scale: 2 }),
})

export const absenceBalances = pgTable('absence_balances', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  absenceTypeId: uuid('absence_type_id')
    .notNull()
    .references(() => absenceTypes.id),
  periodLabel: varchar('period_label', { length: 9 }).notNull(),
  acquired: decimal('acquired', { precision: 7, scale: 2 }).default('0'),
  taken: decimal('taken', { precision: 7, scale: 2 }).default('0'),
  pending: decimal('pending', { precision: 7, scale: 2 }).default('0'),
  carried: decimal('carried', { precision: 7, scale: 2 }).default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const absences = pgTable('absences', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  absenceTypeId: uuid('absence_type_id')
    .notNull()
    .references(() => absenceTypes.id),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  startHalf: varchar('start_half', { length: 10 }),
  endHalf: varchar('end_half', { length: 10 }),
  daysCount: decimal('days_count', { precision: 5, scale: 2 }).notNull(),
  reason: text('reason'),
  justificationUrl: text('justification_url'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  validationLevel: integer('validation_level').notNull().default(0),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  payrollImpact: jsonb('payroll_impact'),
  requestedAt: timestamp('requested_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type AbsenceType = typeof absenceTypes.$inferSelect
export type NewAbsenceType = typeof absenceTypes.$inferInsert
export type AbsenceBalance = typeof absenceBalances.$inferSelect
export type Absence = typeof absences.$inferSelect
export type NewAbsence = typeof absences.$inferInsert
