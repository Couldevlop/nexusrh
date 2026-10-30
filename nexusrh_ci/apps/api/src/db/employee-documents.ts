/**
 * Documents du dossier salarié — table TENANT-SCOPÉE `employee_documents`.
 *
 * Premier usage : le CONTRAT DE TRAVAIL SIGNÉ (category = 'signed_contract'),
 * déposé par la RH (ou le manager si le tenant l'autorise) et consultable par
 * l'employé dans /mon-espace quand l'option tenant est active.
 *
 * Stockage : octets en bytea dans le schéma du tenant (même patron que les
 * photos de profil et les CV) — jamais dans un bucket public cross-tenant.
 * Versionnement : un nouveau dépôt pour le même (employé, contrat) n'écrase
 * rien ; la version précédente passe is_current = false (historique conservé,
 * replaced_by pointe vers la nouvelle version).
 *
 * Partagé par le provisioning (nouveaux tenants) et la migration lazy
 * (ensureTenantSchema, tenants existants) — idempotent.
 */
export function employeeDocumentsTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.employee_documents (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id      uuid NOT NULL,
      contract_id      uuid,
      category         varchar(30) NOT NULL DEFAULT 'signed_contract',
      title            varchar(200),
      file_name        varchar(255) NOT NULL,
      mime             varchar(100) NOT NULL,
      size_bytes       integer NOT NULL DEFAULT 0,
      bytes            bytea NOT NULL,
      version          integer NOT NULL DEFAULT 1,
      is_current       boolean NOT NULL DEFAULT true,
      replaced_by      uuid,
      uploaded_by      uuid,
      uploaded_by_role varchar(20),
      created_at       timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_employee_documents_emp_idx"
       ON ${s}.employee_documents(employee_id, category, created_at DESC)`,
  ]
}
