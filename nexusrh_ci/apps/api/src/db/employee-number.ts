/**
 * Matricule salarié (`employees.employee_number`) — génération automatique.
 *
 * Constat recette : aucune voie de création (POST /employees, fiche admin,
 * import CSV, création de compte, seeds) ne renseignait le matricule → NULL
 * partout, et l'export SAGE « Matricule interne » sortait l'UUID technique.
 *
 * La génération est portée par la BASE (trigger BEFORE INSERT/UPDATE) pour
 * couvrir toutes les voies d'écriture d'un coup, sans dépendre du code appelant :
 *  - séquence PostgreSQL PAR SCHÉMA (`employee_number_seq`) → concurrence sûre
 *    (nextval n'attribue jamais deux fois le même nombre) ;
 *  - format lisible `MAT` + 5 chiffres (MAT00001…), élargi au-delà de 99 999 ;
 *  - une valeur saisie (non vide) est conservée telle quelle (espaces retirés) ;
 *  - une valeur générée qui heurterait un matricule saisi à la main est sautée ;
 *  - un matricule ne peut pas être effacé : NULL/vide en UPDATE reprend l'ancien.
 * Unicité garantie par un index UNIQUE partiel (fiches non supprimées).
 *
 * Une seule source SQL, utilisée par :
 *  - le provisionnement d'un tenant (db/provisioning.ts) ;
 *  - la migration lazy des tenants existants (utils/schema-migrations.ts),
 *    qui fait aussi la reprise (backfill) des fiches sans matricule.
 * Tous les ordres sont idempotents.
 */
import { assertValidSchemaName } from '../utils/schema-name.js'

/** Préfixe du matricule généré. */
export const EMPLOYEE_NUMBER_PREFIX = 'MAT'
/** Nombre minimal de chiffres après le préfixe. */
export const EMPLOYEE_NUMBER_DIGITS = 5
/** Longueur maximale d'un matricule (colonne varchar(50)). */
export const EMPLOYEE_NUMBER_MAX_LENGTH = 50

/** Nom de l'index d'unicité (contient `employee_number` : cf. describeDbError). */
export function employeeNumberIndexName(schemaName: string): string {
  return `${schemaName}_employees_employee_number_uniq`
}

/** DDL : séquence, fonction de génération, trigger et index d'unicité. */
export function employeeNumberSetupStatements(schemaName: string): string[] {
  assertValidSchemaName(schemaName)
  const s = `"${schemaName}"`
  const seq = `${s}.employee_number_seq`
  return [
    `CREATE SEQUENCE IF NOT EXISTS ${seq} START WITH 1 INCREMENT BY 1`,
    // Prochain matricule libre : saute les valeurs déjà prises (saisie manuelle).
    `CREATE OR REPLACE FUNCTION ${s}.next_employee_number() RETURNS text
       LANGUAGE plpgsql AS $fn$
     DECLARE
       n bigint;
       candidate text;
     BEGIN
       LOOP
         n := nextval('${seq}');
         candidate := '${EMPLOYEE_NUMBER_PREFIX}' || lpad(n::text, greatest(${EMPLOYEE_NUMBER_DIGITS}, length(n::text)), '0');
         EXIT WHEN NOT EXISTS (SELECT 1 FROM ${s}.employees WHERE employee_number = candidate);
       END LOOP;
       RETURN candidate;
     END
     $fn$`,
    `CREATE OR REPLACE FUNCTION ${s}.employees_assign_number() RETURNS trigger
       LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.employee_number IS NOT NULL AND btrim(NEW.employee_number) <> '' THEN
         NEW.employee_number := btrim(NEW.employee_number);
         RETURN NEW;
       END IF;
       IF TG_OP = 'UPDATE' AND OLD.employee_number IS NOT NULL AND btrim(OLD.employee_number) <> '' THEN
         NEW.employee_number := OLD.employee_number;
         RETURN NEW;
       END IF;
       NEW.employee_number := ${s}.next_employee_number();
       RETURN NEW;
     END
     $fn$`,
    `CREATE OR REPLACE TRIGGER employees_assign_number
       BEFORE INSERT OR UPDATE OF employee_number ON ${s}.employees
       FOR EACH ROW EXECUTE FUNCTION ${s}.employees_assign_number()`,
    // Doublons préexistants (saisie libre historique) : l'index n'est pas créé
    // plutôt que de faire échouer le provisionnement / la migration ; le
    // contrôle applicatif (409) reste actif.
    `DO $idx$ BEGIN
       CREATE UNIQUE INDEX IF NOT EXISTS "${employeeNumberIndexName(schemaName)}"
         ON ${s}.employees (employee_number)
         WHERE employee_number IS NOT NULL AND deleted_at IS NULL;
     EXCEPTION WHEN unique_violation THEN
       RAISE NOTICE 'matricules en double dans %, index d''unicité non créé', '${schemaName}';
     END $idx$`,
  ]
}

/**
 * Reprise (backfill) : attribue un matricule aux fiches qui n'en ont pas, dans
 * l'ordre d'ancienneté (date d'embauche, puis date de création). Idempotent :
 * ne vise que les matricules NULL/vides ; re-vérifié ligne à ligne (deux pods
 * migrant en parallèle n'écrasent pas un matricule déjà attribué).
 */
export function employeeNumberBackfillStatement(schemaName: string): string {
  assertValidSchemaName(schemaName)
  const s = `"${schemaName}"`
  return `DO $bf$
   DECLARE r record;
   BEGIN
     FOR r IN
       SELECT id FROM ${s}.employees
        WHERE employee_number IS NULL OR btrim(employee_number) = ''
        ORDER BY hire_date ASC NULLS LAST, created_at ASC, id ASC
     LOOP
       UPDATE ${s}.employees
          SET employee_number = ${s}.next_employee_number()
        WHERE id = r.id
          AND (employee_number IS NULL OR btrim(employee_number) = '');
     END LOOP;
   END $bf$`
}

/** Setup complet + reprise, dans l'ordre d'exécution. */
export function employeeNumberStatements(schemaName: string): string[] {
  return [...employeeNumberSetupStatements(schemaName), employeeNumberBackfillStatement(schemaName)]
}