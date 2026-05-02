import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  mfaCode: z.string().length(6).optional(),
})

export const registerSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
      message:
        'Le mot de passe doit contenir au moins une minuscule, une majuscule et un chiffre',
    }),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: z
    .enum(['super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly'])
    .optional()
    .default('employee'),
})

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
})

export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
})

export const passwordResetSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(8)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
})

export const mfaSetupSchema = z.object({
  code: z.string().length(6),
})

export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>
