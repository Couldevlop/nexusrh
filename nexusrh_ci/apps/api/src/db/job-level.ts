/**
 * Niveau de poste (`employees.job_level`) pour les jeux de données de démo.
 *
 * Clés TECHNIQUES, alignées sur `JOB_LEVELS` du formulaire d'offre
 * (apps/web/src/pages/recruitment/RecruitmentPage.tsx) et sur la colonne
 * `recruitment_jobs.target_job_levels`, qui pilote la visibilité des offres
 * internes dans `GET /recruitment/internal-jobs` :
 *
 *   AND (cardinality(rj.target_job_levels) = 0
 *        OR e.job_level = ANY(rj.target_job_levels))
 *
 * Une colonne laissée à NULL ne matche JAMAIS `= ANY(...)` : toute offre ciblée
 * par niveau devient alors invisible pour l'intégralité de l'effectif, et avec
 * elle le bouton « S'entraîner à l'entretien » (module interview_sim), qui
 * n'existe que dans le détail d'une offre interne. C'est exactement le cas
 * rencontré en prod le 25/07/2026 : 82 employés SOTRA, 3 offres internes
 * ouvertes, 0 employé destinataire.
 *
 * Ne pas confondre avec `contracts.job_level`, qui est un LIBELLÉ libre affiché
 * sur le contrat (« Cadre », « Agent de maîtrise ») et ne sert à aucun filtre.
 */
export const JOB_LEVELS = ['cadre', 'agent_maitrise', 'employe', 'ouvrier'] as const
export type JobLevel = (typeof JOB_LEVELS)[number]

/**
 * Seuils FCFA, du plus élevé au plus bas — SOURCE DE VÉRITÉ UNIQUE, partagée
 * par la déduction TypeScript (nouveaux employés) et le rattrapage SQL
 * (employés déjà en base). Calés sur les grilles des tenants de démo pour que
 * CHAQUE niveau soit représenté : Exploitation (80 000–180 000) couvre
 * ouvrier → agent de maîtrise, et Direction Générale (300 000–600 000)
 * alimente les offres réservées aux cadres.
 */
export const JOB_LEVEL_THRESHOLDS: ReadonlyArray<{ min: number; level: JobLevel }> = [
  { min: 300_000, level: 'cadre' },
  { min: 150_000, level: 'agent_maitrise' },
  { min: 110_000, level: 'employe' },
  { min: 0,       level: 'ouvrier' },
]

/** Déduit le niveau du salaire de base (FCFA entiers). */
export function jobLevelForSalary(baseSalary: number): JobLevel {
  for (const { min, level } of JOB_LEVEL_THRESHOLDS) {
    if (baseSalary >= min) return level
  }
  return 'ouvrier'
}

/**
 * Rattrapage des employés DÉJÀ en base — exécuté par les migrations lazy
 * (`utils/schema-migrations.ts`), et NON par le seed.
 *
 * Deux raisons de ne pas le mettre dans le seed :
 *   1. le seed insère en `ON CONFLICT (email) DO NOTHING` — renseigner
 *      `job_level` à l'INSERT ne change rien aux lignes existantes ;
 *   2. en prod le seed s'arrête net (mode PRÉSERVATION, seed.ts) dès qu'un
 *      schéma tenant existe : son corps n'est jamais exécuté.
 * Constaté le 25/07/2026 : après redéploiement, les 82 employés SOTRA étaient
 * toujours à NULL, donc les 3 offres internes ouvertes sans destinataire.
 *
 * Portée volontairement ÉTROITE — la clause NOT EXISTS restreint la reprise aux
 * tenants dont AUCUN employé n'a de niveau, c'est-à-dire l'état cassé exact.
 * Dès qu'un seul niveau existe (reprise déjà faite, ou saisie RH en cours), le
 * statement devient un no-op définitif : on ne réécrit jamais par-dessus une
 * saisie humaine, et le rejeu à chaque démarrage de pod est sans effet.
 *
 * Le CASE est dérivé de JOB_LEVEL_THRESHOLDS pour ne pas pouvoir diverger de
 * jobLevelForSalary().
 */
export function jobLevelBackfillSql(schemaName: string): string {
  const whens = JOB_LEVEL_THRESHOLDS
    .filter(({ min }) => min > 0)
    .map(({ min, level }) => `        WHEN base_salary >= ${min} THEN '${level}'`)
    .join('\n')
  const fallback = JOB_LEVEL_THRESHOLDS[JOB_LEVEL_THRESHOLDS.length - 1]!.level
  return `
    UPDATE "${schemaName}".employees
       SET job_level = CASE
${whens}
        ELSE '${fallback}'
      END
     WHERE (job_level IS NULL OR job_level = '')
       AND NOT EXISTS (
         SELECT 1 FROM "${schemaName}".employees
          WHERE job_level IS NOT NULL AND job_level <> ''
       )`
}
