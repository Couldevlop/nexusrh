import { Pool } from 'pg'
import { config } from '../config.js'

const pool = new Pool({ connectionString: config.database.url })
const migratedSchemas = new Set<string>()

/**
 * Applique les migrations lazy sur un schéma tenant (idempotent)
 * Appelé en preHandler de chaque route pour garantir les colonnes CI
 */
export async function ensureTenantSchema(schemaName: string): Promise<void> {
  if (!schemaName || migratedSchemas.has(schemaName)) return

  const alters = [
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS nni varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS cnps_number varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS mobile_money_provider varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS mobile_money_phone varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS marital_status varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS children_count int DEFAULT 0`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS city varchar(100) DEFAULT 'Abidjan'`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS user_id uuid`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS retention_score numeric(3,2)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS burnout_risk varchar(10)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS ai_score_factors jsonb DEFAULT '[]'`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS cnps_retraite_sal numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS cnps_retraite_pat numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS cnps_pf_pat numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS cnps_at_pat numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS total_cnps_sal numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS total_cnps_pat numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS its numeric(10,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS payment_method varchar(30) DEFAULT 'mobile_money'`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS payment_status varchar(20) DEFAULT 'pending'`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS payment_reference varchar(100)`,
    `ALTER TABLE "${schemaName}".absences ADD COLUMN IF NOT EXISTS validation_level int NOT NULL DEFAULT 0`,
    `ALTER TABLE "${schemaName}".expense_reports ADD COLUMN IF NOT EXISTS validation_level int NOT NULL DEFAULT 0`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS evaluator_id uuid`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS signed_by_employee boolean DEFAULT false`,
    `ALTER TABLE "${schemaName}".evaluations ADD COLUMN IF NOT EXISTS signed_by_manager boolean DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_configs (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      module       varchar(30) NOT NULL UNIQUE,
      levels_count int NOT NULL DEFAULT 1,
      config       jsonb DEFAULT '{}',
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `INSERT INTO "${schemaName}".workflow_configs (module, levels_count)
     VALUES ('absences', 1), ('expenses', 1)
     ON CONFLICT (module) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".mobile_money_payments (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pay_slip_id   uuid,
      employee_id   uuid NOT NULL,
      amount        numeric(12,0) NOT NULL,
      currency      varchar(3) DEFAULT 'XOF',
      provider      varchar(20) NOT NULL,
      phone_number  varchar(20) NOT NULL,
      reference     varchar(100),
      external_ref  varchar(200),
      status        varchar(20) DEFAULT 'pending',
      error_message text,
      initiated_at  timestamptz,
      confirmed_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".cnps_declarations (
      id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      month                        varchar(7),
      year                         int,
      quarter                      int,
      months                       jsonb DEFAULT '[]',
      status                       varchar(20) DEFAULT 'draft',
      total_salaries               numeric(14,0) DEFAULT 0,
      total_cnps_sal               numeric(12,0) DEFAULT 0,
      total_cnps_pat               numeric(12,0) DEFAULT 0,
      total_cotisations_salariales numeric(12,0) DEFAULT 0,
      total_cotisations_patronales numeric(12,0) DEFAULT 0,
      total_cotisations            numeric(12,0) DEFAULT 0,
      masse_salariale              numeric(14,0) DEFAULT 0,
      employee_count               int DEFAULT 0,
      employees_count              int DEFAULT 0,
      data                         jsonb DEFAULT '[]',
      export_url                   text,
      submitted_at                 timestamptz,
      submitted_by                 uuid,
      due_date                     date,
      created_at                   timestamptz NOT NULL DEFAULT now(),
      updated_at                   timestamptz NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS year int`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS quarter int`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS months jsonb DEFAULT '[]'`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS total_cotisations_salariales numeric(12,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS total_cotisations_patronales numeric(12,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS total_cotisations numeric(12,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS masse_salariale numeric(14,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS employees_count int DEFAULT 0`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS data jsonb DEFAULT '[]'`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS submitted_by uuid`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS paid_at timestamptz`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".disa_records (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      year           int NOT NULL,
      employee_id    uuid NOT NULL,
      nni            varchar(50),
      cnps_number    varchar(50),
      first_name     varchar(100) NOT NULL,
      last_name      varchar(100) NOT NULL,
      annual_gross   numeric(14,0) NOT NULL DEFAULT 0,
      annual_cnps_sal numeric(12,0) DEFAULT 0,
      annual_its     numeric(12,0) DEFAULT 0,
      status         varchar(20) DEFAULT 'draft',
      export_url     text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE(year, employee_id)
    )`,
    // ── Multi-filiales (Palier 3) : scope par legal_entity_id ──
    // Permet la clôture paie / déclarations CNPS / DISA scopées à une filiale
    // pour les tenants has_subsidiaries=true. Backward compat : NULL = mono-filiale.
    `ALTER TABLE "${schemaName}".legal_entities    ADD COLUMN IF NOT EXISTS raf_user_id uuid`,
    `ALTER TABLE "${schemaName}".pay_slips         ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS legislation_pack_code varchar(30)`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE "${schemaName}".disa_records      ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_pay_slips_le_idx"    ON "${schemaName}".pay_slips(legal_entity_id)`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_cnps_decl_le_idx"    ON "${schemaName}".cnps_declarations(legal_entity_id)`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_disa_records_le_idx" ON "${schemaName}".disa_records(legal_entity_id)`,

    // ── Auth : reset password tokens (TTL 15 min, usage unique) ──
    `CREATE TABLE IF NOT EXISTS "${schemaName}".password_reset_tokens (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL,
      token_hash   varchar(128) NOT NULL UNIQUE,
      expires_at   timestamptz NOT NULL,
      used_at      timestamptz,
      requested_ip varchar(45),
      created_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_prt_user_idx" ON "${schemaName}".password_reset_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_prt_expires_idx" ON "${schemaName}".password_reset_tokens(expires_at)`,

    // ── Auth : MFA backup codes (10 codes hashés bcrypt, usage unique) ──
    `CREATE TABLE IF NOT EXISTS "${schemaName}".mfa_backup_codes (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL,
      code_hash   varchar(128) NOT NULL,
      used_at     timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_mbc_user_idx" ON "${schemaName}".mfa_backup_codes(user_id)`,
  ]

  for (const sql of alters) {
    await pool.query(sql).catch(() => undefined)
  }

  migratedSchemas.add(schemaName)
}

let platformMigrated = false

/**
 * Migrations lazy spécifiques au schéma platform (super_admin / multi-tenant).
 * Idempotent. Appelé au boot ou en lazy depuis les routes auth.
 */
export async function ensurePlatformSchema(): Promise<void> {
  if (platformMigrated) return

  const alters = [
    `CREATE TABLE IF NOT EXISTS platform.password_reset_tokens (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL,
      token_hash   varchar(128) NOT NULL UNIQUE,
      expires_at   timestamptz NOT NULL,
      used_at      timestamptz,
      requested_ip varchar(45),
      created_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS platform_prt_user_idx ON platform.password_reset_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS platform_prt_expires_idx ON platform.password_reset_tokens(expires_at)`,
    `CREATE TABLE IF NOT EXISTS platform.mfa_backup_codes (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL,
      code_hash   varchar(128) NOT NULL,
      used_at     timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS platform_mbc_user_idx ON platform.mfa_backup_codes(user_id)`,
  ]
  for (const sql of alters) {
    await pool.query(sql).catch(() => undefined)
  }
  platformMigrated = true
}
