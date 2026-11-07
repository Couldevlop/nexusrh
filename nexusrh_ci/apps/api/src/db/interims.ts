/**
 * Intérims de validation — table TENANT-SCOPÉE `approval_interims`.
 *
 * Un membre de l'équipe RH ou un responsable part en congé, et le circuit de
 * validation s'arrête : les demandes de son équipe attendent son retour. La
 * table enregistre QUI remplace QUI, et sur quelle période.
 *
 * Elle ne donne aucun droit nouveau : le suppléant agit là où l'absent était
 * le valideur désigné, pas ailleurs. Le pouvoir est borné par la période, la
 * révocation est possible à tout moment, et chaque décision prise au titre
 * d'un intérim est tracée dans la piste de validation et dans l'audit.
 *
 * Partagée par le provisioning et la migration lazy (idempotent).
 */
export function interimTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.approval_interims (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      absent_user_id  uuid NOT NULL,
      interim_user_id uuid NOT NULL,
      starts_at       timestamptz NOT NULL DEFAULT now(),
      ends_at         timestamptz NOT NULL,
      reason          varchar(200),
      -- Congé d'origine : l'intérim est ADOSSÉ à l'absence déjà saisie, ses
      -- bornes en sont déduites. Une délégation d'habilitation, elle, est un
      -- acte volontaire de son titulaire, sans congé pour origine.
      absence_id      uuid,
      created_by      uuid,
      revoked_at      timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT approval_interims_not_self CHECK (absent_user_id <> interim_user_id)
    )`,
    // Recherche des intérims en cours : par suppléant (droit d'agir) et par
    // remplacé (liste de l'écran).
    `CREATE INDEX IF NOT EXISTS "${schemaName}_approval_interims_interim_idx"
       ON ${s}.approval_interims(interim_user_id) WHERE revoked_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_approval_interims_absent_idx"
       ON ${s}.approval_interims(absent_user_id) WHERE revoked_at IS NULL`,
    // Tenants provisionnés avant l'adossement au congé.
    `ALTER TABLE ${s}.approval_interims ADD COLUMN IF NOT EXISTS absence_id uuid`,
  ]
}
