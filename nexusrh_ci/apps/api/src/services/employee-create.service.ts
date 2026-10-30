/**
 * Création d'une fiche employé — voie UNIQUE partagée par `POST /employees` et
 * l'embauche depuis le recrutement (`applications` → `hired`).
 *
 *   - insertEmployeeRecord : l'INSERT (NNI et RIB chiffrés, défauts CI :
 *     40 h, Abidjan, Mobile Money, nationalité). Le matricule non fourni est
 *     attribué par le trigger de la base (db/employee-number.ts).
 *   - afterEmployeeCreated : effets de bord de la création — audit (A09),
 *     événement d'intégration `employee.created` (webhooks) et, sauf demande
 *     contraire, auto-démarrage du parcours d'intégration.
 *
 * Accepte un `Queryable` pour pouvoir s'exécuter dans la transaction de
 * l'appelant (embauche) ou directement sur le pool (`POST /employees`).
 */
import type { Pool } from 'pg'
import { encryptIfPresent, decryptIfPresent } from '@nexusrhci/shared/crypto'
import { emitIntegrationEvent } from './integrations.service.js'
import { autoStartOnboarding } from './onboarding.service.js'
import { auditTenant } from '../utils/audit-log.js'

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export type EmployeeContractType = 'cdi' | 'cdd' | 'saisonnier' | 'apprentissage' | 'stage' | 'mise_a_disposition'
export const EMPLOYEE_CONTRACT_TYPES: readonly EmployeeContractType[] =
  ['cdi', 'cdd', 'saisonnier', 'apprentissage', 'stage', 'mise_a_disposition']

/** Données d'une nouvelle fiche (forme validée de `POST /employees`). */
export interface NewEmployee {
  firstName: string
  lastName: string
  email?: string
  phone?: string
  birthDate?: string
  gender?: 'M' | 'F' | 'X'
  nni?: string
  cnpsNumber?: string
  mobileMoneyProvider?: string
  mobileMoneyPhone?: string
  departmentId?: string
  managerId?: string
  legalEntityId?: string
  jobTitle?: string
  jobLevel?: string
  contractType?: EmployeeContractType
  hireDate?: string
  baseSalary: number
  weeklyHours?: number
  professionalCategory?: string
  iban?: string
  bankName?: string
  paymentMethod?: 'mobile_money' | 'bank_transfer'
  city?: string
  maritalStatus?: 'single' | 'married' | 'divorced' | 'widowed' | 'cohabiting'
  nationality?: string
  childrenCount?: number
  employeeNumber?: string
}

export interface CreatedEmployeeRow extends Record<string, unknown> {
  id: string
}

/** INSERT de la fiche. Les erreurs SQL remontent à l'appelant (mapping de message). */
export async function insertEmployeeRecord(
  db: Queryable,
  schema: string,
  body: NewEmployee,
  customValues: Record<string, unknown>,
): Promise<CreatedEmployeeRow> {
  const res = await db.query<CreatedEmployeeRow>(
    `INSERT INTO "${schema}".employees
       (first_name, last_name, email, phone, birth_date, gender,
        nni, cnps_number, mobile_money_provider, mobile_money_phone,
        department_id, manager_id, legal_entity_id, job_title, job_level, contract_type,
        hire_date, base_salary, weekly_hours, professional_category,
        iban, bank_name, payment_method, city, marital_status, children_count, custom_fields, nationality,
        employee_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,COALESCE($28,'Ivoirienne'),$29)
     RETURNING *`,
    [
      body.firstName, body.lastName, body.email ?? null, body.phone ?? null,
      body.birthDate ?? null, body.gender ?? null,
      encryptIfPresent(body.nni), body.cnpsNumber ?? null,
      body.mobileMoneyProvider ?? null, body.mobileMoneyPhone ?? null,
      body.departmentId ?? null, body.managerId ?? null, body.legalEntityId ?? null,
      body.jobTitle ?? null, body.jobLevel ?? null, body.contractType ?? 'cdi',
      body.hireDate ?? null, body.baseSalary,
      // Base légale CI : 40h hebdomadaires par défaut
      body.weeklyHours ?? 40, body.professionalCategory ?? null,
      // RGPD — RIB chiffré AES-256 (même traitement que le NNI)
      encryptIfPresent(body.iban), body.bankName ?? null,
      body.paymentMethod ?? 'mobile_money',
      body.city ?? 'Abidjan', body.maritalStatus ?? null, body.childrenCount ?? 0,
      JSON.stringify(customValues), body.nationality ?? null,
      body.employeeNumber ?? null,
    ],
  )
  const row = res.rows[0]
  if (!row) throw new Error('INSERT employees sans ligne retournée')
  return row
}

export interface EmployeeCreationActor {
  userId: string
  ip: string | null
}

/**
 * Effets de bord d'une création réussie — tous best-effort : la fiche existe,
 * rien ici ne doit la faire échouer. `startOnboarding: false` laisse
 * l'appelant gérer le parcours (l'embauche le crée elle-même, de façon garantie).
 */
export function afterEmployeeCreated(
  pool: Pool,
  schema: string,
  row: CreatedEmployeeRow,
  body: NewEmployee,
  actor: EmployeeCreationActor,
  opts: { startOnboarding: boolean; auditChanges?: Record<string, unknown> } = { startOnboarding: true },
): void {
  // OWASP A09 : trace de la création
  auditTenant(schema, {
    userId: actor.userId, action: 'employee.created', entity: 'employee', entityId: row.id,
    changes: {
      firstName: body.firstName, lastName: body.lastName,
      email: body.email ?? null, jobTitle: body.jobTitle ?? null,
      baseSalary: body.baseSalary,
      ...(opts.auditChanges ?? {}),
    },
    ip: actor.ip,
  })

  // Connectivité : notifie les outils externes abonnés (non bloquant).
  emitIntegrationEvent(pool, schema, 'employee.created', {
    id: row.id, firstName: body.firstName, lastName: body.lastName,
    email: body.email ?? null, jobTitle: body.jobTitle ?? null,
  }, decryptIfPresent)

  // Parcours d'intégration : auto-création depuis le modèle le plus
  // pertinent (séniorité / type de poste). Non bloquant — la création de
  // l'employé ne doit jamais échouer à cause de l'onboarding.
  if (opts.startOnboarding) {
    autoStartOnboarding(pool, schema, {
      id: row.id,
      job_title: body.jobTitle ?? null,
      job_level: body.jobLevel ?? null,
      department_id: body.departmentId ?? null,
      hire_date: body.hireDate ?? null,
    }, actor.userId).catch(() => { /* best-effort */ })
  }
}
