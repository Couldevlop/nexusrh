import { assertValidSchemaName } from './schema-name.js'
import { onboardingTableStatements } from '../db/onboarding-tables.js'
import { pool } from '../db/pool.js'

const migratedSchemas = new Set<string>()

/**
 * Applique les migrations lazy sur un schéma tenant (idempotent)
 * Appelé en preHandler de chaque route pour garantir les colonnes CI
 */
export async function ensureTenantSchema(schemaName: string): Promise<void> {
  if (!schemaName || migratedSchemas.has(schemaName)) return
  // OWASP A03 — schemaName interpolé dans 170+ ALTER TABLE : valider avant la boucle.
  assertValidSchemaName(schemaName)

  const alters = [
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS nni varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS cnps_number varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS mobile_money_provider varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS mobile_money_phone varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS marital_status varchar(20)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS children_count int DEFAULT 0`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS city varchar(100) DEFAULT 'Abidjan'`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS user_id uuid`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS profile_photo_url text`,
    // Dossier salarié complet : temps de travail, catégorie conventionnelle, RIB
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS weekly_hours numeric(4,1) DEFAULT 40`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS professional_category varchar(50)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS iban varchar(255)`,
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS bank_name varchar(100)`,
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
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS indemnite_absence numeric(12,0) DEFAULT 0`,
    `ALTER TABLE "${schemaName}".pay_slips ADD COLUMN IF NOT EXISTS bordereau_cnps jsonb`,
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
    `ALTER TABLE "${schemaName}".legal_entities    ADD COLUMN IF NOT EXISTS country_code varchar(3) NOT NULL DEFAULT 'CIV'`,
    `ALTER TABLE "${schemaName}".legal_entities    ADD COLUMN IF NOT EXISTS legislation_pack_code varchar(20)`,
    `ALTER TABLE "${schemaName}".employees         ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE "${schemaName}".pay_slips         ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE "${schemaName}".cnps_declarations ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE "${schemaName}".disa_records      ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    // Workflow paie centralisé multi-sites (draft_central → … → closed).
    // Ces colonnes étaient seulement créées au provisionnement : sans elles, un
    // ancien tenant basculé en multi-pays renvoyait des 500 (colonnes absentes).
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS parent_period_id uuid`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS legislation_pack_code varchar(20)`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS raf_user_id uuid`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS sent_to_sites_at timestamptz`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS completed_by_site_at timestamptz`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS validated_central_at timestamptz`,
    `ALTER TABLE "${schemaName}".pay_periods       ADD COLUMN IF NOT EXISTS validated_by uuid`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_pay_slips_le_idx"    ON "${schemaName}".pay_slips(legal_entity_id)`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_cnps_decl_le_idx"    ON "${schemaName}".cnps_declarations(legal_entity_id)`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_disa_records_le_idx" ON "${schemaName}".disa_records(legal_entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${schemaName}_pp_parent ON "${schemaName}".pay_periods(parent_period_id) WHERE parent_period_id IS NOT NULL`,
    // Bascule de la clé d'unicité paie : UNIQUE(month) plein → (month, legal_entity_id)
    // NULLS NOT DISTINCT. Indispensable pour insérer parent + déclinaisons site
    // (même mois). Mono-pays : comportement inchangé (legal_entity_id NULL unique/mois).
    `ALTER TABLE "${schemaName}".pay_periods DROP CONSTRAINT IF EXISTS pay_periods_month_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${schemaName}_pp_month_le ON "${schemaName}".pay_periods (month, legal_entity_id) NULLS NOT DISTINCT`,

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

    // ── Cycle de vie du mot de passe (durée de vie + historique anti-réutilisation) ──
    // password_changed_at : backfill = now() sur les lignes existantes (NOT NULL
    // DEFAULT now()) pour ne PAS expirer immédiatement les comptes hérités.
    `ALTER TABLE "${schemaName}".users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now()`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".password_history (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL,
      password_hash varchar(255) NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_pwd_hist_user_idx" ON "${schemaName}".password_history(user_id, created_at DESC)`,

    // ── Config IA par tenant (clé API chiffrée + modèle, OWASP A02) ──────────
    // Clés stockées chiffrées (AES-256-GCM). NULL → repli sur la clé plateforme (env).
    `CREATE TABLE IF NOT EXISTS "${schemaName}".ai_settings (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      claude_api_key_enc  text,
      claude_model        varchar(100),
      mistral_api_key_enc text,
      mistral_model       varchar(100),
      preferred_provider  varchar(20) NOT NULL DEFAULT 'claude',
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )`,

    // ── Connectivité : intégrations tenant (webhooks / clés API / connecteurs) ──
    `CREATE TABLE IF NOT EXISTS "${schemaName}".integration_webhooks (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name         varchar(150) NOT NULL,
      target_url   text NOT NULL,
      secret_enc   text NOT NULL,
      events       text[] NOT NULL DEFAULT '{}',
      headers      jsonb NOT NULL DEFAULT '{}',
      is_active    boolean NOT NULL DEFAULT true,
      created_by   uuid,
      last_delivery_at timestamptz,
      last_status  int,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".integration_api_keys (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name         varchar(150) NOT NULL,
      key_prefix   varchar(40) NOT NULL,
      key_hash     varchar(128) NOT NULL UNIQUE,
      scopes       text[] NOT NULL DEFAULT '{}',
      is_active    boolean NOT NULL DEFAULT true,
      created_by   uuid,
      last_used_at timestamptz,
      expires_at   timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_api_keys_hash_idx" ON "${schemaName}".integration_api_keys(key_hash) WHERE is_active`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".integration_connectors (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name         varchar(150) NOT NULL,
      base_url     text NOT NULL,
      auth_type    varchar(20) NOT NULL DEFAULT 'none',
      auth_secret_enc text,
      auth_header_name varchar(80),
      default_headers  jsonb NOT NULL DEFAULT '{}',
      is_active    boolean NOT NULL DEFAULT true,
      created_by   uuid,
      last_test_at timestamptz,
      last_test_status int,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".webhook_deliveries (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      webhook_id  uuid NOT NULL,
      event       varchar(80) NOT NULL,
      status      int,
      ok          boolean NOT NULL DEFAULT false,
      attempt     int NOT NULL DEFAULT 1,
      response_excerpt text,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_wh_deliveries_idx" ON "${schemaName}".webhook_deliveries(webhook_id, created_at DESC)`,

    // ── Parcours d'intégration (onboarding) — DDL partagé avec provisioning ──
    ...onboardingTableStatements(schemaName),
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

    // ── Politique de sécurité paramétrable (super_admin) ──────────────────────
    // La table platform_settings peut déjà exister (créée en lazy par les routes
    // platform). On garantit ici la présence des colonnes de politique sécurité.
    `CREATE TABLE IF NOT EXISTS platform.platform_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS mfa_required_super_admin boolean NOT NULL DEFAULT false`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS mfa_required_tenant_users boolean NOT NULL DEFAULT false`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS password_max_age_days int NOT NULL DEFAULT 30`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS password_history_count int NOT NULL DEFAULT 5`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS breach_check_enabled boolean NOT NULL DEFAULT true`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS lockout_enabled boolean NOT NULL DEFAULT true`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS lockout_max_attempts int NOT NULL DEFAULT 5`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS lockout_window_minutes int NOT NULL DEFAULT 15`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS lockout_duration_minutes int NOT NULL DEFAULT 15`,

    // ── Mise hors ligne (tenant / cabinet) avec message configurable ──────────
    // Variable système : message hors-ligne par défaut + caractère obligatoire.
    // Le message effectif est stocké sur le tenant/cabinet au moment de la
    // suspension (offline_message) et affiché aux utilisateurs bloqués.
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS offline_message_default text NOT NULL DEFAULT 'Ce site est temporairement hors service. Veuillez contacter votre administrateur.'`,
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS offline_message_required boolean NOT NULL DEFAULT true`,
    `ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS offline_message text`,

    // ── Singleton : une SEULE ligne de configuration plateforme ───────────────
    // Corrige un bug historique : les routes faisaient `INSERT ... DEFAULT VALUES
    // ON CONFLICT DO NOTHING` sans contrainte d'unicité → une nouvelle ligne à
    // chaque PATCH, et `SELECT ... LIMIT 1` (sans ORDER BY) lisait la politique de
    // sécurité (MFA, lockout, mdp) de façon non déterministe.
    `ALTER TABLE platform.platform_settings ADD COLUMN IF NOT EXISTS singleton boolean NOT NULL DEFAULT true`,
    // Dédoublonnage : ne conserver que la ligne la plus ancienne (avant l'index unique).
    `DELETE FROM platform.platform_settings WHERE id NOT IN (
       SELECT id FROM platform.platform_settings ORDER BY created_at ASC, id ASC LIMIT 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_singleton_idx ON platform.platform_settings(singleton)`,
    // Garantir la présence de l'unique ligne (défauts de politique).
    `INSERT INTO platform.platform_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`,

    // ── Surcharge MFA durcissante par tenant (ne peut qu'imposer le MFA) ──────
    `ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false`,

    // ── Cycle de vie du mot de passe côté super_admin ─────────────────────────
    `ALTER TABLE platform.platform_users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now()`,
    `CREATE TABLE IF NOT EXISTS platform.password_history (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL,
      password_hash varchar(255) NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS platform_pwd_hist_user_idx ON platform.password_history(user_id, created_at DESC)`,

    // ── Cabinets de recrutement (acteur multi-tenant, CI uniquement) ──────────
    // Tables isolées dans le schema platform — aucun schema tenant n'est touché.
    // Idempotent : exécuté au boot pour les bases déjà provisionnées.
    `CREATE TABLE IF NOT EXISTS platform.agencies (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug          varchar(63) NOT NULL UNIQUE,
      name          varchar(255) NOT NULL,
      status        varchar(20) NOT NULL DEFAULT 'active',
      country_code  varchar(3) NOT NULL DEFAULT 'CIV',
      city          varchar(100),
      contact_email varchar(255),
      contact_phone varchar(30),
      primary_color varchar(7) DEFAULT '#1D4ED8',
      logo_url      text,
      created_by    uuid,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`,
    // Expéditeur email fourni par le cabinet : utilisé pour les invitations des
    // tenants/utilisateurs créés par CE cabinet. (Cabinets + tenants créés par le
    // super_admin utilisent l'expéditeur OpenLab par défaut.)
    `ALTER TABLE platform.agencies ADD COLUMN IF NOT EXISTS sender_email varchar(255)`,
    `ALTER TABLE platform.agencies ADD COLUMN IF NOT EXISTS sender_name varchar(150)`,
    // Message affiché aux utilisateurs d'un cabinet mis hors ligne.
    `ALTER TABLE platform.agencies ADD COLUMN IF NOT EXISTS offline_message text`,
    `CREATE TABLE IF NOT EXISTS platform.agency_users (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_id           uuid NOT NULL REFERENCES platform.agencies(id) ON DELETE CASCADE,
      email               varchar(255) NOT NULL UNIQUE,
      password_hash       varchar(255) NOT NULL,
      first_name          varchar(100) NOT NULL,
      last_name           varchar(100) NOT NULL,
      role                varchar(20) NOT NULL DEFAULT 'agency_member',
      is_active           boolean NOT NULL DEFAULT true,
      mfa_enabled         boolean NOT NULL DEFAULT false,
      mfa_secret          varchar(255),
      password_changed_at timestamptz NOT NULL DEFAULT now(),
      last_login_at       timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agency_users_agency ON platform.agency_users(agency_id)`,
    `CREATE TABLE IF NOT EXISTS platform.agency_tenants (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_id   uuid NOT NULL REFERENCES platform.agencies(id) ON DELETE CASCADE,
      tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
      assigned_by uuid,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      detached_at timestamptz,
      UNIQUE (agency_id, tenant_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agency_tenants_agency ON platform.agency_tenants(agency_id) WHERE detached_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_agency_tenants_tenant ON platform.agency_tenants(tenant_id) WHERE detached_at IS NULL`,

    // ── Logos (tenants + cabinets) en base, servis par endpoint public ────────
    // Pattern CV recrutement (bytea). logo_url pointe vers /public/brand/{id}.
    `CREATE TABLE IF NOT EXISTS platform.brand_assets (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mime       varchar(100) NOT NULL,
      bytes      bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ]
  for (const sql of alters) {
    await pool.query(sql).catch(() => undefined)
  }
  platformMigrated = true
}
