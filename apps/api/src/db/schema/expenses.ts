import {
  pgTable,
  uuid,
  varchar,
  date,
  decimal,
  integer,
  timestamp,
  text,
  jsonb,
  boolean,
} from 'drizzle-orm/pg-core'
import { employees } from './employees'
import { users } from './auth'

export const expenseReports = pgTable('expense_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  title: varchar('title', { length: 255 }).notNull(),
  month: varchar('month', { length: 7 }).notNull(),
  totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).default('0'),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  // draft | submitted | approved | rejected | reimbursed
  validationLevel: integer('validation_level').notNull().default(0),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  reimbursedAt: timestamp('reimbursed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const expenseLines = pgTable('expense_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id')
    .notNull()
    .references(() => expenseReports.id, { onDelete: 'cascade' }),
  category: varchar('category', { length: 50 }).notNull(),
  // transport | meals | accommodation | supplies | other
  description: varchar('description', { length: 255 }).notNull(),
  date: date('date').notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  receiptUrl: text('receipt_url'),
  mileage: decimal('mileage', { precision: 8, scale: 2 }),
  isRefundable: boolean('is_refundable').default(true),
  ocrData: jsonb('ocr_data').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type ExpenseReport = typeof expenseReports.$inferSelect
export type NewExpenseReport = typeof expenseReports.$inferInsert
export type ExpenseLine = typeof expenseLines.$inferSelect
export type NewExpenseLine = typeof expenseLines.$inferInsert
