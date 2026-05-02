import {
  findEmployeeById,
  findEmployees,
  createEmployee,
  updateEmployee,
  softDeleteEmployee,
  getNextEmployeeNumber,
  getFirstLegalEntityId,
} from './employees.repository'
import { NotFoundError } from '../../utils/errors'
import { generateEmployeeNumber } from '../../utils/helpers'
import { updateEmployeeIndex, deleteEmployeeFromIndex } from '../../services/search.service'
import type { CreateEmployeeInput, UpdateEmployeeInput } from '@nexusrh/shared'
import type { PaginationParams } from '@nexusrh/shared'
import type { TenantDb } from '../../db/client'
import { getDb } from '../../db/client'
import { legalEntities } from '../../db/schema/employees'

type Db = TenantDb | ReturnType<typeof getDb>

export async function getEmployee(id: string, db?: Db) {
  const employee = await findEmployeeById(id, db)
  if (!employee) throw new NotFoundError('Collaborateur', id)
  return employee
}

export async function listEmployees(
  entityId: string,
  params: PaginationParams & {
    status?: string
    departmentId?: string
    profileType?: string
  } = {},
  db?: Db
) {
  return findEmployees(entityId, params, db)
}

export async function createNewEmployee(
  input: Omit<CreateEmployeeInput, 'entityId'> & { entityId?: string; _tenantName?: string },
  db?: Db
) {
  // Resolve entityId: use provided value, or auto-detect / auto-create a default legal entity
  let entityId = input.entityId
  if (!entityId) {
    const resolved = await getFirstLegalEntityId(db)
    if (resolved) {
      entityId = resolved
    } else {
      // Auto-create a default legal entity so employee creation never fails
      // due to missing company setup (common for tenants created via the platform UI)
      const dbInstance = db ?? getDb()
      const defaultName = input._tenantName ?? 'Entreprise principale'
      const [created] = await dbInstance
        .insert(legalEntities)
        .values({ name: defaultName, countryCode: 'FR' })
        .returning()
      if (!created) throw new Error('Impossible de créer l\'entité juridique par défaut')
      entityId = created.id
    }
  }

  const seq = await getNextEmployeeNumber(entityId, db)
  const employeeNumber = generateEmployeeNumber('EMP', seq)

  const employee = await createEmployee({
    ...input,
    entityId,
    employeeNumber,
    status: 'active',
    aiScoreFactors: [],
    customFields: input.customFields ?? {},
  }, db)

  if (!employee) throw new Error('Erreur lors de la création du collaborateur')

  // Index in Meilisearch (best-effort — don't fail if search service is down)
  try {
    await updateEmployeeIndex({
      id: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      jobTitle: employee.jobTitle,
      employeeNumber: employee.employeeNumber,
      entityId: employee.entityId,
      departmentId: employee.departmentId,
      status: employee.status,
      profileType: employee.profileType,
    })
  } catch {
    // Meilisearch might be unavailable — log but don't fail the request
  }

  return employee
}

export async function updateExistingEmployee(
  id: string,
  input: UpdateEmployeeInput,
  db?: Db
) {
  const existing = await findEmployeeById(id, db)
  if (!existing) throw new NotFoundError('Collaborateur', id)

  const updated = await updateEmployee(id, input, db)
  if (!updated) throw new Error('Erreur lors de la mise à jour')

  try {
    await updateEmployeeIndex({
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      jobTitle: updated.jobTitle,
      employeeNumber: updated.employeeNumber,
      entityId: updated.entityId,
      departmentId: updated.departmentId,
      status: updated.status,
    })
  } catch {
    // Meilisearch might be unavailable
  }

  return updated
}

export async function archiveEmployee(id: string, db?: Db) {
  const existing = await findEmployeeById(id, db)
  if (!existing) throw new NotFoundError('Collaborateur', id)

  await softDeleteEmployee(id, db)

  try {
    await deleteEmployeeFromIndex(id)
  } catch {
    // Meilisearch might be unavailable
  }
}
