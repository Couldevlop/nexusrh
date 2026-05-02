import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../config'

/**
 * Creates a new tenant schema in PostgreSQL and provisions all RH tables.
 * Returns the schemaName and the created admin user's ID.
 */
export async function createTenantSchema(
  slug: string,
  adminEmail: string,
  adminFirstName: string,
  adminLastName: string,
  adminPasswordHash: string,
  tenantName?: string,
): Promise<{ schemaName: string; adminUserId: string }> {
  const schemaName = `tenant_${slug.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`

  const pool = new Pool({
    connectionString: config.database.url,
    min: 1,
    max: 3,
  })

  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Create the schema
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
      await client.query(`SET search_path TO "${schemaName}", public`)

      // 2. Create all tenant tables
      await createTenantTables(client, schemaName)

      // 3. Insert default legal entity and capture its ID
      const entityName = tenantName ?? slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      const entityRes2 = await client.query<{ id: string }>(
        `INSERT INTO "${schemaName}".legal_entities (name, country_code) VALUES ($1, 'FR') RETURNING id`,
        [entityName],
      )
      const defaultEntityId = entityRes2.rows[0]?.id

      // 4. Insert default absence types (requires entity_id — NOT NULL)
      if (defaultEntityId) {
        const defaultAbsenceTypes = [
          { code: 'CP',         label: 'Congés payés',       category: 'paid',   color: '#4F46E5', req_approval: true,  is_paid: true,  max_days: 25 },
          { code: 'RTT',        label: 'RTT',                category: 'paid',   color: '#7C3AED', req_approval: true,  is_paid: true,  max_days: 12 },
          { code: 'MALADIE',    label: 'Maladie',            category: 'sick',   color: '#EF4444', req_approval: false, is_paid: false, max_days: 90 },
          { code: 'MATERNITE',  label: 'Maternité',          category: 'family', color: '#EC4899', req_approval: false, is_paid: true,  max_days: 112 },
          { code: 'PATERNITE',  label: 'Paternité',          category: 'family', color: '#8B5CF6', req_approval: false, is_paid: true,  max_days: 25 },
          { code: 'EVENEMENT',  label: 'Événement familial', category: 'family', color: '#F59E0B', req_approval: false, is_paid: true,  max_days: 5 },
          { code: 'SANS_SOLDE', label: 'Sans solde',         category: 'unpaid', color: '#6B7280', req_approval: true,  is_paid: false, max_days: 365 },
        ]
        for (const at of defaultAbsenceTypes) {
          await client.query(
            `INSERT INTO "${schemaName}".absence_types
              (entity_id, code, label, category, color, requires_justification, requires_approval, is_paid, impacts_payroll, max_days_per_year)
             VALUES ($1,$2,$3,$4,$5,false,$6,$7,true,$8)
             ON CONFLICT DO NOTHING`,
            [defaultEntityId, at.code, at.label, at.category, at.color, at.req_approval, at.is_paid, at.max_days],
          )
        }
      }

      // 5. Insert default departments (generic French company structure)
      if (defaultEntityId) {
        const defaultDepts = [
          { code: 'DIR',   name: 'Direction Générale',       color: '#1E293B' },
          { code: 'RH',    name: 'Ressources Humaines',      color: '#7C3AED' },
          { code: 'FIN',   name: 'Finance & Comptabilité',   color: '#0EA5E9' },
          { code: 'IT',    name: 'Informatique / IT',        color: '#4F46E5' },
          { code: 'COM',   name: 'Commercial',               color: '#059669' },
          { code: 'MKT',   name: 'Marketing & Communication',color: '#DB2777' },
          { code: 'OPS',   name: 'Opérations',               color: '#D97706' },
          { code: 'JUR',   name: 'Juridique & Conformité',   color: '#DC2626' },
        ]
        for (const dept of defaultDepts) {
          await client.query(
            `INSERT INTO "${schemaName}".departments (entity_id, code, name)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [defaultEntityId, dept.code, dept.name],
          )
        }
      }

      // 6. Insert admin user
      const adminIdResult = await client.query<{ id: string }>(
        `INSERT INTO "${schemaName}".users
          (email, password_hash, first_name, last_name, role, is_active)
         VALUES ($1, $2, $3, $4, 'admin', true)
         RETURNING id`,
        [adminEmail, adminPasswordHash, adminFirstName, adminLastName],
      )

      const adminUserId = adminIdResult.rows[0]?.id
      if (!adminUserId) {
        throw new Error('Failed to create admin user during tenant provisioning')
      }

      await client.query('COMMIT')
      return { schemaName, adminUserId }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

/**
 * Creates all RH tables inside the given schemaName.
 * Uses IF NOT EXISTS so it is idempotent.
 */
export async function createTenantTables(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  schemaName: string,
): Promise<void> {
  const s = schemaName

  // Enable uuid-ossp extension (if not already)
  await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)

  // legal_entities
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".legal_entities (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(255) NOT NULL,
      siren VARCHAR(9),
      siret VARCHAR(14),
      ape_code VARCHAR(5),
      collective_agreement VARCHAR(100),
      country_code VARCHAR(2) NOT NULL DEFAULT 'FR',
      address JSONB,
      logo_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // departments
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".departments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20),
      parent_id UUID,
      manager_id UUID,
      cost_center VARCHAR(50),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // users (tenant users, NOT platform_users)
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255),
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'employee',
      employee_id UUID,
      mfa_enabled BOOLEAN NOT NULL DEFAULT false,
      mfa_secret VARCHAR(255),
      google_id VARCHAR(255),
      microsoft_id VARCHAR(255),
      avatar_url TEXT,
      last_login_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT true,
      password_reset_token VARCHAR(255),
      password_reset_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // employees
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".employees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      employee_number VARCHAR(50) UNIQUE,
      profile_type VARCHAR(30) NOT NULL DEFAULT 'employee',
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(20),
      birth_date DATE,
      birth_place VARCHAR(100),
      nationality VARCHAR(2),
      social_security_number VARCHAR(255),
      iban VARCHAR(255),
      bic VARCHAR(20),
      address JSONB,
      hire_date DATE,
      end_date DATE,
      job_title VARCHAR(200),
      job_level VARCHAR(50),
      department_id UUID REFERENCES "${s}".departments(id),
      manager_id UUID REFERENCES "${s}".employees(id),
      working_time_percentage DECIMAL(5,2) DEFAULT 100.00,
      weekly_hours DECIMAL(5,2) DEFAULT 35.00,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      photo_url TEXT,
      has_disability BOOLEAN DEFAULT false,
      retention_score DECIMAL(3,2),
      burnout_risk VARCHAR(10),
      ai_score_updated_at TIMESTAMPTZ,
      ai_score_factors JSONB DEFAULT '[]'::jsonb,
      custom_fields JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `)

  // Add FK from users.employee_id to employees.id after employees table exists
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'users_employee_id_fkey'
          AND table_schema = '${s}'
      ) THEN
        ALTER TABLE "${s}".users
          ADD CONSTRAINT users_employee_id_fkey
          FOREIGN KEY (employee_id) REFERENCES "${s}".employees(id);
      END IF;
    END$$
  `)

  // refresh_tokens
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES "${s}".users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      ip_address VARCHAR(45),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // audit_log
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".audit_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES "${s}".users(id),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id UUID,
      old_value TEXT,
      new_value TEXT,
      ip_address INET,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // contracts
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".contracts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      type VARCHAR(30) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE,
      trial_period_end DATE,
      gross_salary DECIMAL(12,2) NOT NULL,
      salary_basis VARCHAR(20) DEFAULT 'monthly',
      working_hours_per_week DECIMAL(5,2) DEFAULT 35,
      collective_agreement VARCHAR(100),
      job_classification VARCHAR(50),
      non_competition_clause BOOLEAN DEFAULT false,
      telecommuting_days SMALLINT DEFAULT 0,
      document_url TEXT,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // payroll_rules
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".payroll_rules (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      code VARCHAR(50) NOT NULL,
      label VARCHAR(255) NOT NULL,
      type VARCHAR(30) NOT NULL,
      formula TEXT NOT NULL,
      base VARCHAR(100),
      employee_rate DECIMAL(8,6),
      employer_rate DECIMAL(8,6),
      ceiling_ss DECIMAL(3,2),
      is_active BOOLEAN NOT NULL DEFAULT true,
      "order" INTEGER NOT NULL DEFAULT 0,
      applies_to JSONB DEFAULT '{}'::jsonb,
      valid_from DATE,
      valid_until DATE,
      legal_reference VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // pay_periods
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".pay_periods (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      year SMALLINT NOT NULL,
      month SMALLINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ,
      validated_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      closed_by UUID REFERENCES "${s}".users(id),
      total_gross DECIMAL(14,2),
      total_net DECIMAL(14,2),
      total_employer_cost DECIMAL(14,2),
      payment_date DATE
    )
  `)

  // pay_slips
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".pay_slips (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      period_id UUID NOT NULL REFERENCES "${s}".pay_periods(id),
      year SMALLINT NOT NULL,
      month SMALLINT NOT NULL,
      gross_salary DECIMAL(12,2) NOT NULL,
      net_before_tax DECIMAL(12,2),
      income_tax DECIMAL(12,2) DEFAULT 0,
      net_payable DECIMAL(12,2) NOT NULL,
      employer_cost DECIMAL(12,2),
      lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      variable_elements JSONB DEFAULT '[]'::jsonb,
      working_days DECIMAL(5,2),
      pdf_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      generated_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      viewed_by_employee_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // variable_elements
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".variable_elements (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      period_id UUID NOT NULL REFERENCES "${s}".pay_periods(id),
      rule_code VARCHAR(50) NOT NULL,
      label VARCHAR(255),
      amount DECIMAL(12,2),
      quantity DECIMAL(8,2),
      rate DECIMAL(8,6),
      note TEXT,
      source VARCHAR(30) DEFAULT 'manual',
      created_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // absence_types
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".absence_types (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      code VARCHAR(20) NOT NULL,
      label VARCHAR(100) NOT NULL,
      category VARCHAR(30) NOT NULL,
      counting_unit VARCHAR(20) DEFAULT 'working_days',
      requires_justification BOOLEAN DEFAULT false,
      requires_approval BOOLEAN DEFAULT true,
      is_paid BOOLEAN DEFAULT true,
      impacts_payroll BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      color VARCHAR(7) DEFAULT '#4F46E5',
      max_days_per_year DECIMAL(5,2)
    )
  `)

  // absence_balances
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".absence_balances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      absence_type_id UUID NOT NULL REFERENCES "${s}".absence_types(id),
      period_label VARCHAR(9) NOT NULL,
      acquired DECIMAL(7,2) DEFAULT 0,
      taken DECIMAL(7,2) DEFAULT 0,
      pending DECIMAL(7,2) DEFAULT 0,
      carried DECIMAL(7,2) DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // absences
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".absences (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      absence_type_id UUID NOT NULL REFERENCES "${s}".absence_types(id),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      start_half VARCHAR(10),
      end_half VARCHAR(10),
      days_count DECIMAL(5,2) NOT NULL,
      reason TEXT,
      justification_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      validation_level INT NOT NULL DEFAULT 0,
      approved_by UUID REFERENCES "${s}".users(id),
      approved_at TIMESTAMPTZ,
      rejection_reason TEXT,
      payroll_impact JSONB,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // job_offers
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".job_offers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      department_id UUID REFERENCES "${s}".departments(id),
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      requirements TEXT,
      contract_type VARCHAR(30),
      location VARCHAR(255),
      remote VARCHAR(20) DEFAULT 'hybrid',
      salary_min DECIMAL(10,2),
      salary_max DECIMAL(10,2),
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      published_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      hiring_manager_id UUID REFERENCES "${s}".employees(id),
      required_by DATE,
      created_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // candidates
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".candidates (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      job_offer_id UUID NOT NULL REFERENCES "${s}".job_offers(id),
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      current_position VARCHAR(200),
      current_company VARCHAR(200),
      cv_url TEXT,
      cover_letter_url TEXT,
      linkedin_url TEXT,
      stage VARCHAR(30) NOT NULL DEFAULT 'new',
      score INTEGER,
      notes TEXT,
      ai_summary TEXT,
      rejection_reason TEXT,
      source VARCHAR(50),
      expected_salary DECIMAL(10,2),
      available_from DATE,
      tags JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // interviews
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".interviews (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      candidate_id UUID NOT NULL REFERENCES "${s}".candidates(id),
      interviewer_id UUID REFERENCES "${s}".employees(id),
      scheduled_at TIMESTAMPTZ NOT NULL,
      duration INTEGER DEFAULT 60,
      type VARCHAR(30) DEFAULT 'video',
      status VARCHAR(20) DEFAULT 'scheduled',
      meeting_url TEXT,
      feedback TEXT,
      rating INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // training_courses
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".training_courses (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      title VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100),
      provider VARCHAR(200),
      format VARCHAR(30) DEFAULT 'in_person',
      duration_hours INTEGER,
      cpf_eligible BOOLEAN DEFAULT false,
      cpf_code VARCHAR(50),
      cost DECIMAL(10,2),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // training_sessions
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".training_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      course_id UUID NOT NULL REFERENCES "${s}".training_courses(id),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      location VARCHAR(255),
      max_participants INTEGER,
      status VARCHAR(20) DEFAULT 'scheduled',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // training_enrollments
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".training_enrollments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id UUID NOT NULL REFERENCES "${s}".training_sessions(id),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      status VARCHAR(20) DEFAULT 'enrolled',
      completed_at TIMESTAMPTZ,
      rating INTEGER,
      feedback TEXT,
      certificate TEXT,
      cpf_hours_used DECIMAL(5,2),
      enrolled_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // expense_reports
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".expense_reports (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      title VARCHAR(255) NOT NULL,
      month VARCHAR(7) NOT NULL,
      total_amount DECIMAL(10,2) DEFAULT 0,
      currency VARCHAR(3) DEFAULT 'EUR',
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      validation_level INT NOT NULL DEFAULT 0,
      submitted_at TIMESTAMPTZ,
      approved_by UUID REFERENCES "${s}".users(id),
      approved_at TIMESTAMPTZ,
      rejection_reason TEXT,
      reimbursed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // expense_lines
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".expense_lines (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      report_id UUID NOT NULL REFERENCES "${s}".expense_reports(id) ON DELETE CASCADE,
      category VARCHAR(50) NOT NULL,
      description VARCHAR(255) NOT NULL,
      date DATE NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'EUR',
      receipt_url TEXT,
      mileage DECIMAL(8,2),
      is_refundable BOOLEAN DEFAULT true,
      ocr_data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // skills
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".skills (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_id UUID NOT NULL REFERENCES "${s}".legal_entities(id),
      name VARCHAR(100) NOT NULL,
      category VARCHAR(50),
      description TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // employee_skills
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".employee_skills (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      skill_id UUID NOT NULL REFERENCES "${s}".skills(id),
      level SMALLINT NOT NULL,
      assessed_at DATE,
      assessed_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // evaluations
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".evaluations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      evaluator_id UUID REFERENCES "${s}".employees(id),
      type VARCHAR(30) NOT NULL DEFAULT 'annual',
      year SMALLINT NOT NULL,
      status VARCHAR(20) DEFAULT 'planned',
      scheduled_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      overall_rating SMALLINT,
      goals_achievement SMALLINT,
      skills_rating JSONB DEFAULT '[]'::jsonb,
      strengths TEXT,
      improvements TEXT,
      next_year_goals JSONB DEFAULT '[]'::jsonb,
      salary_increase_proposed DECIMAL(5,2),
      promotion_proposed BOOLEAN DEFAULT false,
      employee_comments TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // nine_box
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".nine_box (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      year SMALLINT NOT NULL,
      performance_axis SMALLINT NOT NULL,
      potential_axis SMALLINT NOT NULL,
      box SMALLINT NOT NULL,
      notes TEXT,
      created_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // hr_events
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".hr_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID NOT NULL REFERENCES "${s}".employees(id),
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      event_date DATE NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      is_private BOOLEAN DEFAULT false,
      created_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // employee_documents
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".employee_documents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      employee_id UUID REFERENCES "${s}".employees(id),
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      file_url TEXT,
      file_size INTEGER,
      mime_type VARCHAR(100),
      is_confidential BOOLEAN DEFAULT false,
      signed_by_employee BOOLEAN DEFAULT false,
      signed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_by UUID REFERENCES "${s}".users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // notifications
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".notifications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES "${s}".users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT,
      entity_type VARCHAR(50),
      entity_id UUID,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // parameters — generic configurable lists (contract types, expense categories, job levels, etc.)
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".parameters (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      category VARCHAR(50) NOT NULL,
      code VARCHAR(100) NOT NULL,
      label VARCHAR(255) NOT NULL,
      color VARCHAR(20),
      metadata JSONB NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(category, code)
    )
  `)

  // workflow_configs — validation chain configuration per module
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${s}".workflow_configs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      module VARCHAR(50) NOT NULL UNIQUE,
      levels_count INT NOT NULL DEFAULT 1,
      level1_role VARCHAR(50) NOT NULL DEFAULT 'manager',
      level2_role VARCHAR(50),
      level3_role VARCHAR(50),
      level4_role VARCHAR(50),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Seed default workflow configs (1 level for each module)
  await client.query(`
    INSERT INTO "${s}".workflow_configs (module, levels_count, level1_role)
    VALUES ('absences', 1, 'manager'), ('expenses', 1, 'manager')
    ON CONFLICT (module) DO NOTHING
  `)

  // Seed référentiel complet (parameters) — données légales France connues
  await seedDefaultParameters(client, s)
}

type ParamRow = { category: string; code: string; label: string; color?: string; sort_order: number }

/**
 * Insère le référentiel complet dans le schéma tenant.
 * Idempotent — ON CONFLICT DO NOTHING.
 * Appelé à la création du tenant ET comme fallback lazy dans settings.routes.ts.
 */
export async function seedDefaultParameters(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  schemaName: string,
): Promise<void> {
  const s = schemaName

  const defaults: ParamRow[] = [
    // ── Types de contrat ──────────────────────────────────────────────────────
    { category: 'contract_type', code: 'CDI',           label: 'CDI — Contrat à durée indéterminée',            sort_order: 1 },
    { category: 'contract_type', code: 'CDI_CHANTIER',  label: 'CDI de chantier ou d\'opération',               sort_order: 2 },
    { category: 'contract_type', code: 'CDD',           label: 'CDD — Contrat à durée déterminée',              sort_order: 3 },
    { category: 'contract_type', code: 'CDII',          label: 'CDII — CDI Intérimaire',                        sort_order: 4 },
    { category: 'contract_type', code: 'CTT',           label: 'CTT — Contrat de travail temporaire',           sort_order: 5 },
    { category: 'contract_type', code: 'APPRENTISSAGE', label: 'Contrat d\'apprentissage',                      sort_order: 6 },
    { category: 'contract_type', code: 'PRO',           label: 'Contrat de professionnalisation',               sort_order: 7 },
    { category: 'contract_type', code: 'STAGE',         label: 'Convention de stage',                           sort_order: 8 },
    { category: 'contract_type', code: 'PORTAGE',       label: 'Portage salarial',                              sort_order: 9 },
    { category: 'contract_type', code: 'FREELANCE',     label: 'Prestation freelance / Mission',                sort_order: 10 },
    { category: 'contract_type', code: 'VIE',           label: 'VIE — Volontariat International en Entreprise', sort_order: 11 },
    { category: 'contract_type', code: 'MANDAT',        label: 'Mandat social (dirigeant)',                     sort_order: 12 },

    // ── Catégories de frais ───────────────────────────────────────────────────
    { category: 'expense_category', code: 'TRAIN',        label: 'Train / Transports longue distance', color: '#3B82F6', sort_order: 1 },
    { category: 'expense_category', code: 'AVION',        label: 'Billet d\'avion',                    color: '#6366F1', sort_order: 2 },
    { category: 'expense_category', code: 'TAXI_VTC',     label: 'Taxi / VTC',                         color: '#8B5CF6', sort_order: 3 },
    { category: 'expense_category', code: 'TC',           label: 'Transports en commun',               color: '#A78BFA', sort_order: 4 },
    { category: 'expense_category', code: 'IK',           label: 'Indemnités kilométriques',           color: '#10B981', sort_order: 5 },
    { category: 'expense_category', code: 'PARKING',      label: 'Parking / Péage / Location voiture', color: '#059669', sort_order: 6 },
    { category: 'expense_category', code: 'REPAS',        label: 'Repas déjeuner',                     color: '#F59E0B', sort_order: 7 },
    { category: 'expense_category', code: 'REPAS_CLIENT', label: 'Repas client',                       color: '#D97706', sort_order: 8 },
    { category: 'expense_category', code: 'HEBERGEMENT',  label: 'Hôtel / Hébergement',                color: '#EF4444', sort_order: 9 },
    { category: 'expense_category', code: 'CONFERENCE',   label: 'Conférence / Salon',                 color: '#14B8A6', sort_order: 10 },
    { category: 'expense_category', code: 'FORMATION',    label: 'Formation externe',                  color: '#06B6D4', sort_order: 11 },
    { category: 'expense_category', code: 'MATERIEL',     label: 'Matériel informatique',              color: '#64748B', sort_order: 12 },
    { category: 'expense_category', code: 'TELECOM',      label: 'Téléphone / Internet professionnel', color: '#0EA5E9', sort_order: 13 },
    { category: 'expense_category', code: 'CADEAU',       label: 'Cadeaux clients / partenaires',      color: '#F43F5E', sort_order: 14 },
    { category: 'expense_category', code: 'AUTRE',        label: 'Autre frais professionnel',          color: '#9CA3AF', sort_order: 15 },

    // ── Niveaux de poste ──────────────────────────────────────────────────────
    { category: 'job_level', code: 'STAGIAIRE',  label: 'Stagiaire',                    sort_order: 1 },
    { category: 'job_level', code: 'ALTERNANT',  label: 'Alternant / Apprenti',         sort_order: 2 },
    { category: 'job_level', code: 'JUNIOR',     label: 'Junior (0–2 ans)',             sort_order: 3 },
    { category: 'job_level', code: 'CONFIRME',   label: 'Confirmé (2–5 ans)',           sort_order: 4 },
    { category: 'job_level', code: 'SENIOR',     label: 'Senior (5–8 ans)',             sort_order: 5 },
    { category: 'job_level', code: 'EXPERT',     label: 'Expert / Lead',                sort_order: 6 },
    { category: 'job_level', code: 'PRINCIPAL',  label: 'Principal / Staff',            sort_order: 7 },
    { category: 'job_level', code: 'MANAGER',    label: 'Manager (encadrant)',          sort_order: 8 },
    { category: 'job_level', code: 'SR_MANAGER', label: 'Senior Manager',              sort_order: 9 },
    { category: 'job_level', code: 'DIRECTEUR',  label: 'Directeur',                   sort_order: 10 },
    { category: 'job_level', code: 'SR_DIR',     label: 'Directeur Senior / VP',       sort_order: 11 },
    { category: 'job_level', code: 'C_LEVEL',    label: 'C-Level (PDG, DRH, DAF…)',   sort_order: 12 },
    // Niveaux SYNTEC (grille CCN 1486)
    { category: 'job_level', code: 'SYNTEC_1_1', label: '[SYNTEC] Position 1.1 — Employé',          sort_order: 20 },
    { category: 'job_level', code: 'SYNTEC_1_2', label: '[SYNTEC] Position 1.2 — Employé',          sort_order: 21 },
    { category: 'job_level', code: 'SYNTEC_2_1', label: '[SYNTEC] Position 2.1 — Technicien',       sort_order: 22 },
    { category: 'job_level', code: 'SYNTEC_2_2', label: '[SYNTEC] Position 2.2 — Technicien',       sort_order: 23 },
    { category: 'job_level', code: 'SYNTEC_2_3', label: '[SYNTEC] Position 2.3 — Technicien',       sort_order: 24 },
    { category: 'job_level', code: 'SYNTEC_3_1', label: '[SYNTEC] Position 3.1 — Cadre',            sort_order: 25 },
    { category: 'job_level', code: 'SYNTEC_3_2', label: '[SYNTEC] Position 3.2 — Cadre supérieur',  sort_order: 26 },
    { category: 'job_level', code: 'SYNTEC_3_3', label: '[SYNTEC] Position 3.3 — Directeur',        sort_order: 27 },

    // ── Catégories de formation ───────────────────────────────────────────────
    { category: 'training_category', code: 'DEV_LOGICIEL', label: 'Développement logiciel & Web',              sort_order: 1 },
    { category: 'training_category', code: 'INFRA_CLOUD',  label: 'Infrastructure, Cloud & DevOps',            sort_order: 2 },
    { category: 'training_category', code: 'DATA_AI',      label: 'Data, IA & Machine Learning',               sort_order: 3 },
    { category: 'training_category', code: 'CYBERSEC',     label: 'Cybersécurité & Sécurité informatique',     sort_order: 4 },
    { category: 'training_category', code: 'MANAGEMENT',   label: 'Management & Leadership',                   sort_order: 5 },
    { category: 'training_category', code: 'AGILE',        label: 'Méthodes Agile & Gestion de projet',        sort_order: 6 },
    { category: 'training_category', code: 'COMMERCIAL',   label: 'Vente, Commercial & Négociation',           sort_order: 7 },
    { category: 'training_category', code: 'MARKETING',    label: 'Marketing, Communication & Digital',        sort_order: 8 },
    { category: 'training_category', code: 'FINANCE',      label: 'Finance, Comptabilité & Fiscalité',         sort_order: 9 },
    { category: 'training_category', code: 'RH_DROIT',     label: 'Ressources Humaines & Droit social',        sort_order: 10 },
    { category: 'training_category', code: 'JURIDIQUE',    label: 'Juridique, RGPD & Conformité',              sort_order: 11 },
    { category: 'training_category', code: 'BUREAUTIQUE',  label: 'Bureautique & Outils collaboratifs',        sort_order: 12 },
    { category: 'training_category', code: 'LANGUES',      label: 'Langues étrangères',                        sort_order: 13 },
    { category: 'training_category', code: 'SECURITE_SITE',label: 'Sécurité, QHSE & Prévention des risques',   sort_order: 14 },
    { category: 'training_category', code: 'DEV_PERSO',    label: 'Développement personnel & Soft skills',     sort_order: 15 },
    { category: 'training_category', code: 'SANTE_WORK',   label: 'Santé au travail & Bien-être',              sort_order: 16 },
    { category: 'training_category', code: 'RSE',          label: 'RSE & Développement durable',               sort_order: 17 },
    { category: 'training_category', code: 'AUTRE_FORM',   label: 'Autre',                                     sort_order: 99 },

    // ── Conventions collectives (IDCC — France) ───────────────────────────────
    { category: 'collective_agreement', code: 'SYNTEC',        label: 'SYNTEC — Bureaux d\'études et informatique (IDCC 1486)',                                     sort_order: 1 },
    { category: 'collective_agreement', code: 'METALLURGIE',   label: 'Métallurgie (IDCC 3248)',                                                                    sort_order: 2 },
    { category: 'collective_agreement', code: 'BTP_OUVRIERS',  label: 'Bâtiment — Ouvriers (IDCC 1596/1597)',                                                      sort_order: 3 },
    { category: 'collective_agreement', code: 'BTP_ETAM',      label: 'Bâtiment — ETAM (IDCC 2609)',                                                               sort_order: 4 },
    { category: 'collective_agreement', code: 'COMMERCE',      label: 'Commerce de détail non alimentaire (IDCC 1517)',                                             sort_order: 5 },
    { category: 'collective_agreement', code: 'BANQUE',        label: 'Banque (IDCC 2120)',                                                                         sort_order: 6 },
    { category: 'collective_agreement', code: 'ASSURANCE',     label: 'Assurance (IDCC 1672)',                                                                      sort_order: 7 },
    { category: 'collective_agreement', code: 'TRANSPORT',     label: 'Transport routier et logistique (IDCC 16)',                                                  sort_order: 8 },
    { category: 'collective_agreement', code: 'HCR',           label: 'Hôtellerie, Cafés, Restaurants (IDCC 3292)',                                                 sort_order: 9 },
    { category: 'collective_agreement', code: 'PHARMACIE',     label: 'Pharmacie de ville (IDCC 1996)',                                                             sort_order: 10 },
    { category: 'collective_agreement', code: 'CHIMIE',        label: 'Industrie chimique (IDCC 44)',                                                               sort_order: 11 },
    { category: 'collective_agreement', code: 'PLASTURGIE',    label: 'Plasturgie (IDCC 292)',                                                                      sort_order: 12 },
    { category: 'collective_agreement', code: 'SANTE_PRIV',    label: 'Hospitalisation privée / Cliniques (IDCC 0651)',                                             sort_order: 13 },
    { category: 'collective_agreement', code: 'AIDE_DOMICILE', label: 'Aide à domicile (IDCC 2941)',                                                               sort_order: 14 },
    { category: 'collective_agreement', code: 'GRANDE_DISTRIB',label: 'Commerce de gros et grande distribution alimentaire (IDCC 1505)',                           sort_order: 15 },
    { category: 'collective_agreement', code: 'IMMOBILIER',    label: 'Immobilier (IDCC 1527)',                                                                     sort_order: 16 },
    { category: 'collective_agreement', code: 'NOTARIAT',      label: 'Notariat (IDCC 31)',                                                                         sort_order: 17 },
    { category: 'collective_agreement', code: 'AVOCATS',       label: 'Avocats salariés (IDCC 1850)',                                                               sort_order: 18 },
    { category: 'collective_agreement', code: 'EXPERTISE_CPT', label: 'Cabinets d\'experts-comptables (IDCC 787)',                                                  sort_order: 19 },
    { category: 'collective_agreement', code: 'AUDIT',         label: 'Bureaux d\'études techniques (même CCN SYNTEC IDCC 1486)',                                   sort_order: 20 },
    { category: 'collective_agreement', code: 'ANIMATION',     label: 'Animation (IDCC 1518)',                                                                      sort_order: 21 },
    { category: 'collective_agreement', code: 'SPORT',         label: 'Sport (IDCC 2511)',                                                                          sort_order: 22 },
    { category: 'collective_agreement', code: 'SECURITE_PRIV', label: 'Prévention et sécurité privée (IDCC 1351)',                                                  sort_order: 23 },
    { category: 'collective_agreement', code: 'NETTOYAGE',     label: 'Nettoyage de locaux (IDCC 3043)',                                                            sort_order: 24 },
    { category: 'collective_agreement', code: 'AGRICULTURE',   label: 'Production agricole (IDCC 7018 national)',                                                   sort_order: 25 },
    { category: 'collective_agreement', code: 'PRESSE',        label: 'Presse quotidienne / Journalistes (IDCC 1480)',                                              sort_order: 26 },
    { category: 'collective_agreement', code: 'EDITION',       label: 'Édition (IDCC 2121)',                                                                        sort_order: 27 },
    { category: 'collective_agreement', code: 'AUDIOVISUEL',   label: 'Audiovisuel, production (IDCC 2642)',                                                        sort_order: 28 },
    { category: 'collective_agreement', code: 'SANS_CCN',      label: 'Sans convention collective applicable',                                                      sort_order: 99 },

    // ── Motifs de fin de contrat (pour les documents RH) ─────────────────────
    { category: 'termination_reason', code: 'DEMISSION',       label: 'Démission',                                                                                 sort_order: 1 },
    { category: 'termination_reason', code: 'LIC_PERSO',       label: 'Licenciement pour motif personnel',                                                         sort_order: 2 },
    { category: 'termination_reason', code: 'LIC_FAUTE',       label: 'Licenciement pour faute grave / lourde',                                                    sort_order: 3 },
    { category: 'termination_reason', code: 'LIC_INAPTITUDE',  label: 'Licenciement pour inaptitude',                                                              sort_order: 4 },
    { category: 'termination_reason', code: 'LIC_ECO',         label: 'Licenciement économique',                                                                   sort_order: 5 },
    { category: 'termination_reason', code: 'RUPTURE_CONV',    label: 'Rupture conventionnelle',                                                                   sort_order: 6 },
    { category: 'termination_reason', code: 'RETRAITE',        label: 'Départ en retraite',                                                                        sort_order: 7 },
    { category: 'termination_reason', code: 'MISE_RETRAITE',   label: 'Mise à la retraite (par l\'employeur)',                                                     sort_order: 8 },
    { category: 'termination_reason', code: 'FIN_CDD',         label: 'Fin de CDD — terme du contrat',                                                             sort_order: 9 },
    { category: 'termination_reason', code: 'RUPTURE_ESSAI',   label: 'Rupture de période d\'essai',                                                               sort_order: 10 },
    { category: 'termination_reason', code: 'DECES',           label: 'Décès du salarié',                                                                          sort_order: 11 },
    { category: 'termination_reason', code: 'INVALIDITE',      label: 'Invalidité 2e/3e catégorie',                                                                sort_order: 12 },
    { category: 'termination_reason', code: 'TRANSFERT',       label: 'Transfert vers une autre entité du groupe',                                                 sort_order: 13 },
    { category: 'termination_reason', code: 'AUTRE_FIN',       label: 'Autre motif',                                                                               sort_order: 99 },

    // ── Secteurs d'activité (NAF/APE) ─────────────────────────────────────────
    { category: 'sector', code: 'INFORMATIQUE', label: 'Informatique, logiciels, services numériques (62)', sort_order: 1 },
    { category: 'sector', code: 'CONSEIL',      label: 'Conseil de gestion, consulting (70)',               sort_order: 2 },
    { category: 'sector', code: 'INDUSTRIE',    label: 'Industrie manufacturière (10–33)',                  sort_order: 3 },
    { category: 'sector', code: 'BTP',          label: 'Construction & BTP (41–43)',                       sort_order: 4 },
    { category: 'sector', code: 'COMMERCE',     label: 'Commerce de gros / détail (45–47)',                sort_order: 5 },
    { category: 'sector', code: 'TRANSPORT',    label: 'Transport & Entreposage (49–53)',                  sort_order: 6 },
    { category: 'sector', code: 'HCR',          label: 'Hôtellerie & Restauration (55–56)',                sort_order: 7 },
    { category: 'sector', code: 'MEDIA',        label: 'Information & Communication (58–63)',              sort_order: 8 },
    { category: 'sector', code: 'FINANCE',      label: 'Finance, Banque & Assurance (64–66)',              sort_order: 9 },
    { category: 'sector', code: 'IMMOBILIER',   label: 'Immobilier (68)',                                  sort_order: 10 },
    { category: 'sector', code: 'SANTE',        label: 'Santé humaine & Action sociale (86–88)',           sort_order: 11 },
    { category: 'sector', code: 'EDUCATION',    label: 'Enseignement (85)',                                sort_order: 12 },
    { category: 'sector', code: 'AGRICULTURE',  label: 'Agriculture, sylviculture & pêche (01–03)',        sort_order: 13 },
    { category: 'sector', code: 'ENERGIE',      label: 'Énergie, eau, déchets (35–39)',                   sort_order: 14 },
    { category: 'sector', code: 'LUXE',         label: 'Luxe, mode & création',                           sort_order: 15 },
    { category: 'sector', code: 'PHARMACEUT',   label: 'Pharmacie & Biotechnologies (21)',                sort_order: 16 },
    { category: 'sector', code: 'SECURITE',     label: 'Services de sécurité & gardiennage (80)',         sort_order: 17 },
    { category: 'sector', code: 'NETTOYAGE',    label: 'Services de nettoyage (81)',                      sort_order: 18 },
    { category: 'sector', code: 'AUTRE',        label: 'Autre secteur',                                   sort_order: 99 },
  ]

  for (const p of defaults) {
    await client.query(
      `INSERT INTO "${s}".parameters (category, code, label, color, sort_order)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (category, code) DO NOTHING`,
      [p.category, p.code, p.label, p.color ?? null, p.sort_order],
    )
  }
}

/**
 * Hash a password using bcrypt (12 rounds).
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}
