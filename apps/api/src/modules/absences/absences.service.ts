import { eq, and, between } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { absences, absenceTypes, absenceBalances } from '../../db/schema/absences'
import { NotFoundError, BadRequestError } from '../../utils/errors'
import {
  sendAbsenceApprovalNotification,
} from '../../services/notification.service'
import {
  sendAbsenceNotificationEmail,
} from '../../services/email.service'
import type { CreateAbsenceInput } from '@nexusrh/shared'

function calcWorkingDays(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  let count = 0
  const current = new Date(start)
  while (current <= end) {
    const day = current.getDay()
    if (day !== 0 && day !== 6) count++
    current.setDate(current.getDate() + 1)
  }
  return count
}

export async function createAbsenceRequest(
  input: CreateAbsenceInput,
  requesterId: string
) {
  const db = getDb()

  const absenceType = await db.query.absenceTypes.findFirst({
    where: eq(absenceTypes.id, input.absenceTypeId),
  })
  if (!absenceType) throw new NotFoundError('Type d\'absence', input.absenceTypeId)

  const daysCount = calcWorkingDays(input.startDate, input.endDate)

  const [absence] = await db
    .insert(absences)
    .values({
      employeeId: input.employeeId,
      absenceTypeId: input.absenceTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      startHalf: input.startHalf,
      endHalf: input.endHalf,
      daysCount: daysCount.toString(),
      reason: input.reason,
      status: absenceType.requiresApproval ? 'pending' : 'approved',
    })
    .returning()

  if (!absence) throw new Error('Erreur lors de la création de l\'absence')

  if (absenceType.requiresApproval) {
    await updateBalance(input.employeeId, input.absenceTypeId, 0, daysCount, true)
  } else {
    await updateBalance(input.employeeId, input.absenceTypeId, daysCount, 0, false)
  }

  return absence
}

export async function approveAbsence(
  absenceId: string,
  approverId: string,
  approved: boolean,
  rejectionReason?: string
) {
  const db = getDb()

  const absence = await db.query.absences.findFirst({
    where: eq(absences.id, absenceId),
  })
  if (!absence) throw new NotFoundError('Absence', absenceId)
  if (absence.status !== 'pending') {
    throw new BadRequestError('Cette absence n\'est plus en attente d\'approbation')
  }

  const [updated] = await db
    .update(absences)
    .set({
      status: approved ? 'approved' : 'rejected',
      approvedBy: approverId,
      approvedAt: new Date(),
      rejectionReason: rejectionReason ?? null,
    })
    .where(eq(absences.id, absenceId))
    .returning()

  if (approved) {
    await updateBalance(
      absence.employeeId,
      absence.absenceTypeId,
      Number(absence.daysCount),
      -Number(absence.daysCount),
      false
    )
  } else {
    await updateBalance(absence.employeeId, absence.absenceTypeId, 0, -Number(absence.daysCount), true)
  }

  return updated
}

async function updateBalance(
  employeeId: string,
  absenceTypeId: string,
  takenDelta: number,
  pendingDelta: number,
  isPending: boolean
) {
  const db = getDb()
  const periodLabel = getPeriodLabel()

  const existing = await db.query.absenceBalances.findFirst({
    where: and(
      eq(absenceBalances.employeeId, employeeId),
      eq(absenceBalances.absenceTypeId, absenceTypeId),
      eq(absenceBalances.periodLabel, periodLabel)
    ),
  })

  if (existing) {
    await db
      .update(absenceBalances)
      .set({
        taken: (Number(existing.taken) + takenDelta).toString(),
        pending: Math.max(0, Number(existing.pending) + pendingDelta).toString(),
        updatedAt: new Date(),
      })
      .where(eq(absenceBalances.id, existing.id))
  } else {
    await db.insert(absenceBalances).values({
      employeeId,
      absenceTypeId,
      periodLabel,
      acquired: '0',
      taken: Math.max(0, takenDelta).toString(),
      pending: isPending ? Math.abs(pendingDelta).toString() : '0',
      carried: '0',
    })
  }
}

function getPeriodLabel(): string {
  const now = new Date()
  const month = now.getMonth()
  const year = now.getFullYear()
  const periodYear = month >= 5 ? year : year - 1
  return `${periodYear}-${periodYear + 1}`
}

export async function getAbsenceBalances(employeeId: string) {
  const db = getDb()
  const periodLabel = getPeriodLabel()

  return db.query.absenceBalances.findMany({
    where: and(
      eq(absenceBalances.employeeId, employeeId),
      eq(absenceBalances.periodLabel, periodLabel)
    ),
    with: {
      absenceTypeId: true,
    } as never,
  })
}

export async function listAbsences(
  employeeId: string,
  year?: number
) {
  const db = getDb()
  return db.query.absences.findMany({
    where: eq(absences.employeeId, employeeId),
    orderBy: [absences.startDate],
  })
}

export async function listPendingAbsences(entityId: string) {
  const db = getDb()
  // Join through employees to filter by entity
  return db.query.absences.findMany({
    where: eq(absences.status, 'pending'),
  })
}
