import {
  pgSchema, uuid, varchar, boolean, integer, timestamp, text,
  numeric, date, jsonb, index,
} from 'drizzle-orm/pg-core'

/**
 * Schéma tenant NexusRH CI — instancié dynamiquement par schemaName
 * Chaque tenant a son propre schéma PostgreSQL isolé.
 */
export function createTenantSchema(schemaName: string) {
  const schema = pgSchema(schemaName)

  // ── USERS ─────────────────────────────────────────────────────────────────
  const users = schema.table('users', {
    id:             uuid('id').primaryKey().defaultRandom(),
    email:          varchar('email', { length: 255 }).notNull().unique(),
    passwordHash:   varchar('password_hash', { length: 255 }).notNull(),
    firstName:      varchar('first_name', { length: 100 }).notNull(),
    lastName:       varchar('last_name', { length: 100 }).notNull(),
    role:           varchar('role', { length: 20 }).notNull().default('employee'),
    isActive:       boolean('is_active').notNull().default(true),
    mfaEnabled:     boolean('mfa_enabled').notNull().default(false),
    mfaSecret:      varchar('mfa_secret', { length: 255 }),
    lastLoginAt:    timestamp('last_login_at', { withTimezone: true }),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── DEPARTMENTS ────────────────────────────────────────────────────────────
  const departments = schema.table('departments', {
    id:        uuid('id').primaryKey().defaultRandom(),
    name:      varchar('name', { length: 100 }).notNull(),
    code:      varchar('code', { length: 20 }),
    managerId: uuid('manager_id'),
    parentId:  uuid('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── EMPLOYEES ──────────────────────────────────────────────────────────────
  const employees = schema.table('employees', {
    id:              uuid('id').primaryKey().defaultRandom(),
    userId:          uuid('user_id'),
    employeeNumber:  varchar('employee_number', { length: 50 }),
    // Identité
    firstName:       varchar('first_name', { length: 100 }).notNull(),
    lastName:        varchar('last_name', { length: 100 }).notNull(),
    email:           varchar('email', { length: 255 }),
    phone:           varchar('phone', { length: 30 }),
    birthDate:       date('birth_date'),
    birthPlace:      varchar('birth_place', { length: 100 }),
    nationality:     varchar('nationality', { length: 100 }).default('Ivoirienne'),
    gender:          varchar('gender', { length: 10 }),
    // CI-specific
    nni:             varchar('nni', { length: 50 }),           // Numéro National d'Identité
    cnpsNumber:      varchar('cnps_number', { length: 50 }),   // Numéro CNPS salarié
    mobileMoneyProvider: varchar('mobile_money_provider', { length: 20 }),
    mobileMoneyPhone:    varchar('mobile_money_phone', { length: 20 }),
    // Poste
    departmentId:    uuid('department_id'),
    managerId:       uuid('manager_id'),
    jobTitle:        varchar('job_title', { length: 100 }),
    jobLevel:        varchar('job_level', { length: 50 }),
    contractType:    varchar('contract_type', { length: 30 }).default('cdi'),
    hireDate:        date('hire_date'),
    trialEndDate:    date('trial_end_date'),
    exitDate:        date('exit_date'),
    exitReason:      varchar('exit_reason', { length: 100 }),
    // Salaire
    baseSalary:      numeric('base_salary', { precision: 12, scale: 0 }).notNull().default('0'),
    currency:        varchar('currency', { length: 3 }).default('XOF'),
    // Adresse
    address:         jsonb('address').default('{}'),
    city:            varchar('city', { length: 100 }).default('Abidjan'),
    // Coordonnées bancaires (chiffrées)
    iban:            varchar('iban', { length: 255 }),
    bankName:        varchar('bank_name', { length: 100 }),
    // IA
    retentionScore:     numeric('retention_score', { precision: 3, scale: 2 }),
    burnoutRisk:        varchar('burnout_risk', { length: 10 }),
    aiScoreUpdatedAt:   timestamp('ai_score_updated_at', { withTimezone: true }),
    aiScoreFactors:     jsonb('ai_score_factors').default('[]'),
    // Famille
    maritalStatus:   varchar('marital_status', { length: 20 }),
    childrenCount:   integer('children_count').default(0),
    // Méta
    customFields:    jsonb('custom_fields').default('{}'),
    profilePhotoUrl: text('profile_photo_url'),
    isActive:        boolean('is_active').notNull().default(true),
    deletedAt:       timestamp('deleted_at', { withTimezone: true }),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── CONTRACTS ─────────────────────────────────────────────────────────────
  const contracts = schema.table('contracts', {
    id:                uuid('id').primaryKey().defaultRandom(),
    employeeId:        uuid('employee_id').notNull(),
    type:              varchar('type', { length: 30 }).notNull().default('cdi'),
    startDate:         date('start_date').notNull(),
    endDate:           date('end_date'),
    trialEndDate:      date('trial_end_date'),
    baseSalary:        numeric('base_salary', { precision: 12, scale: 0 }).notNull(),
    currency:          varchar('currency', { length: 3 }).default('XOF'),
    workingHours:      numeric('working_hours', { precision: 4, scale: 1 }).default('40'),
    convention:        varchar('convention', { length: 100 }),
    jobTitle:          varchar('job_title', { length: 100 }),
    jobLevel:          varchar('job_level', { length: 50 }),
    // CI specific
    cnpsAffiliation:   boolean('cnps_affiliation').default(true),
    ohadaClause:       boolean('ohada_clause').default(true),
    nonCompetitionClause: boolean('non_competition_clause').default(false),
    telecommutingDays: integer('telecommuting_days').default(0),
    // Signature
    status:            varchar('status', { length: 20 }).default('active'),
    signatureStatus:   varchar('signature_status', { length: 30 }),
    fileUrl:           text('file_url'),
    createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── PAYROLL RULES ─────────────────────────────────────────────────────────
  const payrollRules = schema.table('payroll_rules', {
    id:            uuid('id').primaryKey().defaultRandom(),
    code:          varchar('code', { length: 10 }).notNull(),
    label:         varchar('label', { length: 200 }).notNull(),
    type:          varchar('type', { length: 30 }).notNull(), // earning|deduction|employee_contribution|employer_contribution
    formula:       varchar('formula', { length: 500 }).notNull(),
    order:         integer('order').notNull().default(0),
    isActive:      boolean('is_active').notNull().default(true),
    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── PAY PERIODS ───────────────────────────────────────────────────────────
  const payPeriods = schema.table('pay_periods', {
    id:          uuid('id').primaryKey().defaultRandom(),
    month:       varchar('month', { length: 7 }).notNull(), // YYYY-MM
    status:      varchar('status', { length: 20 }).notNull().default('open'),
    closedAt:    timestamp('closed_at', { withTimezone: true }),
    closedBy:    uuid('closed_by'),
    totalGross:  numeric('total_gross', { precision: 14, scale: 0 }),
    totalNet:    numeric('total_net', { precision: 14, scale: 0 }),
    totalCnps:   numeric('total_cnps', { precision: 14, scale: 0 }),
    totalIts:    numeric('total_its', { precision: 14, scale: 0 }),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── PAY SLIPS ─────────────────────────────────────────────────────────────
  const paySlips = schema.table('pay_slips', {
    id:             uuid('id').primaryKey().defaultRandom(),
    employeeId:     uuid('employee_id').notNull(),
    periodId:       uuid('period_id').notNull(),
    month:          varchar('month', { length: 7 }).notNull(),
    // Salaire CI
    baseSalary:         numeric('base_salary', { precision: 12, scale: 0 }).notNull(),
    grossSalary:        numeric('gross_salary', { precision: 12, scale: 0 }).notNull(),
    // CNPS
    cnpsRetraiteSal:    numeric('cnps_retraite_sal', { precision: 10, scale: 0 }).default('0'),
    cnpsRetaitePat:     numeric('cnps_retraite_pat', { precision: 10, scale: 0 }).default('0'),
    cnpsPfPat:          numeric('cnps_pf_pat', { precision: 10, scale: 0 }).default('0'),
    cnpsAtPat:          numeric('cnps_at_pat', { precision: 10, scale: 0 }).default('0'),
    totalCnpsSal:       numeric('total_cnps_sal', { precision: 10, scale: 0 }).default('0'),
    totalCnpsPat:       numeric('total_cnps_pat', { precision: 10, scale: 0 }).default('0'),
    // ITS
    its:                numeric('its', { precision: 10, scale: 0 }).default('0'),
    // Totaux
    totalDeductions:    numeric('total_deductions', { precision: 12, scale: 0 }).default('0'),
    netPayable:         numeric('net_payable', { precision: 12, scale: 0 }).notNull(),
    employerCost:       numeric('employer_cost', { precision: 12, scale: 0 }).notNull(),
    currency:           varchar('currency', { length: 3 }).default('XOF'),
    // Paiement
    paymentMethod:      varchar('payment_method', { length: 30 }).default('mobile_money'),
    paymentStatus:      varchar('payment_status', { length: 20 }).default('pending'),
    paymentReference:   varchar('payment_reference', { length: 100 }),
    // Lignes détaillées
    lines:              jsonb('lines').default('[]'),
    // Méta
    status:             varchar('status', { length: 20 }).notNull().default('draft'),
    generatedAt:        timestamp('generated_at', { withTimezone: true }),
    viewedByEmployeeAt: timestamp('viewed_by_employee_at', { withTimezone: true }),
    fileUrl:            text('file_url'),
    createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── VARIABLE ELEMENTS ─────────────────────────────────────────────────────
  const variableElements = schema.table('variable_elements', {
    id:         uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    periodId:   uuid('period_id').notNull(),
    ruleCode:   varchar('rule_code', { length: 10 }).notNull(),
    label:      varchar('label', { length: 200 }),
    amount:     numeric('amount', { precision: 12, scale: 0 }).notNull(),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── CNPS DECLARATIONS ─────────────────────────────────────────────────────
  const cnpsDeclarations = schema.table('cnps_declarations', {
    id:          uuid('id').primaryKey().defaultRandom(),
    month:       varchar('month', { length: 7 }).notNull(), // YYYY-MM
    status:      varchar('status', { length: 20 }).default('draft'),
    totalSalaries: numeric('total_salaries', { precision: 14, scale: 0 }).default('0'),
    totalCnpsSal: numeric('total_cnps_sal', { precision: 12, scale: 0 }).default('0'),
    totalCnpsPat: numeric('total_cnps_pat', { precision: 12, scale: 0 }).default('0'),
    employeeCount: integer('employee_count').default(0),
    exportUrl:   text('export_url'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    dueDate:     date('due_date'), // le 15 du mois M+1
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── DISA RECORDS ──────────────────────────────────────────────────────────
  const disaRecords = schema.table('disa_records', {
    id:            uuid('id').primaryKey().defaultRandom(),
    year:          integer('year').notNull(),
    employeeId:    uuid('employee_id').notNull(),
    nni:           varchar('nni', { length: 50 }),
    cnpsNumber:    varchar('cnps_number', { length: 50 }),
    firstName:     varchar('first_name', { length: 100 }).notNull(),
    lastName:      varchar('last_name', { length: 100 }).notNull(),
    annualGross:   numeric('annual_gross', { precision: 14, scale: 0 }).notNull(),
    annualCnpsSal: numeric('annual_cnps_sal', { precision: 12, scale: 0 }).default('0'),
    annualIts:     numeric('annual_its', { precision: 12, scale: 0 }).default('0'),
    status:        varchar('status', { length: 20 }).default('draft'),
    exportUrl:     text('export_url'),
    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── MOBILE MONEY PAYMENTS ─────────────────────────────────────────────────
  const mobileMoneyPayments = schema.table('mobile_money_payments', {
    id:             uuid('id').primaryKey().defaultRandom(),
    paySlipId:      uuid('pay_slip_id'),
    employeeId:     uuid('employee_id').notNull(),
    amount:         numeric('amount', { precision: 12, scale: 0 }).notNull(),
    currency:       varchar('currency', { length: 3 }).default('XOF'),
    provider:       varchar('provider', { length: 20 }).notNull(), // wave|mtn_momo|orange_money
    phoneNumber:    varchar('phone_number', { length: 20 }).notNull(),
    reference:      varchar('reference', { length: 100 }),
    externalRef:    varchar('external_ref', { length: 200 }),
    status:         varchar('status', { length: 20 }).default('pending'),
    errorMessage:   text('error_message'),
    initiatedAt:    timestamp('initiated_at', { withTimezone: true }),
    confirmedAt:    timestamp('confirmed_at', { withTimezone: true }),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── ABSENCE TYPES ─────────────────────────────────────────────────────────
  const absenceTypes = schema.table('absence_types', {
    id:              uuid('id').primaryKey().defaultRandom(),
    code:            varchar('code', { length: 20 }).notNull().unique(),
    label:           varchar('label', { length: 100 }).notNull(),
    isPaid:          boolean('is_paid').default(true),
    affectsSalary:   boolean('affects_salary').default(false),
    calculationMode: varchar('calculation_mode', { length: 20 }).default('working_days'),
    requiresApproval: boolean('requires_approval').default(true),
    maxDaysPerYear:  integer('max_days_per_year'),
    color:           varchar('color', { length: 7 }).default('#4F46E5'),
    isActive:        boolean('is_active').default(true),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── ABSENCE BALANCES ──────────────────────────────────────────────────────
  const absenceBalances = schema.table('absence_balances', {
    id:            uuid('id').primaryKey().defaultRandom(),
    employeeId:    uuid('employee_id').notNull(),
    absenceTypeId: uuid('absence_type_id').notNull(),
    year:          integer('year').notNull(),
    acquired:      numeric('acquired', { precision: 6, scale: 1 }).default('0'),
    taken:         numeric('taken', { precision: 6, scale: 1 }).default('0'),
    pending:       numeric('pending', { precision: 6, scale: 1 }).default('0'),
    remaining:     numeric('remaining', { precision: 6, scale: 1 }).default('0'),
    updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── ABSENCES ──────────────────────────────────────────────────────────────
  const absences = schema.table('absences', {
    id:             uuid('id').primaryKey().defaultRandom(),
    employeeId:     uuid('employee_id').notNull(),
    absenceTypeId:  uuid('absence_type_id').notNull(),
    startDate:      date('start_date').notNull(),
    endDate:        date('end_date').notNull(),
    days:           numeric('days', { precision: 4, scale: 1 }).notNull(),
    halfDay:        boolean('half_day').default(false),
    reason:         text('reason'),
    status:         varchar('status', { length: 20 }).notNull().default('pending'),
    validationLevel: integer('validation_level').notNull().default(0),
    approvedBy:     uuid('approved_by'),
    approvedAt:     timestamp('approved_at', { withTimezone: true }),
    rejectedBy:     uuid('rejected_by'),
    rejectionReason: text('rejection_reason'),
    attachmentUrl:  text('attachment_url'),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── EXPENSE REPORTS ───────────────────────────────────────────────────────
  const expenseReports = schema.table('expense_reports', {
    id:              uuid('id').primaryKey().defaultRandom(),
    employeeId:      uuid('employee_id').notNull(),
    title:           varchar('title', { length: 200 }).notNull(),
    month:           varchar('month', { length: 7 }).notNull(),
    totalAmount:     numeric('total_amount', { precision: 12, scale: 0 }).default('0'),
    currency:        varchar('currency', { length: 3 }).default('XOF'),
    status:          varchar('status', { length: 20 }).notNull().default('draft'),
    validationLevel: integer('validation_level').notNull().default(0),
    submittedAt:     timestamp('submitted_at', { withTimezone: true }),
    approvedBy:      uuid('approved_by'),
    approvedAt:      timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    paymentMethod:   varchar('payment_method', { length: 20 }).default('mobile_money'),
    paidAt:          timestamp('paid_at', { withTimezone: true }),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const expenseLines = schema.table('expense_lines', {
    id:          uuid('id').primaryKey().defaultRandom(),
    reportId:    uuid('report_id').notNull(),
    description: varchar('description', { length: 300 }).notNull(),
    category:    varchar('category', { length: 50 }).notNull(),
    date:        date('date').notNull(),
    amount:      numeric('amount', { precision: 10, scale: 0 }).notNull(),
    currency:    varchar('currency', { length: 3 }).default('XOF'),
    receiptUrl:  text('receipt_url'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── RECRUITMENT ───────────────────────────────────────────────────────────
  const recruitmentJobs = schema.table('recruitment_jobs', {
    id:             uuid('id').primaryKey().defaultRandom(),
    title:          varchar('title', { length: 200 }).notNull(),
    departmentId:   uuid('department_id'),
    location:       varchar('location', { length: 100 }).default('Abidjan'),
    contractType:   varchar('contract_type', { length: 30 }).default('cdi'),
    salaryMin:      numeric('salary_min', { precision: 12, scale: 0 }),
    salaryMax:      numeric('salary_max', { precision: 12, scale: 0 }),
    currency:       varchar('currency', { length: 3 }).default('XOF'),
    description:    text('description'),
    requirements:   text('requirements'),
    status:         varchar('status', { length: 20 }).default('open'),
    publishedAt:    timestamp('published_at', { withTimezone: true }),
    closedAt:       timestamp('closed_at', { withTimezone: true }),
    createdBy:      uuid('created_by'),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const applications = schema.table('applications', {
    id:           uuid('id').primaryKey().defaultRandom(),
    jobId:        uuid('job_id').notNull(),
    firstName:    varchar('first_name', { length: 100 }).notNull(),
    lastName:     varchar('last_name', { length: 100 }).notNull(),
    email:        varchar('email', { length: 255 }).notNull(),
    phone:        varchar('phone', { length: 30 }),
    cvUrl:        text('cv_url'),
    coverLetter:  text('cover_letter'),
    stage:        varchar('stage', { length: 30 }).default('new'),
    aiScore:      integer('ai_score'),
    aiSummary:    text('ai_summary'),
    notes:        text('notes'),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── TRAININGS ─────────────────────────────────────────────────────────────
  const trainings = schema.table('trainings', {
    id:              uuid('id').primaryKey().defaultRandom(),
    title:           varchar('title', { length: 200 }).notNull(),
    description:     text('description'),
    duration:        integer('duration'),
    durationUnit:    varchar('duration_unit', { length: 10 }).default('hours'),
    format:          varchar('format', { length: 30 }).default('presentiel'),
    category:        varchar('category', { length: 50 }),
    isFdfpEligible:  boolean('is_fdfp_eligible').default(false),
    fdfpCode:        varchar('fdfp_code', { length: 50 }),
    maxParticipants: integer('max_participants'),
    isActive:        boolean('is_active').default(true),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const trainingSessions = schema.table('training_sessions', {
    id:           uuid('id').primaryKey().defaultRandom(),
    trainingId:   uuid('training_id').notNull(),
    startDate:    date('start_date').notNull(),
    endDate:      date('end_date'),
    location:     varchar('location', { length: 200 }),
    trainer:      varchar('trainer', { length: 100 }),
    status:       varchar('status', { length: 20 }).default('planned'),
    maxPlaces:    integer('max_places').default(20),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const trainingEnrollments = schema.table('training_enrollments', {
    id:          uuid('id').primaryKey().defaultRandom(),
    sessionId:   uuid('session_id').notNull(),
    employeeId:  uuid('employee_id').notNull(),
    status:      varchar('status', { length: 20 }).default('enrolled'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    certificateUrl: text('certificate_url'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── CAREER ────────────────────────────────────────────────────────────────
  const careerSkills = schema.table('career_skills', {
    id:       uuid('id').primaryKey().defaultRandom(),
    name:     varchar('name', { length: 100 }).notNull(),
    category: varchar('category', { length: 50 }),
    isActive: boolean('is_active').default(true),
  })

  const employeeSkills = schema.table('employee_skills', {
    id:         uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    skillId:    uuid('skill_id').notNull(),
    level:      integer('level').notNull().default(1), // 1-5
    targetLevel: integer('target_level'),
    updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const evaluations = schema.table('evaluations', {
    id:                    uuid('id').primaryKey().defaultRandom(),
    employeeId:            uuid('employee_id').notNull(),
    evaluatorId:           uuid('evaluator_id'),
    type:                  varchar('type', { length: 30 }).default('annual'),
    year:                  integer('year').notNull(),
    period:                varchar('period', { length: 20 }),
    globalScore:           numeric('global_score', { precision: 3, scale: 1 }),
    performanceScore:      numeric('performance_score', { precision: 3, scale: 1 }),
    goalsScore:            numeric('goals_score', { precision: 3, scale: 1 }),
    skillsScore:           numeric('skills_score', { precision: 3, scale: 1 }),
    comments:              text('comments'),
    managerComments:       text('manager_comments'),
    employeeComments:      text('employee_comments'),
    goals:                 jsonb('goals').default('[]'),
    strengths:             jsonb('strengths').default('[]'),
    improvements:          jsonb('improvements').default('[]'),
    trainingNeeds:         jsonb('training_needs').default('[]'),
    status:                varchar('status', { length: 20 }).default('draft'),
    signedByEmployee:      boolean('signed_by_employee').default(false),
    signedByManager:       boolean('signed_by_manager').default(false),
    completedAt:           timestamp('completed_at', { withTimezone: true }),
    createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:             timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── HR EVENTS ─────────────────────────────────────────────────────────────
  const hrEvents = schema.table('hr_events', {
    id:          uuid('id').primaryKey().defaultRandom(),
    employeeId:  uuid('employee_id').notNull(),
    type:        varchar('type', { length: 50 }).notNull(),
    title:       varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    date:        date('date').notNull(),
    metadata:    jsonb('metadata').default('{}'),
    createdBy:   uuid('created_by'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
  const notifications = schema.table('notifications', {
    id:         uuid('id').primaryKey().defaultRandom(),
    userId:     uuid('user_id').notNull(),
    type:       varchar('type', { length: 50 }).notNull(),
    title:      varchar('title', { length: 200 }).notNull(),
    message:    text('message').notNull(),
    isRead:     boolean('is_read').default(false),
    data:       jsonb('data').default('{}'),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── AUDIT LOG ─────────────────────────────────────────────────────────────
  const auditLog = schema.table('audit_log', {
    id:         uuid('id').primaryKey().defaultRandom(),
    userId:     uuid('user_id'),
    action:     varchar('action', { length: 100 }).notNull(),
    entity:     varchar('entity', { length: 50 }).notNull(),
    entityId:   uuid('entity_id'),
    changes:    jsonb('changes').default('{}'),
    ipAddress:  varchar('ip_address', { length: 45 }),
    userAgent:  text('user_agent'),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── REFRESH TOKENS ────────────────────────────────────────────────────────
  const refreshTokens = schema.table('refresh_tokens', {
    id:        uuid('id').primaryKey().defaultRandom(),
    userId:    uuid('user_id').notNull(),
    token:     varchar('token', { length: 500 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  // ── WORKFLOW CONFIGS ──────────────────────────────────────────────────────
  const workflowConfigs = schema.table('workflow_configs', {
    id:          uuid('id').primaryKey().defaultRandom(),
    module:      varchar('module', { length: 30 }).notNull().unique(),
    levelsCount: integer('levels_count').notNull().default(1),
    config:      jsonb('config').default('{}'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  return {
    users, departments, employees, contracts,
    payrollRules, payPeriods, paySlips, variableElements,
    cnpsDeclarations, disaRecords, mobileMoneyPayments,
    absenceTypes, absenceBalances, absences,
    expenseReports, expenseLines,
    recruitmentJobs, applications,
    trainings, trainingSessions, trainingEnrollments,
    careerSkills, employeeSkills, evaluations,
    hrEvents, notifications, auditLog, refreshTokens, workflowConfigs,
  }
}

export type TenantSchema = ReturnType<typeof createTenantSchema>
