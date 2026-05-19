import { Pool } from 'pg'
import { config } from '../config.js'

const pool = new Pool({ connectionString: config.database.url })

/**
 * Crée le schéma droit_ci — articles juridiques (source de vérité, séparé de la plateforme)
 * OWASP A01 : schéma dédié isolé des données opérationnelles
 */
export async function createDroitCiSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS droit_ci`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS droit_ci.articles (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id      varchar(50) NOT NULL UNIQUE,
      article_numero  varchar(50) NOT NULL,
      source          varchar(30) NOT NULL,
      convention_slug varchar(100),
      livre           varchar(200),
      titre           varchar(300),
      chapitre        varchar(300),
      section         varchar(300),
      titre_article   text NOT NULL,
      texte           text NOT NULL,
      keywords        text[] DEFAULT '{}',
      payroll_codes   text[] DEFAULT '{}',
      access_level    varchar(20) NOT NULL DEFAULT 'public',
      is_active       boolean NOT NULL DEFAULT true,
      checksum_sha256 varchar(64),
      last_verified_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `)
  // Extension multi-pays : country_code (CIV par défaut pour les articles existants)
  await pool.query(`ALTER TABLE droit_ci.articles ADD COLUMN IF NOT EXISTS country_code varchar(3) NOT NULL DEFAULT 'CIV'`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_droit_ci_source ON droit_ci.articles(source)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_droit_ci_payroll ON droit_ci.articles USING GIN(payroll_codes)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_droit_ci_access ON droit_ci.articles(access_level, is_active)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_droit_ci_country ON droit_ci.articles(country_code, source, is_active)
  `)

  // ── Veille réglementaire — propositions de mise à jour (review workflow) ──
  // OWASP A07 : workflow draft → pending → approved/rejected piloté par
  // super_admin uniquement. OWASP A09 : historique complet via articles_history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS droit_ci.article_proposals (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id      varchar(50),  -- FK lâche vers articles.article_id (peut être NULL si nouvel article)
      country_code    varchar(3) NOT NULL DEFAULT 'CIV',
      source          varchar(30) NOT NULL,           -- code_travail | convention_collective | jo | dgi | cnps
      source_url      text,                            -- URL d'origine (JO, DGI, etc.)
      source_type     varchar(30) NOT NULL DEFAULT 'manual',  -- manual | scraper | upload
      proposed_at     timestamptz NOT NULL DEFAULT now(),
      proposed_by     varchar(80),                     -- 'ai_watcher' | uuid super_admin | 'manual'
      current_text    text,                            -- texte actuel (NULL si nouvel article)
      proposed_text   text NOT NULL,                   -- texte proposé en remplacement
      diff_summary    text,                            -- résumé IA des changements clés
      ai_confidence   int CHECK (ai_confidence BETWEEN 0 AND 100),
      ai_reasoning    text,                            -- explication IA du changement
      ai_model        varchar(50),
      status          varchar(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','superseded')),
      reviewed_at     timestamptz,
      reviewed_by     uuid,                            -- uuid du super_admin qui a tranché
      review_notes    text,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON droit_ci.article_proposals(status, proposed_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_proposals_article ON droit_ci.article_proposals(article_id) WHERE article_id IS NOT NULL
  `)

  // Historique des versions d'articles (audit + reversibilité)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS droit_ci.articles_history (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id            varchar(50) NOT NULL,
      version               int NOT NULL,
      titre_article         text NOT NULL,
      texte                 text NOT NULL,
      keywords              text[] DEFAULT '{}',
      payroll_codes         text[] DEFAULT '{}',
      checksum_sha256       varchar(64),
      valid_from            timestamptz NOT NULL DEFAULT now(),
      valid_until           timestamptz,                -- NULL = version active
      replaced_by_proposal_id uuid,
      archived_at           timestamptz NOT NULL DEFAULT now(),
      archived_by           uuid,
      UNIQUE (article_id, version)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_history_article ON droit_ci.articles_history(article_id, version DESC)
  `)
}

/**
 * Crée le schéma platform avec ses tables (idempotent)
 */
export async function createPlatformSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS platform`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.tenants (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug           varchar(63) NOT NULL UNIQUE,
      name           varchar(255) NOT NULL,
      schema_name    varchar(63) NOT NULL UNIQUE,
      plan_type      varchar(30) NOT NULL DEFAULT 'trial',
      status         varchar(20) NOT NULL DEFAULT 'trial',
      sector         varchar(50),
      city           varchar(100),
      cnps_number    varchar(50),
      dgi_number     varchar(50),
      rccm           varchar(100),
      at_rate        varchar(10) DEFAULT '0.020',
      max_users      int NOT NULL DEFAULT 10,
      max_employees  int NOT NULL DEFAULT 20,
      primary_color  varchar(7) DEFAULT '#E85D04',
      secondary_color varchar(7) DEFAULT '#F48C06',
      logo_url       text,
      favicon_url    text,
      custom_domain  varchar(255),
      trial_ends_at  timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.platform_users (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email         varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      first_name    varchar(100) NOT NULL,
      last_name     varchar(100) NOT NULL,
      role          varchar(20) NOT NULL DEFAULT 'super_admin',
      is_active     boolean NOT NULL DEFAULT true,
      mfa_enabled   boolean NOT NULL DEFAULT false,
      mfa_secret    varchar(255),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.tenant_invitations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   uuid NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
      email       varchar(255) NOT NULL,
      role        varchar(20) NOT NULL DEFAULT 'admin',
      token       varchar(255) NOT NULL UNIQUE,
      expires_at  timestamptz NOT NULL,
      accepted_at timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `)

  // ── Option multi-pays / filiales (migration lazy idempotente) ────────────────
  // Par défaut : has_subsidiaries=false, payroll_mode='single_country', pays=CIV.
  // Comportement actuel inchangé tant que l'option n'est pas activée.
  await pool.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS has_subsidiaries boolean NOT NULL DEFAULT false`)
  await pool.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS payroll_mode varchar(30) NOT NULL DEFAULT 'single_country'`)
  await pool.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS default_country_code varchar(3) NOT NULL DEFAULT 'CIV'`)

  // ── Sourcing IA — tables de configuration (100% paramétrable) ────────────────
  // Modèles IA disponibles (Claude/Mistral/autres) avec tarifs paramétrables.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.ai_models (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider                 varchar(30)  NOT NULL,
      model_id                 varchar(100) NOT NULL,
      display_name             varchar(150) NOT NULL,
      max_tokens               int          NOT NULL DEFAULT 4000,
      input_cost_per_1m_eur    numeric(10,4) NOT NULL DEFAULT 0,
      output_cost_per_1m_eur   numeric(10,4) NOT NULL DEFAULT 0,
      is_active                boolean      NOT NULL DEFAULT true,
      sort_order               int          NOT NULL DEFAULT 0,
      created_at               timestamptz  NOT NULL DEFAULT now(),
      updated_at               timestamptz  NOT NULL DEFAULT now(),
      UNIQUE (provider, model_id)
    )
  `)

  // Plateformes de sourcing (LinkedIn, Africawork, Emploi.ci, etc.) avec
  // rattachement optionnel à un pays (FK lâche sur country_code).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.sourcing_platforms (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code            varchar(50)  NOT NULL UNIQUE,
      name            varchar(150) NOT NULL,
      country_code    varchar(5),
      url             text,
      est_pool        int,
      is_active       boolean      NOT NULL DEFAULT true,
      is_panafrican   boolean      NOT NULL DEFAULT false,
      sort_order      int          NOT NULL DEFAULT 0,
      created_at      timestamptz  NOT NULL DEFAULT now(),
      updated_at      timestamptz  NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sourcing_platforms_country
      ON platform.sourcing_platforms(country_code, is_active)
  `)

  // Settings clé/valeur (JSONB) pour : prompts système, slider, budget,
  // pondérations richesse, templates email, etc.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.sourcing_settings (
      key         varchar(80) PRIMARY KEY,
      value       jsonb       NOT NULL DEFAULT '{}',
      description text,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid
    )
  `)
}

/**
 * Provisionne un nouveau schéma tenant avec toutes les tables CI
 */
export async function provisionTenantSchema(schemaName: string): Promise<void> {
  const q = (sql: string) => pool.query(sql)
  const s = `"${schemaName}"`

  await q(`CREATE SCHEMA IF NOT EXISTS ${s}`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email          varchar(255) NOT NULL UNIQUE,
    password_hash  varchar(255) NOT NULL,
    first_name     varchar(100) NOT NULL,
    last_name      varchar(100) NOT NULL,
    role           varchar(20) NOT NULL DEFAULT 'employee',
    employee_id    uuid,
    is_active      boolean NOT NULL DEFAULT true,
    mfa_enabled    boolean NOT NULL DEFAULT false,
    mfa_secret     varchar(255),
    last_login_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.departments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       varchar(100) NOT NULL,
    code       varchar(20),
    manager_id uuid,
    parent_id  uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.employees (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid,
    employee_number       varchar(50),
    first_name            varchar(100) NOT NULL,
    last_name             varchar(100) NOT NULL,
    email                 varchar(255),
    phone                 varchar(30),
    birth_date            date,
    birth_place           varchar(100),
    nationality           varchar(100) DEFAULT 'Ivoirienne',
    gender                varchar(10),
    nni                   varchar(50),
    cnps_number           varchar(50),
    mobile_money_provider varchar(20),
    mobile_money_phone    varchar(20),
    department_id         uuid,
    manager_id            uuid,
    job_title             varchar(100),
    job_level             varchar(50),
    contract_type         varchar(30) DEFAULT 'cdi',
    hire_date             date,
    trial_end_date        date,
    exit_date             date,
    exit_reason           varchar(100),
    base_salary           numeric(12,0) NOT NULL DEFAULT 0,
    currency              varchar(3) DEFAULT 'XOF',
    address               jsonb DEFAULT '{}',
    city                  varchar(100) DEFAULT 'Abidjan',
    iban                  varchar(255),
    bank_name             varchar(100),
    retention_score       numeric(3,2),
    burnout_risk          varchar(10),
    ai_score_updated_at   timestamptz,
    ai_score_factors      jsonb DEFAULT '[]',
    marital_status        varchar(20),
    children_count        int DEFAULT 0,
    custom_fields         jsonb DEFAULT '{}',
    profile_photo_url     text,
    is_active             boolean NOT NULL DEFAULT true,
    deleted_at            timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (email)
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.contracts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id           uuid NOT NULL,
    type                  varchar(30) NOT NULL DEFAULT 'cdi',
    start_date            date NOT NULL,
    end_date              date,
    trial_end_date        date,
    base_salary           numeric(12,0) NOT NULL,
    currency              varchar(3) DEFAULT 'XOF',
    working_hours         numeric(4,1) DEFAULT 40,
    convention            varchar(100),
    job_title             varchar(100),
    job_level             varchar(50),
    cnps_affiliation      boolean DEFAULT true,
    ohada_clause          boolean DEFAULT true,
    non_competition_clause boolean DEFAULT false,
    telecommuting_days    int DEFAULT 0,
    status                varchar(20) DEFAULT 'active',
    signature_status      varchar(30),
    file_url              text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.payroll_rules (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code       varchar(10) NOT NULL,
    label      varchar(200) NOT NULL,
    type       varchar(30) NOT NULL,
    formula    varchar(500) NOT NULL,
    "order"    int NOT NULL DEFAULT 0,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.pay_periods (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    month       varchar(7) NOT NULL UNIQUE,
    status      varchar(20) NOT NULL DEFAULT 'open',
    closed_at   timestamptz,
    closed_by   varchar(100),
    total_gross numeric(14,0),
    total_net   numeric(14,0),
    total_cnps  numeric(14,0),
    total_its   numeric(14,0),
    created_at  timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.pay_slips (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id           uuid NOT NULL,
    period_id             uuid NOT NULL,
    month                 varchar(7) NOT NULL,
    base_salary           numeric(12,0) NOT NULL,
    gross_salary          numeric(12,0) NOT NULL,
    cnps_retraite_sal     numeric(10,0) DEFAULT 0,
    cnps_retraite_pat     numeric(10,0) DEFAULT 0,
    cnps_pf_pat           numeric(10,0) DEFAULT 0,
    cnps_at_pat           numeric(10,0) DEFAULT 0,
    total_cnps_sal        numeric(10,0) DEFAULT 0,
    total_cnps_pat        numeric(10,0) DEFAULT 0,
    its                   numeric(10,0) DEFAULT 0,
    total_deductions      numeric(12,0) DEFAULT 0,
    net_payable           numeric(12,0) NOT NULL,
    employer_cost         numeric(12,0) NOT NULL,
    currency              varchar(3) DEFAULT 'XOF',
    payment_method        varchar(30) DEFAULT 'mobile_money',
    payment_status        varchar(20) DEFAULT 'pending',
    payment_reference     varchar(100),
    paid_at               timestamptz,
    lines                 jsonb DEFAULT '[]',
    status                varchar(20) NOT NULL DEFAULT 'draft',
    generated_at          timestamptz,
    viewed_by_employee_at timestamptz,
    file_url              text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.variable_elements (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL,
    period_id   uuid NOT NULL,
    rule_code   varchar(10) NOT NULL,
    label       varchar(200),
    amount      numeric(12,0) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.cnps_declarations (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    year                          int NOT NULL,
    quarter                       int NOT NULL,
    months                        jsonb DEFAULT '[]',
    status                        varchar(20) DEFAULT 'draft',
    total_cotisations_salariales  numeric(14,0) DEFAULT 0,
    total_cotisations_patronales  numeric(14,0) DEFAULT 0,
    total_cotisations             numeric(14,0) DEFAULT 0,
    masse_salariale               numeric(14,0) DEFAULT 0,
    employees_count               int DEFAULT 0,
    data                          jsonb DEFAULT '[]',
    export_url                    text,
    submitted_at                  timestamptz,
    submitted_by                  uuid,
    due_date                      date,
    created_at                    timestamptz NOT NULL DEFAULT now(),
    updated_at                    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (year, quarter)
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.disa_records (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    year             int NOT NULL UNIQUE,
    employees_count  int DEFAULT 0,
    masse_salariale  numeric(14,0) DEFAULT 0,
    total_cnps       numeric(14,0) DEFAULT 0,
    total_its        numeric(14,0) DEFAULT 0,
    data             jsonb DEFAULT '[]',
    status           varchar(20) DEFAULT 'draft',
    export_url       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.mobile_money_payments (
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
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.absence_types (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code              varchar(20) NOT NULL UNIQUE,
    label             varchar(100) NOT NULL,
    is_paid           boolean DEFAULT true,
    affects_salary    boolean DEFAULT false,
    calculation_mode  varchar(20) DEFAULT 'working_days',
    requires_approval boolean DEFAULT true,
    max_days_per_year int,
    color             varchar(7) DEFAULT '#4F46E5',
    is_active         boolean DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.absence_balances (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     uuid NOT NULL,
    absence_type_id uuid NOT NULL,
    year            int NOT NULL,
    acquired        numeric(6,1) DEFAULT 0,
    taken           numeric(6,1) DEFAULT 0,
    pending         numeric(6,1) DEFAULT 0,
    remaining       numeric(6,1) DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.absences (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id      uuid NOT NULL,
    absence_type_id  uuid NOT NULL,
    start_date       date NOT NULL,
    end_date         date NOT NULL,
    days             numeric(4,1) NOT NULL,
    half_day         boolean DEFAULT false,
    reason           text,
    status           varchar(20) NOT NULL DEFAULT 'pending',
    validation_level int NOT NULL DEFAULT 0,
    approved_by      uuid,
    approved_at      timestamptz,
    rejected_by      uuid,
    rejection_reason text,
    attachment_url   text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.expense_reports (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id      uuid NOT NULL,
    title            varchar(200) NOT NULL,
    month            varchar(7) NOT NULL,
    total_amount     numeric(12,0) DEFAULT 0,
    currency         varchar(3) DEFAULT 'XOF',
    status           varchar(20) NOT NULL DEFAULT 'draft',
    validation_level int NOT NULL DEFAULT 0,
    submitted_at     timestamptz,
    approved_by      uuid,
    approved_at      timestamptz,
    rejection_reason text,
    payment_method   varchar(20) DEFAULT 'mobile_money',
    paid_at          timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.expense_lines (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id   uuid NOT NULL,
    description varchar(300) NOT NULL,
    category    varchar(50) NOT NULL,
    date        date NOT NULL,
    amount      numeric(10,0) NOT NULL,
    currency    varchar(3) DEFAULT 'XOF',
    receipt_url text,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.recruitment_jobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title         varchar(200) NOT NULL,
    department_id uuid,
    location      varchar(100) DEFAULT 'Abidjan',
    contract_type varchar(30) DEFAULT 'cdi',
    salary_min    numeric(12,0),
    salary_max    numeric(12,0),
    currency      varchar(3) DEFAULT 'XOF',
    description   text,
    requirements  text,
    status        varchar(20) DEFAULT 'open',
    published_at  timestamptz,
    closed_at     timestamptz,
    created_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.applications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       uuid NOT NULL,
    first_name   varchar(100) NOT NULL,
    last_name    varchar(100) NOT NULL,
    email        varchar(255) NOT NULL,
    phone        varchar(30),
    cv_url       text,
    cover_letter text,
    stage        varchar(30) DEFAULT 'new',
    ai_score     int,
    ai_summary   text,
    notes        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.trainings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title            varchar(200) NOT NULL,
    description      text,
    duration         int,
    duration_unit    varchar(10) DEFAULT 'hours',
    format           varchar(30) DEFAULT 'presentiel',
    category         varchar(50),
    is_fdfp_eligible boolean DEFAULT false,
    fdfp_code        varchar(50),
    max_participants int,
    is_active        boolean DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.training_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    training_id  uuid NOT NULL,
    start_date   date NOT NULL,
    end_date     date,
    location     varchar(200),
    trainer      varchar(100),
    status       varchar(20) DEFAULT 'planned',
    max_places   int DEFAULT 20,
    created_at   timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.training_enrollments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid NOT NULL,
    employee_id     uuid NOT NULL,
    status          varchar(20) DEFAULT 'enrolled',
    completed_at    timestamptz,
    certificate_url text,
    created_at      timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.career_skills (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name     varchar(100) NOT NULL,
    category varchar(50),
    is_active boolean DEFAULT true
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.employee_skills (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id  uuid NOT NULL,
    skill_id     uuid NOT NULL,
    level        int NOT NULL DEFAULT 1,
    target_level int,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, skill_id)
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.evaluations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id       uuid NOT NULL,
    evaluator_id      uuid,
    type              varchar(30) DEFAULT 'annual',
    year              int NOT NULL,
    period            varchar(20),
    global_score      numeric(3,1),
    performance_score numeric(3,1),
    goals_score       numeric(3,1),
    skills_score      numeric(3,1),
    comments          text,
    manager_comments  text,
    employee_comments text,
    goals             jsonb DEFAULT '[]',
    strengths         jsonb DEFAULT '[]',
    improvements      jsonb DEFAULT '[]',
    training_needs    jsonb DEFAULT '[]',
    status            varchar(20) DEFAULT 'draft',
    signed_by_employee boolean DEFAULT false,
    signed_by_manager  boolean DEFAULT false,
    completed_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.hr_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL,
    type        varchar(50) NOT NULL,
    title       varchar(200) NOT NULL,
    description text,
    date        date NOT NULL,
    metadata    jsonb DEFAULT '{}',
    created_by  uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL,
    type       varchar(50) NOT NULL,
    title      varchar(200) NOT NULL,
    message    text NOT NULL,
    is_read    boolean DEFAULT false,
    data       jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.audit_log (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid,
    action     varchar(100) NOT NULL,
    entity     varchar(50) NOT NULL,
    entity_id  uuid,
    changes    jsonb DEFAULT '{}',
    ip_address varchar(45),
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.refresh_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL,
    token      varchar(500) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.workflow_configs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    module       varchar(30) NOT NULL UNIQUE,
    levels_count int NOT NULL DEFAULT 1,
    config       jsonb DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
  )`)

  // Workflow configs par défaut
  await q(`
    INSERT INTO ${s}.workflow_configs (module, levels_count)
    VALUES ('absences', 1), ('expenses', 1)
    ON CONFLICT (module) DO NOTHING
  `)

  // Entités juridiques OHADA
  await q(`CREATE TABLE IF NOT EXISTS ${s}.legal_entities (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 varchar(200) NOT NULL,
    rccm                 varchar(100),
    cnps_number          varchar(50),
    dgi_number           varchar(50),
    address              text,
    city                 varchar(100) DEFAULT 'Abidjan',
    legal_form           varchar(50) DEFAULT 'SARL',
    collective_agreement varchar(200),
    at_rate              numeric(5,4) DEFAULT 0.02,
    is_active            boolean DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
  )`)
  // Pays + pack législatif de la filiale (multi-pays — Palier 3)
  await q(`ALTER TABLE ${s}.legal_entities ADD COLUMN IF NOT EXISTS country_code varchar(3) NOT NULL DEFAULT 'CIV'`)
  await q(`ALTER TABLE ${s}.legal_entities ADD COLUMN IF NOT EXISTS legislation_pack_code varchar(20)`)

  // Colonne month sur variable_elements (migration lazy)
  await q(`ALTER TABLE ${s}.variable_elements ADD COLUMN IF NOT EXISTS month varchar(7)`)
  await q(`ALTER TABLE ${s}.variable_elements ADD COLUMN IF NOT EXISTS description text`)
  // UNIQUE pour upsert month
  await q(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'variable_elements_emp_code_month_unique'
          AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schemaName}')
      ) THEN
        ALTER TABLE ${s}.variable_elements
          ADD CONSTRAINT variable_elements_emp_code_month_unique
          UNIQUE (employee_id, rule_code, month);
      END IF;
    END $$
  `)
  // Colonne legal_entity_id sur employees (migration lazy)
  await q(`ALTER TABLE ${s}.employees ADD COLUMN IF NOT EXISTS legal_entity_id uuid`)

  // ── Workflow paie centralisé multi-sites (Palier 3) ──────────────────────────
  // Étend pay_periods pour supporter le cycle draft_central → sent_to_sites →
  // completed_by_sites → validated_central → closed. Une période globale
  // (parent_period_id NULL) peut être déclinée en sous-périodes par filiale
  // (parent_period_id = id de la période parente).
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS parent_period_id uuid`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS legal_entity_id uuid`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS legislation_pack_code varchar(20)`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS raf_user_id uuid`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS sent_to_sites_at timestamptz`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS completed_by_site_at timestamptz`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS validated_central_at timestamptz`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS validated_by uuid`)
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_pp_parent ON ${s}.pay_periods(parent_period_id) WHERE parent_period_id IS NOT NULL`)
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_pp_le_status ON ${s}.pay_periods(legal_entity_id, status) WHERE legal_entity_id IS NOT NULL`)

  // ── Workflow paie paramétrable (OWASP A04 — Segregation of Duties) ───────
  // workflow_configs.levels_count (module='payroll') pilote le nombre de
  // validations requises. Chaque validation = 1 row dans pay_period_approvals.
  // Quand count(approvals) >= levels_count → status = 'closed'.
  // Garde-fous : approver ≠ initiateur, et chaque approver différent.
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS initiated_at  timestamptz`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS initiated_by  uuid`)
  await q(`ALTER TABLE ${s}.pay_periods ADD COLUMN IF NOT EXISTS rejection_reason text`)

  await q(`CREATE TABLE IF NOT EXISTS ${s}.pay_period_approvals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    period_id     uuid NOT NULL REFERENCES ${s}.pay_periods(id) ON DELETE CASCADE,
    level         int NOT NULL,
    approver_id   uuid NOT NULL,
    approver_role varchar(30),
    approved_at   timestamptz NOT NULL DEFAULT now(),
    notes         text,
    UNIQUE (period_id, level),
    UNIQUE (period_id, approver_id)  -- même approver ne peut pas valider 2 niveaux
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_ppa_period ON ${s}.pay_period_approvals(period_id, level)`)

  // Workflow par défaut pour 'payroll' : 2 niveaux (initiateur + N+1)
  await q(`
    INSERT INTO ${s}.workflow_configs (module, levels_count)
    VALUES ('payroll', 2)
    ON CONFLICT (module) DO NOTHING
  `)

  // Ajout du nouveau rôle raf_site dans la table users : c'est porté par
  // une simple chaîne dans users.role — pas de schema à changer. Le RBAC
  // côté API doit accepter ce rôle pour les opérations de site.

  // ── Recrutement : colonnes additives (migration lazy idempotente) ────────────
  // Offres : visibilité (interne/externe) + critères de ciblage interne
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS visibility varchar(20) DEFAULT 'external'`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_departments uuid[] DEFAULT '{}'`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_job_levels varchar(30)[] DEFAULT '{}'`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_min_seniority_months int`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_legal_entity_id uuid`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS hiring_manager_id uuid`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS public_slug varchar(120)`)

  // Candidatures : enrichissement scoring IA + source + lien employé interne
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS source varchar(30) DEFAULT 'manual'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS internal_employee_id uuid`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_recommendation varchar(20)`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_match_percentage int`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_strengths jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_gaps jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_red_flags jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_interview_questions jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_model_used varchar(30)`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_analyzed_at timestamptz`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS cv_text text`)

  // Index utiles pour le filtrage interne et la consultation pipeline
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_jobs_visibility ON ${s}.recruitment_jobs(visibility, status)`)
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_apps_internal_emp ON ${s}.applications(internal_employee_id)`)

  // Sourcing IA — cache des profils générés (visualisation + transfert vers pipeline)
  await q(`CREATE TABLE IF NOT EXISTS ${s}.sourced_profiles (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id                      uuid NOT NULL,
    first_name                  varchar(100) NOT NULL,
    last_name                   varchar(100) NOT NULL,
    current_position            varchar(200),
    current_company             varchar(200),
    location                    varchar(150),
    experience_years            int,
    key_skills                  jsonb DEFAULT '[]',
    match_score                 int,
    availability_estimate       varchar(20),
    suggested_platform          varchar(100),
    linkedin_search             text,
    approach_strategy           text,
    estimated_salary            bigint,
    estimated_salary_currency   varchar(3) DEFAULT 'XOF',
    email                       varchar(255),
    phone                       varchar(30),
    source_provider             varchar(30),
    source_model                varchar(50),
    countries                   varchar(3)[] DEFAULT '{}',
    transferred_to_application_id uuid,
    transferred_at              timestamptz,
    transferred_by              uuid,
    created_at                  timestamptz NOT NULL DEFAULT now()
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_sourced_job ON ${s}.sourced_profiles(job_id, transferred_at)`)
}

/**
 * Migration lazy idempotente du module recrutement.
 * À appeler en début de handler pour les tenants seedés avant l'ajout
 * de la visibilité interne/externe et du scoring IA enrichi.
 */
export async function ensureRecruitmentSchemaMigrated(schemaName: string): Promise<void> {
  const s = `"${schemaName}"`
  const q = (sql: string) => pool.query(sql)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS visibility varchar(20) DEFAULT 'external'`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_departments uuid[] DEFAULT '{}'`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_job_levels varchar(30)[] DEFAULT '{}'`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_min_seniority_months int`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS target_legal_entity_id uuid`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS hiring_manager_id uuid`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS public_slug varchar(120)`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS source varchar(30) DEFAULT 'manual'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS internal_employee_id uuid`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_recommendation varchar(20)`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_match_percentage int`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_strengths jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_gaps jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_red_flags jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_interview_questions jsonb DEFAULT '[]'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_model_used varchar(30)`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS ai_analyzed_at timestamptz`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS cv_text text`)

  // Sourcing IA — table cache des profils générés (migration lazy idempotente)
  await q(`CREATE TABLE IF NOT EXISTS ${s}.sourced_profiles (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id                      uuid NOT NULL,
    first_name                  varchar(100) NOT NULL,
    last_name                   varchar(100) NOT NULL,
    current_position            varchar(200),
    current_company             varchar(200),
    location                    varchar(150),
    experience_years            int,
    key_skills                  jsonb DEFAULT '[]',
    match_score                 int,
    availability_estimate       varchar(20),
    suggested_platform          varchar(100),
    linkedin_search             text,
    approach_strategy           text,
    estimated_salary            bigint,
    estimated_salary_currency   varchar(3) DEFAULT 'XOF',
    email                       varchar(255),
    phone                       varchar(30),
    source_provider             varchar(30),
    source_model                varchar(50),
    countries                   varchar(3)[] DEFAULT '{}',
    transferred_to_application_id uuid,
    transferred_at              timestamptz,
    transferred_by              uuid,
    created_at                  timestamptz NOT NULL DEFAULT now()
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_${schemaName}_sourced_job ON ${s}.sourced_profiles(job_id, transferred_at)`)
}

/**
 * Seed des rubriques de paie CI pour un tenant
 */
export async function seedPayrollRulesCI(schemaName: string, atRate: number = 0.02): Promise<void> {
  const s = `"${schemaName}"`
  const rules = [
    { code: '1000', label: 'Salaire de base', type: 'earning', formula: 'BRUT_PRORATA', order: 10 },
    { code: '1100', label: "Prime d'ancienneté", type: 'earning', formula: 'VAR:PRIME_ANCIENNETE', order: 20 },
    { code: '1200', label: 'Prime de rendement', type: 'earning', formula: 'VAR:PRIME_RENDEMENT', order: 30 },
    { code: '1300', label: 'Prime de transport', type: 'earning', formula: 'VAR:PRIME_TRANSPORT', order: 40 },
    { code: '1400', label: 'Heures supplémentaires (+15%)', type: 'earning', formula: 'VAR:HEURES_SUPP_NORM', order: 50 },
    { code: '1500', label: 'Heures supplémentaires (+50%)', type: 'earning', formula: 'VAR:HEURES_SUPP_NUIT', order: 60 },
    { code: '1600', label: 'Indemnité de congés payés', type: 'earning', formula: 'VAR:ICP', order: 70 },
    { code: '2000', label: 'CNPS Retraite salarié (6,3%)', type: 'employee_contribution', formula: 'BASE_RETRAITE * 0.063', order: 100 },
    { code: '2100', label: 'ITS - Impôt sur Traitements et Salaires', type: 'employee_contribution', formula: 'ITS', order: 110 },
    { code: '3000', label: 'CNPS Retraite patronal (7,7%)', type: 'employer_contribution', formula: 'BASE_RETRAITE * 0.077', order: 200 },
    { code: '3100', label: 'CNPS Prestations familiales (5%)', type: 'employer_contribution', formula: 'BASE_AT_PF * 0.050', order: 210 },
    { code: '3200', label: 'CNPS Assurance maternité (0,75%)', type: 'employer_contribution', formula: 'BASE_AT_PF * 0.0075', order: 220 },
    { code: '3300', label: `CNPS Accidents du travail (${(atRate * 100).toFixed(2)}%)`, type: 'employer_contribution', formula: `BASE_AT_PF * ${atRate}`, order: 230 },
    { code: '4000', label: 'Mutuelle santé salarié', type: 'employee_contribution', formula: 'VAR:MUTUELLE_SAL', order: 300 },
    { code: '4100', label: 'Mutuelle santé patronal', type: 'employer_contribution', formula: 'VAR:MUTUELLE_PAT', order: 310 },
    { code: '5000', label: 'Avance sur salaire', type: 'deduction', formula: 'VAR:AVANCE', order: 400 },
    { code: '5100', label: 'Retenue absence non justifiée', type: 'deduction', formula: 'VAR:RETENUE_ABSENCE', order: 410 },
  ]

  for (const r of rules) {
    await pool.query(
      `INSERT INTO ${s}.payroll_rules (code, label, type, formula, "order")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [r.code, r.label, r.type, r.formula, r.order]
    )
  }
}

/**
 * Seed des types d'absences CI
 */
export async function seedAbsenceTypesCI(schemaName: string): Promise<void> {
  const s = `"${schemaName}"`
  const types = [
    { code: 'CP', label: 'Congés payés', isPaid: true, color: '#4F46E5', calculationMode: 'working_days' },
    { code: 'MALADIE', label: 'Congé maladie', isPaid: true, color: '#EF4444', calculationMode: 'calendar_days' },
    { code: 'MATERNITE', label: 'Congé maternité (14 semaines)', isPaid: true, color: '#EC4899', calculationMode: 'calendar_days' },
    { code: 'PATERNITE', label: 'Congé paternité (10 jours)', isPaid: true, color: '#3B82F6', calculationMode: 'working_days', maxDays: 10 },
    { code: 'DEUIL', label: 'Congé deuil familial (3 jours)', isPaid: true, color: '#6B7280', calculationMode: 'calendar_days', maxDays: 3 },
    { code: 'SANS_SOLDE', label: 'Congé sans solde', isPaid: false, color: '#F59E0B', calculationMode: 'calendar_days' },
    { code: 'FORMATION', label: 'Formation professionnelle', isPaid: true, color: '#10B981', calculationMode: 'working_days' },
    { code: 'EVENEMENT', label: 'Événement familial', isPaid: true, color: '#8B5CF6', calculationMode: 'calendar_days' },
  ]

  for (const t of types) {
    await pool.query(
      `INSERT INTO ${s}.absence_types (code, label, is_paid, color, calculation_mode, max_days_per_year)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO NOTHING`,
      [t.code, t.label, t.isPaid, t.color, t.calculationMode, t.maxDays ?? null]
    )
  }
}
