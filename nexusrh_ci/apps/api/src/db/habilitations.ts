/**
 * Habilitations RH — tables TENANT-SCOPÉES `hab_*` (groupes, sous-groupes
 * plafonnés, droits appliqués, fiches d'habilitation, journal, délégations,
 * modèles, règles de séparation des tâches).
 *
 * Les permissions sont des text[] (`fonction:action` + extras) ; le catalogue
 * est dans modules/habilitations/catalog.ts. Partagé par le provisioning et
 * la migration lazy (ensureTenantSchema) — idempotent.
 */
export function habilitationTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.hab_groups (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       varchar(150) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.hab_subgroups (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id        uuid NOT NULL REFERENCES ${s}.hab_groups(id) ON DELETE CASCADE,
      name            varchar(150) NOT NULL,
      kind            varchar(10) NOT NULL DEFAULT 'entity' CHECK (kind IN ('siege','entity')),
      legal_entity_id uuid,
      ceiling         text[] NOT NULL DEFAULT '{}',
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    // Une entité légale appartient à un seul sous-groupe.
    `CREATE UNIQUE INDEX IF NOT EXISTS "${schemaName}_hab_subgroups_entity_uniq"
       ON ${s}.hab_subgroups(legal_entity_id)`,
    // Un seul sous-groupe siège (filet face à la concurrence : la création du
    // siège par la reprise reste idempotente même sans verrou).
    `CREATE UNIQUE INDEX IF NOT EXISTS "${schemaName}_hab_subgroups_siege_uniq"
       ON ${s}.hab_subgroups(kind) WHERE kind = 'siege'`,
    `CREATE TABLE IF NOT EXISTS ${s}.hab_fiches (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      number          varchar(20) NOT NULL UNIQUE,
      target_user_id  uuid NOT NULL,
      subgroup_id     uuid,
      permissions     text[] NOT NULL DEFAULT '{}',
      template_key    varchar(60),
      motive          text,
      effective_from  date,
      status          varchar(12) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','n1','n2','locked','applied','rejected','superseded')),
      kind            varchar(10) NOT NULL DEFAULT 'grant' CHECK (kind IN ('grant','revoke')),
      n1_user_id      uuid,
      n2_user_id      uuid,
      created_by      uuid,
      delegation_id   uuid,
      sod_alerts      jsonb NOT NULL DEFAULT '[]',
      locked_at       timestamptz,
      applied_at      timestamptz,
      applied_by      uuid,
      rejected_reason text,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.hab_assignments (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid NOT NULL,
      subgroup_id    uuid,
      permissions    text[] NOT NULL DEFAULT '{}',
      source         varchar(10) NOT NULL DEFAULT 'fiche' CHECK (source IN ('fiche','reprise','bootstrap')),
      fiche_id       uuid,
      effective_from date,
      revoked_at     timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`,
    // Un seul jeu de droits appliqué par utilisateur.
    `CREATE UNIQUE INDEX IF NOT EXISTS "${schemaName}_hab_assignments_user_uniq"
       ON ${s}.hab_assignments(user_id)`,
    // Journal : le diff ne porte que des clés de permission (jamais de donnée perso).
    `CREATE TABLE IF NOT EXISTS ${s}.hab_fiche_events (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      fiche_id   uuid NOT NULL,
      actor_id   uuid,
      event      varchar(20) NOT NULL
                 CHECK (event IN ('created','edited','submitted','validated','rejected','locked','applied','sod_accepted')),
      diff       jsonb NOT NULL DEFAULT '{}',
      ip         varchar(45),
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_hab_fiche_events_fiche_idx"
       ON ${s}.hab_fiche_events(fiche_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${s}.hab_delegations (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delegator_id uuid NOT NULL,
      delegate_id  uuid NOT NULL,
      subgroup_id  uuid,
      starts_at    timestamptz NOT NULL DEFAULT now(),
      ends_at      timestamptz NOT NULL,
      revoked_at   timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.hab_templates (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key         varchar(60) NOT NULL UNIQUE,
      label       varchar(150) NOT NULL,
      permissions text[] NOT NULL DEFAULT '{}'
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.hab_sod_rules (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label      varchar(200) NOT NULL,
      left_perm  varchar(60) NOT NULL,
      right_perm varchar(60) NOT NULL,
      active     boolean NOT NULL DEFAULT true,
      UNIQUE (left_perm, right_perm)
    )`,
    // Règles de séparation des tâches par défaut (idempotent).
    `INSERT INTO ${s}.hab_sod_rules (label, left_perm, right_perm) VALUES
      ('Valider la paie et payer', 'payroll:validate', 'payments:pay'),
      ('Créer un salarié et valider la paie', 'employees:create', 'payroll:validate'),
      ('Créer un salarié et payer', 'employees:create', 'payments:pay'),
      ('Paramétrer la paie et la valider', 'payroll:configure', 'payroll:validate')
     ON CONFLICT (left_perm, right_perm) DO NOTHING`,
  ]
}
