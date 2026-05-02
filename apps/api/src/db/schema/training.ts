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
} from 'drizzle-orm/pg-core'
import { employees, legalEntities } from './employees'
import { users } from './auth'

export const trainingCourses = pgTable('training_courses', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  provider: varchar('provider', { length: 200 }),
  format: varchar('format', { length: 30 }).default('in_person'),
  // in_person | remote | e_learning | blended
  durationHours: integer('duration_hours'),
  cpfEligible: boolean('cpf_eligible').default(false),
  cpfCode: varchar('cpf_code', { length: 50 }),
  cost: decimal('cost', { precision: 10, scale: 2 }),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const trainingSessions = pgTable('training_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  courseId: uuid('course_id')
    .notNull()
    .references(() => trainingCourses.id),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  location: varchar('location', { length: 255 }),
  maxParticipants: integer('max_participants'),
  status: varchar('status', { length: 20 }).default('scheduled'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const trainingEnrollments = pgTable('training_enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => trainingSessions.id),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  status: varchar('status', { length: 20 }).default('enrolled'),
  // enrolled | completed | cancelled | absent
  completedAt: timestamp('completed_at', { withTimezone: true }),
  rating: integer('rating'),
  feedback: text('feedback'),
  certificate: text('certificate'),
  cpfHoursUsed: decimal('cpf_hours_used', { precision: 5, scale: 2 }),
  enrolledBy: uuid('enrolled_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type TrainingCourse = typeof trainingCourses.$inferSelect
export type TrainingSession = typeof trainingSessions.$inferSelect
export type TrainingEnrollment = typeof trainingEnrollments.$inferSelect
