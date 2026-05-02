import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

// z.coerce.boolean() convertit "false" → true (Boolean("false") === true).
// Ce helper transforme correctement les strings d'env "true"/"false".
const envBool = (defaultVal: boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() === 'true' : v),
    z.boolean().default(defaultVal),
  )

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  app: z.object({
    name: z.string().default('NexusRH'),
    url: z.string().url().default('http://localhost:3000'),
    apiUrl: z.string().url().default('http://localhost:4000'),
    port: z.coerce.number().default(4000),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  }),
  database: z.object({
    url: z.string().min(1),
    poolMin: z.coerce.number().default(2),
    poolMax: z.coerce.number().default(10),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
  }),
  jwt: z.object({
    secret: z.string().min(16),
    expiresIn: z.string().default('7d'),
    refreshExpiresIn: z.string().default('30d'),
  }),
  mfa: z.object({
    issuer: z.string().default('NexusRH'),
  }),
  oauth: z.object({
    google: z.object({
      clientId: z.string().default(''),
      clientSecret: z.string().default(''),
      callbackUrl: z
        .string()
        .default('http://localhost:4000/auth/google/callback'),
    }),
    microsoft: z.object({
      clientId: z.string().default(''),
      clientSecret: z.string().default(''),
      tenantId: z.string().default('common'),
      callbackUrl: z
        .string()
        .default('http://localhost:4000/auth/microsoft/callback'),
    }),
  }),
  anthropic: z.object({
    apiKey: z.string().default(''),
    model: z.string().default('claude-sonnet-4-20250514'),
    maxTokens: z.coerce.number().default(4096),
    temperature: z.coerce.number().default(0.3),
  }),
  email: z.object({
    host: z.string().default('smtp.example.com'),
    port: z.coerce.number().default(587),
    secure: envBool(false),
    user: z.string().default(''),
    pass: z.string().default(''),
    from: z.string().default('NexusRH <noreply@nexusrh.com>'),
  }),
  storage: z.object({
    endpoint: z.string().default('http://localhost:9000'),
    accessKey: z.string().default('minioadmin'),
    secretKey: z.string().default('minioadmin'),
    bucket: z.string().default('nexusrh'),
    region: z.string().default('eu-west-1'),
    forcePathStyle: envBool(true),
  }),
  search: z.object({
    url: z.string().default('http://localhost:7700'),
    masterKey: z.string().default('nexusrh-dev-master-key'),
  }),
  features: z.object({
    aiAssistant: envBool(true),
    predictiveAnalytics: envBool(true),
    electronicSignature: envBool(true),
    multiCountry: envBool(false),
    kioskMode: envBool(true),
  }),
})

const parsed = configSchema.safeParse({
  nodeEnv: process.env['NODE_ENV'],
  app: {
    name: process.env['APP_NAME'],
    url: process.env['APP_URL'],
    apiUrl: process.env['API_URL'],
    port: process.env['API_PORT'],
    logLevel: process.env['LOG_LEVEL'],
  },
  database: {
    url: process.env['DATABASE_URL'],
    poolMin: process.env['DATABASE_POOL_MIN'],
    poolMax: process.env['DATABASE_POOL_MAX'],
  },
  redis: {
    url: process.env['REDIS_URL'],
  },
  jwt: {
    secret: process.env['JWT_SECRET'] ?? 'dev-secret-change-me-minimum-32-chars',
    expiresIn: process.env['JWT_EXPIRES_IN'],
    refreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'],
  },
  mfa: {
    issuer: process.env['MFA_ISSUER'],
  },
  oauth: {
    google: {
      clientId: process.env['GOOGLE_CLIENT_ID'],
      clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
      callbackUrl: process.env['GOOGLE_CALLBACK_URL'],
    },
    microsoft: {
      clientId: process.env['MICROSOFT_CLIENT_ID'],
      clientSecret: process.env['MICROSOFT_CLIENT_SECRET'],
      tenantId: process.env['MICROSOFT_TENANT_ID'],
      callbackUrl: process.env['MICROSOFT_CALLBACK_URL'],
    },
  },
  anthropic: {
    apiKey: process.env['ANTHROPIC_API_KEY'],
    model: process.env['AI_MODEL'],
    maxTokens: process.env['AI_MAX_TOKENS'],
    temperature: process.env['AI_TEMPERATURE'],
  },
  email: {
    host: process.env['SMTP_HOST'],
    port: process.env['SMTP_PORT'],
    secure: process.env['SMTP_SECURE'],
    user: process.env['SMTP_USER'],
    pass: process.env['SMTP_PASS'],
    from: process.env['SMTP_FROM'],
  },
  storage: {
    endpoint: process.env['S3_ENDPOINT'],
    accessKey: process.env['S3_ACCESS_KEY'],
    secretKey: process.env['S3_SECRET_KEY'],
    bucket: process.env['S3_BUCKET'],
    region: process.env['S3_REGION'],
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'],
  },
  search: {
    url: process.env['MEILISEARCH_URL'],
    masterKey: process.env['MEILISEARCH_MASTER_KEY'],
  },
  features: {
    aiAssistant: process.env['FEATURE_AI_ASSISTANT'],
    predictiveAnalytics: process.env['FEATURE_PREDICTIVE_ANALYTICS'],
    electronicSignature: process.env['FEATURE_ELECTRONIC_SIGNATURE'],
    multiCountry: process.env['FEATURE_MULTI_COUNTRY'],
    kioskMode: process.env['FEATURE_KIOSK_MODE'],
  },
})

if (!parsed.success) {
  console.error('Configuration invalide:', parsed.error.format())
  process.exit(1)
}

export const config = parsed.data
