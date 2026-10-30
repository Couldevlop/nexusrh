/**
 * Embauche d'un candidat : passage en `hired` ⇒ fiche employé + parcours
 * d'intégration.
 *
 * Voie de création = celle de `POST /employees` (services/employee-create) :
 * même INSERT (chiffrement NNI/RIB, matricule attribué par le trigger), même
 * audit, même événement `employee.created` pour les webhooks. Le parcours
 * d'intégration est, lui, GARANTI (ensureHireOnboarding) au lieu d'être
 * best-effort : modèle le plus pertinent, sinon modèle standard du tenant.
 *
 * Idempotence : la candidature est verrouillée (FOR UPDATE) le temps de la
 * résolution, et `applications.employee_id` mémorise la fiche. Réembaucher,
 * ou dé-recruter puis recruter à nouveau, réutilise la même fiche.
 *
 * Résolution de la fiche, dans l'ordre :
 *   1. fiche déjà liée à la candidature (non supprimée) ;
 *   2. candidature interne → fiche de l'employé candidat ;
 *   3. fiche active portant le même email → liée, pas de doublon ;
 *   4. sinon création, pré-remplie depuis la candidature, l'offre et les
 *      conditions du dernier contrat généré (`offer_details`). Ce qui manque
 *      (salaire, CNPS, date de naissance…) est signalé « fiche à compléter ».
 */
import { pool } from '../../db/pool.js'
import { ensureTenantSchema } from '../../utils/schema-migrations.js'
import { describeDbError } from '../../utils/db-error.js'
import { auditTenant } from '../../utils/audit-log.js'
import { loadEmployeeTenantContext } from '../../services/employee-tenant-context.service.js'
import { validateCustomFieldValues } from '../../services/employee-custom-fields.service.js'
import {
  EMPLOYEE_CONTRACT_TYPES, afterEmployeeCreated, insertEmployeeRecord,
  type EmployeeContractType, type NewEmployee,
} from '../../services/employee-create.service.js'
import { ensureHireOnboarding, type HireOnboardingResult } from '../../services/onboarding.service.js'
import { actorUuid } from './stage-history.js'
import { CONTRACT_PROPOSAL_CATEGORY, linkProposalsToEmployee } from './contract-proposal.service.js'
import { CONTRACT_PROPOSAL_DOCUMENT_TITLE } from '../../db/contract-proposals.js'

/** Valeurs saisies dans la modale « Créer la fiche employé » (toutes facultatives). */
export interface HireOverrides {
  hireDate?: string
  departmentId?: string | null
  legalEntityId?: string | null
  baseSalary?: number
  contractType?: EmployeeContractType
  jobTitle?: string
  professionalCategory?: string
}

/** Conditions mémorisées à la génération du contrat (POST /applications/:id/contract). */
export interface OfferDetails {
  type?: 'cdi_ci' | 'cdd_ci'
  salary?: number
  startDate?: string
  endDate?: string
  isCadre?: boolean
  category?: string
  jobTitle?: string
  generatedAt?: string
}

export type HireStatus = 'created' | 'already_linked' | 'linked_internal' | 'linked_existing'

export interface HireResult {
  status: HireStatus
  employeeId: string
  employeeNumber: string | null
  /** Champs à compléter sur la fiche (création avec les seules données connues). */
  toComplete: string[]
  onboarding: HireOnboardingResult | null
  /** Le parcours n'a pas pu être créé (la fiche, elle, existe). */
  onboardingError: boolean
  /**
   * Contrat généré pour la candidature, versé au dossier salarié
   * (employee_documents.id) — null si aucun contrat n'a été généré, s'il y
   * figurait déjà (idempotence) ou si la fiche reliée préexistait.
   */
  contractDocumentId: string | null
}

export class HireError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string) {
    super(message)
    this.name = 'HireError'
  }
}

export interface HireActor {
  userId: string
  ip: string | null
}

interface ApplicationForHire {
  id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  internal_employee_id: string | null
  employee_id: string | null
  offer_details: OfferDetails | null
  job_title: string | null
  job_department_id: string | null
  job_legal_entity_id: string | null
  job_contract_type: string | null
  /** Niveau de poste de l'offre (recruitment_jobs.job_level), null si colonne absente. */
  job_level: string | null
}

interface EmployeeLite {
  id: string
  employee_number: string | null
  job_title: string | null
  job_level: string | null
  department_id: string | null
  hire_date: string | null
  deleted_at: string | null
}

const EMPLOYEE_LITE_COLUMNS = `id, employee_number, job_title, job_level, department_id,
  hire_date::text AS hire_date, deleted_at`

/** Email synthétique des profils sourcés par IA : jamais recopié sur une fiche. */
function realEmail(email: string | null): string | null {
  if (!email) return null
  const e = email.trim().toLowerCase()
  if (e.endsWith('.sourced@example.com')) return null
  return e
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function contractTypeFrom(overrides: HireOverrides, offer: OfferDetails | null, jobContractType: string | null): EmployeeContractType {
  if (overrides.contractType) return overrides.contractType
  if (offer?.type === 'cdd_ci') return 'cdd'
  if (offer?.type === 'cdi_ci') return 'cdi'
  const job = (jobContractType ?? '').trim().toLowerCase()
  const known = EMPLOYEE_CONTRACT_TYPES.find((t) => t === job)
  return known ?? 'cdi'
}

/** Défauts de la fiche à créer — sert aussi au pré-remplissage de la modale. */
export function buildHirePrefill(app: ApplicationForHire, overrides: HireOverrides = {}): {
  hireDate: string; departmentId: string | null; legalEntityId: string | null
  baseSalary: number | null; contractType: EmployeeContractType; jobTitle: string | null
  professionalCategory: string | null
} {
  const offer = app.offer_details
  return {
    hireDate: overrides.hireDate ?? offer?.startDate ?? todayIso(),
    departmentId: overrides.departmentId !== undefined ? overrides.departmentId : app.job_department_id,
    legalEntityId: overrides.legalEntityId !== undefined ? overrides.legalEntityId : app.job_legal_entity_id,
    baseSalary: overrides.baseSalary ?? (typeof offer?.salary === 'number' ? offer.salary : null),
    contractType: contractTypeFrom(overrides, offer, app.job_contract_type),
    jobTitle: overrides.jobTitle ?? offer?.jobTitle ?? app.job_title,
    professionalCategory: overrides.professionalCategory ?? offer?.category ?? null,
  }
}

interface TxClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  release(): void
}

async function loadApplication(db: TxClient, schema: string, applicationId: string, lock: boolean): Promise<ApplicationForHire | null> {
  const r = await db.query<ApplicationForHire>(
    `SELECT a.id, a.first_name, a.last_name, a.email, a.phone, a.internal_employee_id,
            a.employee_id, a.offer_details,
            rj.title AS job_title, rj.department_id AS job_department_id,
            rj.target_legal_entity_id AS job_legal_entity_id, rj.contract_type AS job_contract_type,
            -- Lecture tolérante : NULL si la colonne n'existe pas encore sur ce tenant.
            to_jsonb(rj) ->> 'job_level' AS job_level
       FROM "${schema}".applications a
       LEFT JOIN "${schema}".recruitment_jobs rj ON rj.id = a.job_id
      WHERE a.id = $1
      ${lock ? 'FOR UPDATE OF a' : ''}`,
    [applicationId],
  )
  return r.rows[0] ?? null
}

async function findEmployee(db: TxClient, schema: string, where: string, value: string): Promise<EmployeeLite | null> {
  const r = await db.query<EmployeeLite>(
    `SELECT ${EMPLOYEE_LITE_COLUMNS} FROM "${schema}".employees WHERE ${where} LIMIT 1`, [value],
  )
  return r.rows[0] ?? null
}

/** Pré-remplissage de la modale d'embauche (lecture seule). null = candidature inconnue. */
export async function getHirePrefill(schema: string, applicationId: string): Promise<(ReturnType<typeof buildHirePrefill> & {
  firstName: string; lastName: string; email: string | null; phone: string | null
  employeeId: string | null; existingEmployeeId: string | null
}) | null> {
  await ensureTenantSchema(schema)
  const client = await pool.connect() as unknown as TxClient
  try {
    const app = await loadApplication(client, schema, applicationId, false)
    if (!app) return null
    const email = realEmail(app.email)
    const existing = email
      ? await findEmployee(client, schema, 'lower(email) = $1 AND deleted_at IS NULL', email)
      : null
    return {
      ...buildHirePrefill(app),
      firstName: app.first_name, lastName: app.last_name, email, phone: app.phone,
      employeeId: app.employee_id, existingEmployeeId: existing?.id ?? app.internal_employee_id ?? null,
    }
  } finally {
    client.release()
  }
}

/**
 * Crée (ou relie) la fiche employé d'une candidature recrutée, puis garantit
 * son parcours d'intégration. Renvoie null si la candidature n'existe pas.
 * Lève HireError (statut HTTP + message) quand la fiche ne peut pas être créée.
 */
export async function hireApplication(
  schema: string,
  applicationId: string,
  overrides: HireOverrides,
  actor: HireActor,
): Promise<HireResult | null> {
  await ensureTenantSchema(schema)
  const client = await pool.connect() as unknown as TxClient
  let status: HireStatus
  let employee: EmployeeLite
  let created: { row: Record<string, unknown> & { id: string }; body: NewEmployee } | null = null
  const toComplete: string[] = []
  try {
    await client.query('BEGIN')
    const app = await loadApplication(client, schema, applicationId, true)
    if (!app) {
      await client.query('ROLLBACK')
      return null
    }

    const linked = app.employee_id
      ? await findEmployee(client, schema, 'id = $1::uuid AND deleted_at IS NULL', app.employee_id)
      : null
    const internal = !linked && app.internal_employee_id
      ? await findEmployee(client, schema, 'id = $1::uuid AND deleted_at IS NULL', app.internal_employee_id)
      : null
    let email = realEmail(app.email)
    const sameEmail = !linked && !internal && email
      ? await findEmployee(client, schema, 'lower(email) = $1', email)
      : null

    if (linked) {
      status = 'already_linked'; employee = linked
    } else if (internal) {
      status = 'linked_internal'; employee = internal
    } else if (sameEmail && !sameEmail.deleted_at) {
      status = 'linked_existing'; employee = sameEmail
    } else {
      // Fiche archivée portant le même email : l'email est unique en base, la
      // nouvelle fiche est créée sans (à compléter) plutôt que d'échouer.
      if (sameEmail?.deleted_at) { email = null; toComplete.push('email') }
      if (!email && !toComplete.includes('email')) toComplete.push('email')

      const prefill = buildHirePrefill(app, overrides)
      const ctx = await loadEmployeeTenantContext(client, schema, prefill.legalEntityId)
      const pack = ctx.legislation.legislationPack
      let baseSalary = prefill.baseSalary
      if (baseSalary !== null && baseSalary < pack.smigMensuel) {
        throw new HireError(422,
          `Le salaire ne peut pas être inférieur au SMIG (${String(pack.smigMensuel).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')})`,
          'SALARY_BELOW_SMIG')
      }
      // Salaire inconnu : 0 = fiche hors paie tant qu'elle n'est pas complétée
      // (même convention que la fiche « à compléter » de l'admin du tenant).
      if (baseSalary === null) { baseSalary = 0; toComplete.push('baseSalary') }
      toComplete.push('cnpsNumber', 'birthDate', 'nni')

      const custom = validateCustomFieldValues(ctx.customFields, {}, 'create')
      const customValues = custom.ok ? custom.values : {}
      if (!custom.ok) toComplete.push('customFields')

      const body: NewEmployee = {
        firstName: app.first_name,
        lastName: app.last_name,
        ...(email ? { email } : {}),
        ...(app.phone ? { phone: app.phone.slice(0, 30) } : {}),
        ...(prefill.departmentId ? { departmentId: prefill.departmentId } : {}),
        ...(prefill.legalEntityId ? { legalEntityId: prefill.legalEntityId } : {}),
        ...(prefill.jobTitle ? { jobTitle: prefill.jobTitle.slice(0, 100) } : {}),
        ...(prefill.professionalCategory ? { professionalCategory: prefill.professionalCategory.slice(0, 50) } : {}),
        // Niveau de poste de l'offre : pilote les offres internes ciblées et le
        // choix du modèle d'intégration.
        ...(app.job_level?.trim() ? { jobLevel: app.job_level.trim().slice(0, 50) } : {}),
        contractType: prefill.contractType,
        hireDate: prefill.hireDate,
        baseSalary,
      }
      let row: Record<string, unknown> & { id: string }
      try {
        row = await insertEmployeeRecord(client, schema, body, customValues)
      } catch (err) {
        const mapped = describeDbError(err, {
          entity: 'employé',
          uniqueMessages: { email: 'Un employé avec cet email existe déjà.' },
        })
        throw new HireError(mapped?.statusCode ?? 500,
          mapped?.error ?? "Impossible de créer la fiche employé pour le moment.",
          mapped?.code ?? 'EMPLOYEE_CREATE_FAILED')
      }
      created = { row, body }
      status = 'created'
      employee = {
        id: row.id,
        employee_number: typeof row.employee_number === 'string' ? row.employee_number : null,
        job_title: body.jobTitle ?? null,
        job_level: body.jobLevel ?? null,
        department_id: body.departmentId ?? null,
        hire_date: body.hireDate ?? null,
        deleted_at: null,
      }
    }

    if (app.employee_id !== employee.id) {
      await client.query(
        `UPDATE "${schema}".applications SET employee_id = $2::uuid, updated_at = now() WHERE id = $1`,
        [applicationId, employee.id],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }

  if (created) {
    afterEmployeeCreated(pool, schema, created.row, created.body, actor, {
      startOnboarding: false,
      auditChanges: { source: 'recruitment', applicationId, toComplete },
    })
  } else if (status !== 'already_linked') {
    auditTenant(schema, {
      userId: actor.userId, action: 'recruitment.employee_linked', entity: 'application', entityId: applicationId,
      changes: { employeeId: employee.id, status }, ip: actor.ip,
    })
  }

  // Contrat généré pendant le recrutement → dossier salarié de la fiche issue
  // de cette embauche (pas sur une fiche préexistante reliée, dont le contrat
  // courant ne doit pas être remplacé). Best-effort : la fiche existe déjà.
  let contractDocumentId: string | null = null
  if (status === 'created' || status === 'already_linked') {
    contractDocumentId = await attachGeneratedContract(schema, applicationId, employee.id, actor)
      .catch(() => null)
    // Historique des versions rattaché à la fiche (best-effort).
    await linkProposalsToEmployee(schema, applicationId, employee.id).catch(() => undefined)
  }

  let onboarding: HireOnboardingResult | null = null
  let onboardingError = false
  try {
    onboarding = await ensureHireOnboarding(pool, schema, {
      id: employee.id,
      job_title: employee.job_title,
      job_level: employee.job_level,
      department_id: employee.department_id,
      hire_date: employee.hire_date,
    }, applicationId, actorUuid(actor.userId))
  } catch {
    onboardingError = true
  }

  return {
    status, employeeId: employee.id, employeeNumber: employee.employee_number,
    toComplete, onboarding, onboardingError, contractDocumentId,
  }
}

/**
 * Verse la PROPOSITION de contrat courante de la candidature dans
 * `employee_documents`, catégorie `contract_proposal` — jamais
 * `signed_contract` : un document non signé ne doit pas apparaître à
 * l'employé comme son contrat signé (nouvelle version courante ;
 * l'éventuelle version précédente est conservée en historique).
 * Une seule instruction SQL. Idempotent : rien n'est écrit si ce PDF exact
 * figure déjà au dossier de l'employé. Renvoie l'id du document créé, ou null.
 */
/**
 * Proposition générée ou modifiée APRÈS l'embauche : la nouvelle version est
 * rattachée à la fiche et versée à son dossier (contract_proposal), comme à
 * l'embauche. Sans effet tant que la candidature n'est pas recrutée.
 */
export async function fileProposalForHiredApplication(
  schema: string, applicationId: string, actor: HireActor,
): Promise<string | null> {
  const r = await pool.query<{ employee_id: string | null }>(
    `SELECT employee_id FROM "${schema}".applications WHERE id = $1 AND stage = 'hired'`,
    [applicationId],
  )
  const employeeId = r?.rows?.[0]?.employee_id ?? null
  if (!employeeId) return null
  await linkProposalsToEmployee(schema, applicationId, employeeId)
  return attachGeneratedContract(schema, applicationId, employeeId, actor)
}

async function attachGeneratedContract(
  schema: string, applicationId: string, employeeId: string, actor: HireActor,
): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `WITH src AS (
       SELECT a.contract_pdf, a.contract_pdf_name
         FROM "${schema}".applications a
        WHERE a.id = $1 AND a.contract_pdf IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "${schema}".employee_documents d
             WHERE d.employee_id = $2::uuid AND d.category = $3 AND d.bytes = a.contract_pdf)
     ),
     ins AS (
       INSERT INTO "${schema}".employee_documents
         (employee_id, contract_id, category, title, file_name, mime, size_bytes, bytes,
          version, is_current, uploaded_by, uploaded_by_role)
       SELECT $2::uuid, NULL, $3, $4, COALESCE(src.contract_pdf_name, 'contrat.pdf'), 'application/pdf',
              octet_length(src.contract_pdf), src.contract_pdf,
              (SELECT COALESCE(MAX(version), 0) + 1 FROM "${schema}".employee_documents
                WHERE employee_id = $2::uuid AND category = $3 AND contract_id IS NULL),
              true, $5::uuid, 'recruitment'
         FROM src
       RETURNING id
     ),
     prev AS (
       UPDATE "${schema}".employee_documents d SET is_current = false, replaced_by = ins.id
         FROM ins
        WHERE d.employee_id = $2::uuid AND d.category = $3 AND d.contract_id IS NULL
          AND d.is_current = true AND d.id <> ins.id
     )
     SELECT id FROM ins`,
    [applicationId, employeeId, CONTRACT_PROPOSAL_CATEGORY, CONTRACT_PROPOSAL_DOCUMENT_TITLE, actorUuid(actor.userId)],
  )
  const id = r.rows[0]?.id ?? null
  if (id) {
    auditTenant(schema, {
      userId: actor.userId, action: 'recruitment.contract_filed', entity: 'employee_document', entityId: id,
      changes: { applicationId, employeeId }, ip: actor.ip,
    })
  }
  return id
}
