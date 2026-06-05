/**
 * Parcours d'intégration (onboarding) — DDL partagé.
 *
 * Source unique de vérité pour les tables onboarding, utilisée par :
 *   - db/provisioning.ts (création initiale d'un schéma tenant) ;
 *   - utils/schema-migrations.ts (migration lazy des schémas existants).
 *
 * Modèle (meilleures pratiques RH) :
 *   onboarding_templates       : modèles paramétrables par séniorité / type de
 *                                poste (mots-clés matchés contre l'intitulé).
 *   onboarding_template_steps  : étapes du modèle, par phase (avant l'arrivée,
 *                                jour J, 1re semaine, 1er mois, fin d'essai),
 *                                avec responsable (RH/manager/collaborateur/IT/
 *                                parrain), échéance relative à l'embauche et
 *                                ressources (documents, vidéos, liens utiles).
 *   onboarding_journeys        : parcours instancié pour UN collaborateur
 *                                (auto-créé à la création de l'employé).
 *   onboarding_steps           : étapes du parcours — kanban (todo |
 *                                in_progress | done) planifiable par les RH,
 *                                consultable par le collaborateur.
 */
export const ONBOARDING_PHASES = ['before_start', 'day_one', 'first_week', 'first_month', 'probation_end'] as const
export const ONBOARDING_OWNERS = ['hr', 'manager', 'employee', 'it', 'buddy'] as const
export const ONBOARDING_STEP_STATUSES = ['todo', 'in_progress', 'done'] as const
export const ONBOARDING_SENIORITIES = ['any', 'junior', 'confirme', 'senior', 'cadre', 'direction'] as const

export function onboardingTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.onboarding_templates (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name          varchar(200) NOT NULL,
      description   text,
      seniority     varchar(20) NOT NULL DEFAULT 'any',
      job_keywords  text,
      department_id uuid,
      is_active     boolean NOT NULL DEFAULT true,
      is_default    boolean NOT NULL DEFAULT false,
      created_by    uuid,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.onboarding_template_steps (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id     uuid NOT NULL REFERENCES ${s}.onboarding_templates(id) ON DELETE CASCADE,
      title           varchar(255) NOT NULL,
      description     text,
      phase           varchar(30) NOT NULL DEFAULT 'first_week',
      owner_role      varchar(20) NOT NULL DEFAULT 'hr',
      due_offset_days int NOT NULL DEFAULT 0,
      sort_order      int NOT NULL DEFAULT 0,
      resources       jsonb NOT NULL DEFAULT '[]',
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_onb_tpl_steps_tpl ON ${s}.onboarding_template_steps(template_id)`,
    `CREATE TABLE IF NOT EXISTS ${s}.onboarding_journeys (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id   uuid NOT NULL,
      template_id   uuid,
      template_name varchar(200),
      status        varchar(20) NOT NULL DEFAULT 'in_progress',
      started_at    timestamptz NOT NULL DEFAULT now(),
      completed_at  timestamptz,
      created_by    uuid,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_onb_journeys_emp ON ${s}.onboarding_journeys(employee_id)`,
    `CREATE TABLE IF NOT EXISTS ${s}.onboarding_steps (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      journey_id   uuid NOT NULL REFERENCES ${s}.onboarding_journeys(id) ON DELETE CASCADE,
      title        varchar(255) NOT NULL,
      description  text,
      phase        varchar(30) NOT NULL DEFAULT 'first_week',
      owner_role   varchar(20) NOT NULL DEFAULT 'hr',
      status       varchar(20) NOT NULL DEFAULT 'todo',
      due_date     date,
      sort_order   int NOT NULL DEFAULT 0,
      resources    jsonb NOT NULL DEFAULT '[]',
      notes        text,
      completed_at timestamptz,
      completed_by uuid,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_onb_steps_journey ON ${s}.onboarding_steps(journey_id)`,
  ]
}
