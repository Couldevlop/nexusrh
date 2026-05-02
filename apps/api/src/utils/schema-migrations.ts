/**
 * Lazy migrations — colonnes ajoutées au schéma Drizzle après la création initiale des tables.
 * Appelées en début de handler pour garantir que la structure est à jour sans redéploiement.
 * Idempotentes : ADD COLUMN IF NOT EXISTS.
 */
import { Pool } from 'pg'
import { config } from '../config'

const pool = new Pool({ connectionString: config.database.url })

// Cache par schema pour éviter les ALTER à chaque requête
const migratedSchemas = new Set<string>()

export async function ensureTenantSchema(schemaName: string): Promise<void> {
  if (!schemaName || migratedSchemas.has(schemaName)) return

  const alters = [
    // ── employees ──────────────────────────────────────────────────────────
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS user_id uuid`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS employee_number varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS profile_type varchar(30) DEFAULT 'employee'`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS birth_place varchar(100)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS social_security_number varchar(255)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS iban varchar(255)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS bic varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS job_level varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS has_disability boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS retention_score numeric(3,2)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS burnout_risk varchar(10)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS ai_score_updated_at timestamptz`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS ai_score_factors jsonb DEFAULT '[]'`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS custom_fields jsonb DEFAULT '{}'`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,

    // ── contracts ──────────────────────────────────────────────────────────
    `ALTER TABLE "${schemaName}".contracts ADD COLUMN IF NOT EXISTS non_competition_clause boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".contracts ADD COLUMN IF NOT EXISTS telecommuting_days integer DEFAULT 0`,
    `ALTER TABLE "${schemaName}".contracts ADD COLUMN IF NOT EXISTS signature_status varchar(30)`,
    `ALTER TABLE "${schemaName}".contracts ADD COLUMN IF NOT EXISTS signature_request_id varchar(255)`,
    `ALTER TABLE "${schemaName}".contracts ADD COLUMN IF NOT EXISTS working_hours_per_week varchar(10)`,
    `ALTER TABLE "${schemaName}".contracts ADD COLUMN IF NOT EXISTS salary_basis varchar(20) DEFAULT 'monthly'`,

    // ── evaluations ────────────────────────────────────────────────────────
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS evaluator_id uuid`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS evaluator_user_id uuid`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS scheduled_at timestamptz`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS completed_at timestamptz`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS overall_rating smallint`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS goals_achievement smallint`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS skills_rating jsonb DEFAULT '[]'`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS strengths text`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS improvements text`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS next_year_goals jsonb DEFAULT '[]'`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS salary_increase_proposed numeric(5,2)`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS promotion_proposed boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS target_job_title varchar(200)`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS career_project_discussed boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS training_needs_identified boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS cpf_information_provided boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS qualifications_discussed boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS employability_discussed boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS six_year_criteria_formation boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS six_year_criteria_certification boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS six_year_criteria_progression boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS cpf_abondement_required boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS employee_comments text`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS manager_comments text`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS hr_comments text`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS signed_by_employee boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS employee_signed_at timestamptz`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS signed_by_manager boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS manager_signed_at timestamptz`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS invitation_sent_at timestamptz`,

    // ── absences ───────────────────────────────────────────────────────────
    `ALTER TABLE "${schemaName}".absences ADD COLUMN IF NOT EXISTS validation_level int NOT NULL DEFAULT 0`,

    // ── expenses ───────────────────────────────────────────────────────────
    `ALTER TABLE "${schemaName}".expenses ADD COLUMN IF NOT EXISTS validation_level int NOT NULL DEFAULT 0`,
  ]

  for (const sql of alters) {
    await pool.query(sql).catch(() => undefined)
  }

  // workflow_configs — table pour les niveaux de validation (absences + frais)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      module VARCHAR(50) NOT NULL UNIQUE,
      levels_count INT NOT NULL DEFAULT 1,
      level1_role VARCHAR(50) NOT NULL DEFAULT 'manager',
      level2_role VARCHAR(50), level3_role VARCHAR(50), level4_role VARCHAR(50),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => undefined)

  await pool.query(`
    INSERT INTO "${schemaName}".workflow_configs (module, levels_count, level1_role)
    VALUES ('absences', 1, 'manager'), ('expenses', 1, 'manager')
    ON CONFLICT (module) DO NOTHING
  `).catch(() => undefined)

  migratedSchemas.add(schemaName)
}
