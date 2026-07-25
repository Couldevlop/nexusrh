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
 * Déduit le niveau du salaire de base (FCFA entiers). Les seuils sont calés sur
 * les grilles des tenants de démo pour que CHAQUE niveau soit représenté :
 * Exploitation (80 000–180 000) couvre ouvrier → agent de maîtrise, et
 * Direction Générale (300 000–600 000) alimente les offres réservées aux cadres.
 */
export function jobLevelForSalary(baseSalary: number): JobLevel {
  if (baseSalary >= 300_000) return 'cadre'
  if (baseSalary >= 150_000) return 'agent_maitrise'
  if (baseSalary >= 110_000) return 'employe'
  return 'ouvrier'
}
