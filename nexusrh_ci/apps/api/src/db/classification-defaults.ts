/**
 * Classification des données à 4 niveaux — DDL + données de référence par défaut.
 *
 * Partagé entre le provisionnement (nouveaux tenants) et la migration lazy
 * (tenants existants) pour rester DRY. Idempotent :
 *  - CREATE TABLE IF NOT EXISTS
 *  - INSERT ... ON CONFLICT DO NOTHING (clés naturelles : level, category_key)
 *
 * Conforme au cahier des charges VERSUS BANK :
 *  Niveau 1 Public · 2 Interne · 3 Confidentiel (ex. salaires) · 4 Restreint
 *  (ex. santé, disciplinaire). Le niveau 4 nécessite un cloisonnement strict.
 */
export function classificationTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    // Règles d'accès par niveau (1–4) — configurables par l'admin du tenant.
    `CREATE TABLE IF NOT EXISTS ${s}.classification_levels (
      level               int PRIMARY KEY,
      label               varchar(40) NOT NULL,
      allowed_roles       text[] NOT NULL DEFAULT '{}',
      export_allowed      boolean NOT NULL DEFAULT true,
      encryption_required boolean NOT NULL DEFAULT false,
      audit_required      boolean NOT NULL DEFAULT false,
      updated_at          timestamptz NOT NULL DEFAULT now()
    )`,
    // Cartographie catégorie de données → niveau de classification.
    `CREATE TABLE IF NOT EXISTS ${s}.data_classification_categories (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      category_key varchar(60) NOT NULL UNIQUE,
      label        varchar(150) NOT NULL,
      level        int NOT NULL DEFAULT 2,
      examples     text,
      notes        text,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`,
    // Règles par défaut (le niveau 4 = RH habilités uniquement, pas d'export).
    `INSERT INTO ${s}.classification_levels (level, label, allowed_roles, export_allowed, encryption_required, audit_required) VALUES
       (1, 'public',       ARRAY['admin','hr_manager','hr_officer','manager','employee','readonly','dg'], true,  false, false),
       (2, 'internal',     ARRAY['admin','hr_manager','hr_officer','manager','employee','readonly','dg'], true,  false, false),
       (3, 'confidential', ARRAY['admin','hr_manager','hr_officer','manager','dg','readonly'],            true,  true,  true),
       (4, 'restricted',   ARRAY['admin','hr_manager','hr_officer'],                                      false, true,  true)
     ON CONFLICT (level) DO NOTHING`,
    // Catégories standard (cf. cahier des charges).
    `INSERT INTO ${s}.data_classification_categories (category_key, label, level, examples) VALUES
       ('organigramme',         'Organigramme & annuaire',     1, 'Organigramme général, annuaire interne (nom, fonction, service)'),
       ('job_offers',           'Offres d''emploi',            1, 'Offres internes et externes'),
       ('job_profiles',         'Fiches de poste',             2, 'Fiches de poste, missions, activités'),
       ('competency_framework', 'Référentiel de compétences',  2, 'Compétences et niveaux de maîtrise'),
       ('training_catalog',     'Catalogue de formation',      2, 'Plans et catalogues de formation'),
       ('hr_policies',          'Politiques RH internes',      2, 'Règlement intérieur, notes RH'),
       ('remuneration',         'Rémunérations',               3, 'Salaires, primes, avantages'),
       ('payslips',             'Bulletins de paie',           3, 'Bulletins, cumuls annuels'),
       ('evaluations',          'Évaluations individuelles',   3, 'Notes, objectifs, résultats de performance'),
       ('contracts',            'Données contractuelles',      3, 'CDI, CDD, avenants'),
       ('career_history',       'Historique de carrière',      3, 'Mobilités, promotions, changements'),
       ('medical',              'Données de santé',            4, 'Visites médicales, aptitudes, accidents du travail'),
       ('disciplinary',         'Sanctions disciplinaires',    4, 'Avertissements, blâmes, mises à pied'),
       ('ethics_reports',       'Signalements éthiques',       4, 'Enquêtes internes, signalements'),
       ('litigation',           'Contentieux & litiges',       4, 'Litiges, contentieux, inspections du travail'),
       ('biometric',            'Données biométriques',        4, 'Données biométriques (si existantes)')
     ON CONFLICT (category_key) DO NOTHING`,
  ]
}
