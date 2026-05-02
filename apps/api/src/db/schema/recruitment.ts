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
import { employees, legalEntities, departments } from './employees'
import { users } from './auth'

export const jobOffers = pgTable('job_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  departmentId: uuid('department_id').references(() => departments.id),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  requirements: text('requirements'),
  contractType: varchar('contract_type', { length: 30 }),
  location: varchar('location', { length: 255 }),
  remote: varchar('remote', { length: 20 }).default('hybrid'),
  salaryMin: decimal('salary_min', { precision: 10, scale: 2 }),
  salaryMax: decimal('salary_max', { precision: 10, scale: 2 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  // draft | published | paused | closed
  publishedAt: timestamp('published_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  hiringManagerId: uuid('hiring_manager_id').references(() => employees.id),
  requiredBy: date('required_by'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const candidates = pgTable('candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobOfferId: uuid('job_offer_id')
    .notNull()
    .references(() => jobOffers.id),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 20 }),
  currentPosition: varchar('current_position', { length: 200 }),
  currentCompany: varchar('current_company', { length: 200 }),
  cvUrl: text('cv_url'),
  coverLetterUrl: text('cover_letter_url'),
  linkedinUrl: text('linkedin_url'),
  stage: varchar('stage', { length: 30 }).notNull().default('new'),
  // new | screening | phone_interview | technical | hr_interview | offer | hired | rejected
  score: integer('score'),
  notes: text('notes'),
  aiSummary: text('ai_summary'),
  rejectionReason: text('rejection_reason'),
  source: varchar('source', { length: 50 }),
  // direct | linkedin | indeed | referral | agency | other
  expectedSalary: decimal('expected_salary', { precision: 10, scale: 2 }),
  availableFrom: date('available_from'),
  tags: jsonb('tags').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const interviews = pgTable('interviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  candidateId: uuid('candidate_id')
    .notNull()
    .references(() => candidates.id),
  interviewerId: uuid('interviewer_id').references(() => employees.id),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  duration: integer('duration').default(60),
  type: varchar('type', { length: 30 }).default('video'),
  // video | phone | in_person | technical
  status: varchar('status', { length: 20 }).default('scheduled'),
  meetingUrl: text('meeting_url'),
  feedback: text('feedback'),
  rating: integer('rating'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type JobOffer = typeof jobOffers.$inferSelect
export type NewJobOffer = typeof jobOffers.$inferInsert
export type Candidate = typeof candidates.$inferSelect
export type NewCandidate = typeof candidates.$inferInsert
export type Interview = typeof interviews.$inferSelect
