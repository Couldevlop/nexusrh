import { publishEvent } from './redis.service'
import { logger } from '../utils/logger'

export interface Notification {
  id: string
  userId: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  link?: string
  read: boolean
  createdAt: string
}

export async function sendNotification(
  userId: string,
  notification: Omit<Notification, 'id' | 'userId' | 'read' | 'createdAt'>
): Promise<void> {
  const fullNotification: Notification = {
    id: crypto.randomUUID(),
    userId,
    ...notification,
    read: false,
    createdAt: new Date().toISOString(),
  }

  try {
    await publishEvent(`notifications:${userId}`, fullNotification)
    logger.debug({ userId, type: notification.type }, 'Notification envoyée')
  } catch (err) {
    logger.error({ err, userId }, 'Erreur envoi notification')
  }
}

export async function sendAbsenceApprovalNotification(
  employeeUserId: string,
  approved: boolean,
  absenceType: string,
  startDate: string
): Promise<void> {
  await sendNotification(employeeUserId, {
    type: approved ? 'success' : 'warning',
    title: approved ? 'Absence approuvée' : 'Absence refusée',
    message: approved
      ? `Votre demande de ${absenceType} à partir du ${startDate} a été approuvée.`
      : `Votre demande de ${absenceType} à partir du ${startDate} a été refusée.`,
    link: '/self-service/absences',
  })
}

export async function sendPaySlipAvailableNotification(
  employeeUserId: string,
  month: string,
  year: number
): Promise<void> {
  await sendNotification(employeeUserId, {
    type: 'info',
    title: 'Bulletin de paie disponible',
    message: `Votre bulletin de paie de ${month} ${year} est disponible.`,
    link: '/self-service/payslips',
  })
}
