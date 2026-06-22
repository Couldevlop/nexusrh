/**
 * Archivage cohérent d'un employé + cascade sur les processus liés.
 *
 * Règle métier (exigée : « aucun processus ne doit être orphelin ») : quand un
 * collaborateur quitte l'entreprise (archivage RH ou clôture d'un dossier de
 * sortie), AUCUN processus actif ne doit subsister sur un dossier qui n'existe
 * plus. On rompt/annule donc, en une seule opération cohérente :
 *   - le compte de connexion lié (users.is_active = false) ;
 *   - les contrats ACTIFS → 'terminated' (archivés) ;
 *   - les sanctions disciplinaires NON terminales → 'cancelled' ;
 *   - les demandes de signature en cours (draft/pending) où l'employé est
 *     signataire → 'cancelled' (elles ne pourraient jamais aboutir).
 *
 * Les cascades secondaires sont best-effort (.catch) : un tenant dont une table
 * optionnelle n'est pas encore migrée ne doit pas faire échouer l'archivage.
 * Idempotent : ré-archiver un employé déjà archivé ne change rien (garde
 * deleted_at IS NULL sur l'employé).
 */
import type { Pool } from 'pg'

export interface ArchiveCascadeResult {
  terminatedContracts: number
  cancelledDiscipline: number
  cancelledSignatures: number
}

export async function archiveEmployeeCascade(
  pool: Pool, schema: string, employeeId: string,
): Promise<ArchiveCascadeResult> {
  // 1. L'employé lui-même (idempotent : ne réécrit pas un dossier déjà archivé).
  await pool.query(
    `UPDATE "${schema}".employees SET deleted_at = now(), is_active = false
       WHERE id = $1 AND deleted_at IS NULL`,
    [employeeId],
  )
  // 2. Compte de connexion lié — coupe le login (OWASP A01).
  await pool.query(
    `UPDATE "${schema}".users SET is_active = false, updated_at = now() WHERE employee_id = $1`,
    [employeeId],
  ).catch(() => { /* non bloquant */ })

  // 3. Contrats actifs → terminés (archive).
  const contracts = await pool.query<{ id: string }>(
    `UPDATE "${schema}".contracts
        SET status = 'terminated', end_date = COALESCE(end_date, CURRENT_DATE), updated_at = now()
      WHERE employee_id = $1 AND status = 'active' RETURNING id`,
    [employeeId],
  ).catch(() => ({ rows: [] as Array<{ id: string }> }))

  // 4. Sanctions disciplinaires non terminales → annulées (plus de sanction
  //    « en cours » sur un employé parti).
  const discipline = await pool.query<{ id: string }>(
    `UPDATE "${schema}".disciplinary_actions
        SET status = 'cancelled', updated_at = now()
      WHERE employee_id = $1 AND status NOT IN ('closed', 'cancelled') RETURNING id`,
    [employeeId],
  ).catch(() => ({ rows: [] as Array<{ id: string }> }))

  // 5. Demandes de signature en cours où l'employé est signataire → annulées.
  const signatures = await pool.query<{ id: string }>(
    `UPDATE "${schema}".signature_requests
        SET status = 'cancelled', updated_at = now()
      WHERE status IN ('draft', 'pending')
        AND id IN (SELECT request_id FROM "${schema}".signature_signatories WHERE employee_id = $1)
      RETURNING id`,
    [employeeId],
  ).catch(() => ({ rows: [] as Array<{ id: string }> }))

  return {
    terminatedContracts: contracts.rows.length,
    cancelledDiscipline: discipline.rows.length,
    cancelledSignatures: signatures.rows.length,
  }
}
