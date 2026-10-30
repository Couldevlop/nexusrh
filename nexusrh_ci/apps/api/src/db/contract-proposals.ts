/**
 * Propositions de contrat — table TENANT-SCOPÉE `contract_proposals`.
 *
 * Le contrat généré au recrutement est une PROPOSITION : la RH l'édite avant
 * envoi, et le contrat finalement signé (déposé en PDF, catégorie
 * `signed_contract` de employee_documents) peut en différer. Chaque
 * enregistrement crée une NOUVELLE version (historique conservé) : la version
 * précédente passe is_current = false.
 *
 * Partagé par le provisioning (nouveaux tenants), la migration lazy
 * (ensureTenantSchema) et la migration recrutement — idempotent.
 */
export function contractProposalsTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.contract_proposals (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id  uuid NOT NULL,
      employee_id     uuid,
      legal_entity_id uuid,
      contract_type   varchar(20) NOT NULL DEFAULT 'cdi_ci',
      offer_details   jsonb NOT NULL DEFAULT '{}',
      markdown        text NOT NULL,
      version         integer NOT NULL DEFAULT 1,
      is_current      boolean NOT NULL DEFAULT true,
      pdf             bytea NOT NULL,
      created_by      uuid,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    // Unicité (candidature, version) : deux enregistrements concurrents ne
    // peuvent pas produire la même version.
    `CREATE UNIQUE INDEX IF NOT EXISTS "${schemaName}_contract_proposals_app_version_uniq"
       ON ${s}.contract_proposals(application_id, version)`,
  ]
}

/** Titre des propositions versées au dossier salarié à l'embauche. */
export const CONTRACT_PROPOSAL_DOCUMENT_TITLE = 'Proposition de contrat (générée au recrutement)'

/**
 * Reprise de données : avant ce correctif, la proposition générée au
 * recrutement était versée au dossier salarié en catégorie `signed_contract`
 * (titre « Contrat de travail (généré au recrutement) ») — l'employé voyait
 * donc un document NON signé comme son contrat signé. On la re-catégorise en
 * `contract_proposal`, puis on rend son statut « courant » au contrat signé
 * qu'elle avait supplanté (si aucun autre n'est courant). Idempotent.
 */
export function contractProposalRecategorizeStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `UPDATE ${s}.employee_documents
        SET category = 'contract_proposal', title = '${CONTRACT_PROPOSAL_DOCUMENT_TITLE.replace(/'/g, "''")}'
      WHERE category = 'signed_contract'
        AND title = 'Contrat de travail (généré au recrutement)'`,
    `UPDATE ${s}.employee_documents d
        SET is_current = true, replaced_by = NULL
       FROM ${s}.employee_documents p
      WHERE d.replaced_by = p.id
        AND p.category = 'contract_proposal'
        AND d.category = 'signed_contract'
        AND d.is_current = false
        AND NOT EXISTS (
          SELECT 1 FROM ${s}.employee_documents c
           WHERE c.employee_id = d.employee_id AND c.category = 'signed_contract'
             AND c.contract_id IS NOT DISTINCT FROM d.contract_id AND c.is_current = true)`,
  ]
}
