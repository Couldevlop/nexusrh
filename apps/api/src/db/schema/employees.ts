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
  integer,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

export const legalEntities = pgTable('legal_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  siren: varchar('siren', { length: 9 }),
  siret: varchar('siret', { length: 14 }),
  apeCode: varchar('ape_code', { length: 5 }),
  collectiveAgreement: varchar('collective_agreement', { length: 100 }),
  countryCode: varchar('country_code', { length: 2 }).notNull().default('FR'),
  address: jsonb('address').$type<{
    street: string
    city: string
    postalCode: string
    country: string
  }>(),
  logoUrl: text('logo_url'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  name: varchar('name', { length: 100 }).notNull(),
  code: varchar('code', { length: 20 }),
  parentId: uuid('parent_id'),
  managerId: uuid('manager_id'),
  costCenter: varchar('cost_center', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  employeeNumber: varchar('employee_number', { length: 50 }).unique(),
  profileType: varchar('profile_type', { length: 30 })
    .notNull()
    .default('employee'),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 20 }),
  birthDate: date('birth_date'),
  birthPlace: varchar('birth_place', { length: 100 }),
  nationality: varchar('nationality', { length: 2 }),
  socialSecurityNumber: varchar('social_security_number', { length: 255 }),
  iban: varchar('iban', { length: 255 }),
  bic: varchar('bic', { length: 20 }),
  address: jsonb('address').$type<{
    street: string
    city: string
    postalCode: string
    country: string
  }>(),
  userId: uuid('user_id'),
  hireDate: date('hire_date'),
  endDate: date('end_date'),
  jobTitle: varchar('job_title', { length: 200 }),
  jobLevel: varchar('job_level', { length: 50 }),
  departmentId: uuid('department_id').references(() => departments.id),
  managerId: uuid('manager_id').references((): AnyPgColumn => employees.id),
  workingTimePercentage: decimal('working_time_percentage', {
    precision: 5,
    scale: 2,
  }).default('100.00'),
  weeklyHours: decimal('weekly_hours', { precision: 5, scale: 2 }).default(
    '35.00'
  ),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  photoUrl: text('photo_url'),
  hasDisability: boolean('has_disability').default(false),
  retentionScore: decimal('retention_score', { precision: 3, scale: 2 }),
  burnoutRisk: varchar('burnout_risk', { length: 10 }),
  aiScoreUpdatedAt: timestamp('ai_score_updated_at', { withTimezone: true }),
  aiScoreFactors: jsonb('ai_score_factors')
    .$type<string[]>()
    .default([]),
  customFields: jsonb('custom_fields')
    .$type<Record<string, unknown>>()
    .default({}),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

export const hrEvents = pgTable('hr_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  type: varchar('type', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  eventDate: date('event_date').notNull(),
  metadata: jsonb('metadata')
    .$type<Record<string, unknown>>()
    .default({}),
  isPrivate: boolean('is_private').default(false),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const employeeDocuments = pgTable('employee_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').references(() => employees.id),
  type: varchar('type', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  fileUrl: text('file_url').notNull(),
  fileSize: integer('file_size'),
  mimeType: varchar('mime_type', { length: 100 }),
  isConfidential: boolean('is_confidential').default(false),
  signedByEmployee: boolean('signed_by_employee').default(false),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// parameters — generic configurable lists per tenant
// category: 'contract_type' | 'expense_category' | 'job_level' | 'training_category' | 'collective_agreement'
export const parameters = pgTable('parameters', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: varchar('category', { length: 50 }).notNull(),
  code: varchar('code', { length: 100 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  color: varchar('color', { length: 20 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type LegalEntity = typeof legalEntities.$inferSelect
export type NewLegalEntity = typeof legalEntities.$inferInsert
export type Department = typeof departments.$inferSelect
export type NewDepartment = typeof departments.$inferInsert
export type Employee = typeof employees.$inferSelect
export type NewEmployee = typeof employees.$inferInsert
export type HREvent = typeof hrEvents.$inferSelect
export type Parameter = typeof parameters.$inferSelect
export type NewParameter = typeof parameters.$inferInsert
export type EmployeeDocument = typeof employeeDocuments.$inferSelect
