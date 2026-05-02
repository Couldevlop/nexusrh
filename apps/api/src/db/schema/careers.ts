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
  smallint,
} from 'drizzle-orm/pg-core'
import { employees, legalEntities } from './employees'
import { users } from './auth'

export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => legalEntities.id),
  name: varchar('name', { length: 100 }).notNull(),
  category: varchar('category', { length: 50 }),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const employeeSkills = pgTable('employee_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  skillId: uuid('skill_id').notNull().references(() => skills.id),
  level: smallint('level').notNull(), // 1=débutant 2=intermédiaire 3=avancé 4=expert
  assessedAt: date('assessed_at'),
  assessedBy: uuid('assessed_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Entretiens (annuels + professionnels obligatoires L6315-1) ────────────────
export const evaluations = pgTable('evaluations', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  evaluatorId: uuid('evaluator_id').references(() => employees.id),
  evaluatorUserId: uuid('evaluator_user_id').references(() => users.id),

  // Type d'entretien
  type: varchar('type', { length: 30 }).notNull().default('annual'),
  // annual          → Entretien annuel d'évaluation (performance)
  // professional    → Entretien professionnel obligatoire (art. L6315-1 CT) — tous les 2 ans
  // six_year_review → Bilan 6 ans (vérification des 3 critères légaux)
  // mid_year        → Point mi-parcours
  // trial_period    → Entretien fin période d'essai
  // 360             → Évaluation 360°

  year: smallint('year').notNull(),

  status: varchar('status', { length: 30 }).default('planned'),
  // planned | invited | in_progress | awaiting_employee_sign | completed | cancelled

  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  // ── Évaluation performance (entretien annuel) ────────────────────────────
  overallRating: smallint('overall_rating'),        // 1-5
  goalsAchievement: smallint('goals_achievement'),  // 1-5
  skillsRating: jsonb('skills_rating')
    .$type<Array<{ skillId: string; skillName: string; rating: number }>>()
    .default([]),
  strengths: text('strengths'),
  improvements: text('improvements'),
  nextYearGoals: jsonb('next_year_goals')
    .$type<Array<{ goal: string; indicator?: string; dueDate?: string; weight?: number }>>()
    .default([]),
  salaryIncreaseProposed: decimal('salary_increase_proposed', { precision: 5, scale: 2 }),
  promotionProposed: boolean('promotion_proposed').default(false),
  targetJobTitle: varchar('target_job_title', { length: 200 }),  // Mobilité souhaitée

  // ── Entretien professionnel L6315-1 (obligatoire tous les 2 ans) ─────────
  // Ces champs sont remplis UNIQUEMENT pour type = 'professional' ou 'six_year_review'
  careerProjectDiscussed: boolean('career_project_discussed').default(false),
  trainingNeedsIdentified: boolean('training_needs_identified').default(false),
  cpfInformationProvided: boolean('cpf_information_provided').default(false),
  qualificationsDiscussed: boolean('qualifications_discussed').default(false),
  employabilityDiscussed: boolean('employability_discussed').default(false),

  // ── Bilan 6 ans (art. L6315-1 al. 2 — 3 critères sur 6 ans) ─────────────
  // Sanction si < 2 critères sur 3 : abondement CPF de 3 000 € (employeur)
  sixYearCriteria_formation: boolean('six_year_criteria_formation').default(false),
  // Critère 1 : au moins une action de formation non obligatoire sur 6 ans
  sixYearCriteria_certification: boolean('six_year_criteria_certification').default(false),
  // Critère 2 : obtention d'un élément de certification (diplôme, titre, CQP, bloc)
  sixYearCriteria_progression: boolean('six_year_criteria_progression').default(false),
  // Critère 3 : progression salariale OU professionnelle (changement de classification/poste)
  cpfAbondementRequired: boolean('cpf_abondement_required').default(false),
  // true si < 2 critères sur 3 → abondement correctif obligatoire 3 000 €

  // ── Commentaires et signature ─────────────────────────────────────────────
  employeeComments: text('employee_comments'),
  managerComments: text('manager_comments'),
  hrComments: text('hr_comments'),

  signedByEmployee: boolean('signed_by_employee').default(false),
  employeeSignedAt: timestamp('employee_signed_at', { withTimezone: true }),
  signedByManager: boolean('signed_by_manager').default(false),
  managerSignedAt: timestamp('manager_signed_at', { withTimezone: true }),

  // Invitation envoyée par email
  invitationSentAt: timestamp('invitation_sent_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Plan de Développement Individuel (PDI) ────────────────────────────────────
export const developmentPlans = pgTable('development_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  evaluationId: uuid('evaluation_id').references(() => evaluations.id), // Lié à un entretien
  year: smallint('year').notNull(),
  status: varchar('status', { length: 20 }).default('draft'),
  // draft | active | completed | archived

  title: varchar('title', { length: 255 }).notNull(),
  objectives: jsonb('objectives')
    .$type<Array<{
      id: string
      description: string
      type: 'skill' | 'training' | 'certification' | 'mobility' | 'other'
      priority: 'high' | 'medium' | 'low'
      dueDate?: string
      resources?: string
      progress: number  // 0-100
      completedAt?: string
    }>>()
    .default([]),

  trainingActions: jsonb('training_actions')
    .$type<Array<{
      id: string
      title: string
      type: 'cpf' | 'plan_formation' | 'vae' | 'bilan_competences' | 'other'
      estimatedDuration?: string
      estimatedCost?: number
      priority: 'high' | 'medium' | 'low'
      status: 'planned' | 'in_progress' | 'completed' | 'cancelled'
    }>>()
    .default([]),

  shortTermGoal: text('short_term_goal'),   // 1 an
  mediumTermGoal: text('medium_term_goal'), // 3 ans
  longTermGoal: text('long_term_goal'),     // 5 ans

  employeeComments: text('employee_comments'),
  managerComments: text('manager_comments'),

  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Plan de carrière / Mobilité ───────────────────────────────────────────────
export const careerPaths = pgTable('career_paths', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),

  currentPosition: varchar('current_position', { length: 200 }),
  targetPosition: varchar('target_position', { length: 200 }),
  targetEntityId: uuid('target_entity_id').references(() => legalEntities.id),
  mobilityType: varchar('mobility_type', { length: 30 }),
  // internal_promotion | lateral_move | geographic | external

  targetDate: date('target_date'),
  readinessLevel: smallint('readiness_level'), // 1=potentiel 2=développable 3=prêt dans 1an 4=prêt maintenant

  keyStrengths: jsonb('key_strengths').$type<string[]>().default([]),
  gapsToAddress: jsonb('gaps_to_address').$type<string[]>().default([]),
  requiredActions: jsonb('required_actions')
    .$type<Array<{ action: string; owner: string; dueDate?: string }>>()
    .default([]),

  status: varchar('status', { length: 20 }).default('active'),
  // active | on_hold | achieved | cancelled

  notes: text('notes'),
  validatedBy: uuid('validated_by').references(() => users.id),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Matrice 9-box (Performance × Potentiel) ───────────────────────────────────
export const nineBox = pgTable('nine_box', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  year: smallint('year').notNull(),
  performanceAxis: smallint('performance_axis').notNull(), // 1-3
  potentialAxis: smallint('potential_axis').notNull(),     // 1-3
  box: smallint('box').notNull(),                          // 1-9
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Skill = typeof skills.$inferSelect
export type EmployeeSkill = typeof employeeSkills.$inferSelect
export type Evaluation = typeof evaluations.$inferSelect
export type DevelopmentPlan = typeof developmentPlans.$inferSelect
export type CareerPath = typeof careerPaths.$inferSelect
export type NineBox = typeof nineBox.$inferSelect
