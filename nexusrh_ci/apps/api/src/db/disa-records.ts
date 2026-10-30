/**
 * DISA par filiale (multi-filiales) — migration idempotente partagée par
 * provisioning.ts (nouveaux tenants, migrate-tenants) et schema-migrations.ts
 * (tenants existants : en prod le corps du seed ne tourne jamais).
 *
 * Avant : `year int NOT NULL UNIQUE` (contrainte `disa_records_year_key`) →
 * générer la DISA de la filiale A écrasait celle de la filiale B la même année.
 * Après : unicité (year, legal_entity_id) NULLS NOT DISTINCT — NULL = tenant
 * mono-entité (une seule DISA par an, comportement inchangé).
 *
 * Ordre : la colonne legal_entity_id et la table legal_entities doivent exister.
 * Clé étrangère NOT VALID : appliquée aux nouvelles lignes sans revalider
 * l'historique (une ligne orpheline ne bloque pas la migration). ON DELETE
 * RESTRICT : une DISA déposée est une pièce légale, la filiale n'est pas
 * supprimable tant qu'elle en porte une.
 */
export function disaPerEntityStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `ALTER TABLE ${s}.disa_records ADD COLUMN IF NOT EXISTS legal_entity_id uuid`,
    `ALTER TABLE ${s}.disa_records DROP CONSTRAINT IF EXISTS disa_records_year_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_${schemaName}_disa_year_le"
       ON ${s}.disa_records (year, legal_entity_id) NULLS NOT DISTINCT`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'disa_records_legal_entity_fk'
            AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schemaName}')
       ) THEN
         ALTER TABLE ${s}.disa_records
           ADD CONSTRAINT disa_records_legal_entity_fk FOREIGN KEY (legal_entity_id)
           REFERENCES ${s}.legal_entities(id) ON DELETE RESTRICT NOT VALID;
       END IF;
     END $$`,
  ]
}
