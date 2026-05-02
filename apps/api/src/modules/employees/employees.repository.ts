import { eq, and, isNull, desc, asc, sql, count } from 'drizzle-orm'
import { getDb, type TenantDb } from '../../db/client'
import { employees, departments, legalEntities } from '../../db/schema/employees'
import type { NewEmployee } from '../../db/schema/employees'
import type { PaginationParams } from '@nexusrh/shared'

type Db = TenantDb | ReturnType<typeof getDb>

export async function findEmployeeById(id: string, db?: Db) {
  const dbInstance = db ?? getDb()
  const [row] = await dbInstance
    .select({
      id: employees.id,
      entityId: employees.entityId,
      employeeNumber: employees.employeeNumber,
      profileType: employees.profileType,
      firstName: employees.firstName,
      lastName: employees.lastName,
      email: employees.email,
      phone: employees.phone,
      birthDate: employees.birthDate,
      birthPlace: employees.birthPlace,
      nationality: employees.nationality,
      hireDate: employees.hireDate,
      endDate: employees.endDate,
      jobTitle: employees.jobTitle,
      jobLevel: employees.jobLevel,
      departmentId: employees.departmentId,
      managerId: employees.managerId,
      workingTimePercentage: employees.workingTimePercentage,
      weeklyHours: employees.weeklyHours,
      status: employees.status,
      photoUrl: employees.photoUrl,
      hasDisability: employees.hasDisability,
      retentionScore: employees.retentionScore,
      burnoutRisk: employees.burnoutRisk,
      customFields: employees.customFields,
      createdAt: employees.createdAt,
      updatedAt: employees.updatedAt,
      deletedAt: employees.deletedAt,
      departmentName: departments.name,
    })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
  return row ?? null
}

export async function findEmployees(
  entityId: string,
  params: PaginationParams & {
    status?: string
    departmentId?: string
    profileType?: string
  } = {},
  db?: Db
) {
  const dbInstance = db ?? getDb()
  const page = params.page ?? 1
  const limit = params.limit ?? 25
  const offset = (page - 1) * limit

  // entityId filter is optional — when empty, schema isolation guarantees
  // we only see the current tenant's data via search_path
  const conditions: ReturnType<typeof eq>[] = [isNull(employees.deletedAt) as ReturnType<typeof eq>]

  if (entityId) {
    conditions.push(eq(employees.entityId, entityId) as ReturnType<typeof eq>)
  }
  if (params.status) {
    conditions.push(eq(employees.status, params.status) as ReturnType<typeof eq>)
  }
  if (params.departmentId) {
    conditions.push(eq(employees.departmentId, params.departmentId) as ReturnType<typeof eq>)
  }
  if (params.profileType) {
    conditions.push(eq(employees.profileType, params.profileType) as ReturnType<typeof eq>)
  }

  const where = and(...conditions)

  const [data, totalResult] = await Promise.all([
    dbInstance
      .select({
        id: employees.id,
        employeeNumber: employees.employeeNumber,
        firstName: employees.firstName,
        lastName: employees.lastName,
        email: employees.email,
        jobTitle: employees.jobTitle,
        status: employees.status,
        photoUrl: employees.photoUrl,
        hireDate: employees.hireDate,
        retentionScore: employees.retentionScore,
        burnoutRisk: employees.burnoutRisk,
        departmentId: employees.departmentId,
        departmentName: departments.name,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .where(where)
      .orderBy(
        params.sortOrder === 'desc'
          ? desc(employees.lastName)
          : asc(employees.lastName)
      )
      .limit(limit)
      .offset(offset),
    dbInstance
      .select({ count: count() })
      .from(employees)
      .where(where),
  ])

  const total = totalResult[0]?.count ?? 0

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

export async function createEmployee(data: NewEmployee, db?: Db) {
  const dbInstance = db ?? getDb()
  const [employee] = await dbInstance.insert(employees).values(data).returning()
  return employee
}

export async function updateEmployee(
  id: string,
  data: Partial<NewEmployee>,
  db?: Db
) {
  const dbInstance = db ?? getDb()
  const [updated] = await dbInstance
    .update(employees)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
    .returning()
  return updated
}

export async function softDeleteEmployee(id: string, db?: Db) {
  const dbInstance = db ?? getDb()
  await dbInstance
    .update(employees)
    .set({ deletedAt: new Date(), status: 'terminated', updatedAt: new Date() })
    .where(eq(employees.id, id))
}

export async function getEmployeeCount(entityId: string, status?: string, db?: Db) {
  const dbInstance = db ?? getDb()
  const conditions: ReturnType<typeof eq>[] = [isNull(employees.deletedAt) as ReturnType<typeof eq>]
  if (entityId) conditions.push(eq(employees.entityId, entityId) as ReturnType<typeof eq>)
  if (status) conditions.push(eq(employees.status, status) as ReturnType<typeof eq>)

  const [result] = await dbInstance
    .select({ count: count() })
    .from(employees)
    .where(and(...conditions))

  return result?.count ?? 0
}

export async function getNextEmployeeNumber(entityId: string, db?: Db): Promise<number> {
  const dbInstance = db ?? getDb()
  const conditions: ReturnType<typeof eq>[] = []
  if (entityId) conditions.push(eq(employees.entityId, entityId) as ReturnType<typeof eq>)

  const result = await dbInstance
    .select({ count: count() })
    .from(employees)
    .where(conditions.length ? and(...conditions) : undefined)

  return (result[0]?.count ?? 0) + 1
}

/**
 * Resolves the first (primary) legal entity ID for the current tenant schema.
 * Used when creating an employee without an explicit entityId.
 */
export async function getFirstLegalEntityId(db?: Db): Promise<string | null> {
  const dbInstance = db ?? getDb()
  const [entity] = await dbInstance
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .limit(1)
  return entity?.id ?? null
}
