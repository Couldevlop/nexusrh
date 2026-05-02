import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { users, refreshTokens } from '../../db/schema/auth'
import { config } from '../../config'
import {
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  BadRequestError,
} from '../../utils/errors'
import { generateSecureToken } from '../../utils/helpers'
import { generateMfaSecret, verifyMfaToken, generateMfaQrCode } from './mfa.service'
import { sendPasswordResetEmail } from '../../services/email.service'
import type { LoginInput, RegisterInput } from './auth.schema'

const SALT_ROUNDS = 12

export async function registerUser(input: RegisterInput) {
  const db = getDb()

  const existing = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  })

  if (existing) {
    throw new ConflictError(`Un utilisateur avec l'email ${input.email} existe déjà`)
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS)

  const [user] = await db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
    })
    .returning()

  if (!user) throw new Error('Erreur lors de la création de l\'utilisateur')

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  }
}

export async function loginUser(input: LoginInput) {
  const db = getDb()

  const user = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  })

  if (!user || !user.isActive) {
    throw new UnauthorizedError('Email ou mot de passe incorrect')
  }

  if (!user.passwordHash) {
    throw new UnauthorizedError('Ce compte utilise la connexion SSO. Utilisez Google ou Microsoft.')
  }

  const passwordValid = await bcrypt.compare(input.password, user.passwordHash)
  if (!passwordValid) {
    throw new UnauthorizedError('Email ou mot de passe incorrect')
  }

  if (user.mfaEnabled) {
    if (!input.mfaCode) {
      return { requiresMfa: true, userId: user.id }
    }
    if (!user.mfaSecret || !verifyMfaToken(input.mfaCode, user.mfaSecret)) {
      throw new UnauthorizedError('Code MFA invalide')
    }
  }

  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id))

  return {
    requiresMfa: false,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      employeeId: user.employeeId,
      mfaEnabled: user.mfaEnabled,
      avatarUrl: user.avatarUrl,
    },
  }
}

export async function createRefreshToken(
  userId: string,
  userAgent?: string,
  ipAddress?: string
): Promise<string> {
  const db = getDb()
  const token = generateSecureToken(64)
  const expiresAt = new Date()
  const days = parseInt(config.jwt.refreshExpiresIn.replace('d', ''), 10) || 30
  expiresAt.setDate(expiresAt.getDate() + days)

  await db.insert(refreshTokens).values({
    userId,
    token,
    userAgent,
    ipAddress,
    expiresAt,
  })

  return token
}

export async function refreshAccessToken(token: string) {
  const db = getDb()

  const refreshToken = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.token, token),
    with: { userId: true } as never,
  })

  if (!refreshToken || refreshToken.expiresAt < new Date()) {
    throw new UnauthorizedError('Token de rafraîchissement invalide ou expiré')
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, refreshToken.userId),
  })

  if (!user || !user.isActive) {
    throw new UnauthorizedError('Utilisateur introuvable ou désactivé')
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    employeeId: user.employeeId,
  }
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const db = getDb()
  await db.delete(refreshTokens).where(eq(refreshTokens.token, token))
}

export async function setupMfa(userId: string) {
  const db = getDb()

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  if (!user) throw new NotFoundError('Utilisateur', userId)
  if (user.mfaEnabled) throw new ConflictError('MFA déjà activé')

  const secret = generateMfaSecret()
  const qrCode = await generateMfaQrCode(user.email, secret)

  await db
    .update(users)
    .set({ mfaSecret: secret, updatedAt: new Date() })
    .where(eq(users.id, userId))

  return { secret, qrCode }
}

export async function confirmMfa(userId: string, code: string): Promise<void> {
  const db = getDb()

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  if (!user) throw new NotFoundError('Utilisateur', userId)
  if (!user.mfaSecret) throw new BadRequestError('Configurez d\'abord le MFA')

  if (!verifyMfaToken(code, user.mfaSecret)) {
    throw new BadRequestError('Code MFA invalide')
  }

  await db
    .update(users)
    .set({ mfaEnabled: true, updatedAt: new Date() })
    .where(eq(users.id, userId))
}

export async function requestPasswordReset(email: string): Promise<void> {
  const db = getDb()

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  })

  if (!user) return // Ne pas révéler si l'email existe

  const token = generateSecureToken(32)
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + 1)

  await db
    .update(users)
    .set({
      passwordResetToken: token,
      passwordResetExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))

  const resetUrl = `${config.app.url}/auth/reset-password?token=${token}`
  await sendPasswordResetEmail(user.email, user.firstName, resetUrl)
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const db = getDb()

  const user = await db.query.users.findFirst({
    where: eq(users.passwordResetToken, token),
  })

  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
    throw new BadRequestError('Token de réinitialisation invalide ou expiré')
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS)

  await db
    .update(users)
    .set({
      passwordHash,
      passwordResetToken: null,
      passwordResetExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
}
