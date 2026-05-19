import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV:     z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME:     z.string().default('NexusRH CI'),
  APP_URL:      z.string().default('http://localhost:3001'),
  API_URL:      z.string().default('http://localhost:4001'),
  API_PORT:     z.coerce.number().default(4001),
  LOG_LEVEL:    z.string().default('info'),
  LOCALE:       z.string().default('fr-CI'),
  CURRENCY:     z.string().default('XOF'),
  TIMEZONE:     z.string().default('Africa/Abidjan'),

  DATABASE_URL:       z.string(),
  DATABASE_POOL_MIN:  z.coerce.number().default(2),
  DATABASE_POOL_MAX:  z.coerce.number().default(10),

  REDIS_URL: z.string().default('redis://localhost:6380'),

  ENCRYPTION_KEY:        z.string().length(64, 'ENCRYPTION_KEY doit être 64 caractères hex (32 bytes)').optional(),
  JWT_SECRET:            z.string().min(32),
  JWT_EXPIRES_IN:        z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  MFA_ISSUER:            z.string().default('NexusRH CI'),

  GOOGLE_CLIENT_ID:     z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL:  z.string().default('http://localhost:4001/auth/google/callback'),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL:          z.string().default('claude-sonnet-4-20250514'),
  AI_MAX_TOKENS:     z.coerce.number().default(4096),
  AI_TEMPERATURE:    z.coerce.number().default(0.3),

  // Mistral (option alternative pour scoring CV — au choix dans l'UI)
  MISTRAL_API_KEY:   z.string().optional(),
  MISTRAL_MODEL:     z.string().default('mistral-large-latest'),
  MISTRAL_API_URL:   z.string().default('https://api.mistral.ai/v1'),

  SMTP_HOST:   z.string().default('smtp.gmail.com'),
  SMTP_PORT:   z.coerce.number().default(587),
  SMTP_SECURE: z.string().transform(v => v === 'true').default('false'),
  SMTP_USER:   z.string().default(''),
  SMTP_PASS:   z.string().default(''),
  SMTP_FROM:   z.string().default('NexusRH CI <noreply@nexusrh-ci.com>'),

  S3_ENDPOINT:         z.string().default('http://localhost:9002'),
  S3_ACCESS_KEY:       z.string().default('minioadmin'),
  S3_SECRET_KEY:       z.string().default('minioadmin'),
  S3_BUCKET:           z.string().default('nexusrhci'),
  S3_REGION:           z.string().default('af-west-1'),
  S3_FORCE_PATH_STYLE: z.string().transform(v => v === 'true').default('true'),

  MEILISEARCH_URL:        z.string().default('http://localhost:7701'),
  MEILISEARCH_MASTER_KEY: z.string().default('nexusrhci-dev-master-key'),

  WAVE_API_KEY:        z.string().optional(),
  WAVE_API_URL:        z.string().default('https://api.wave.com/v1'),
  WAVE_WEBHOOK_SECRET: z.string().optional(),

  MTN_MOMO_API_KEY:          z.string().optional(),
  MTN_MOMO_API_URL:          z.string().default('https://sandbox.momodeveloper.mtn.com'),
  MTN_MOMO_SUBSCRIPTION_KEY: z.string().optional(),
  MTN_MOMO_ENV:              z.string().default('sandbox'),

  ORANGE_MONEY_API_KEY:     z.string().optional(),
  ORANGE_MONEY_API_URL:     z.string().default('https://api.orange.com/orange-money-webpay/ci/v1'),
  ORANGE_MONEY_MERCHANT_KEY: z.string().optional(),

  FEATURE_AI_ASSISTANT:     z.string().transform(v => v === 'true').default('true'),
  FEATURE_MOBILE_MONEY:     z.string().transform(v => v === 'true').default('true'),
  FEATURE_CNPS_AUTO_EXPORT: z.string().transform(v => v === 'true').default('true'),
  FEATURE_DISA_GENERATOR:   z.string().transform(v => v === 'true').default('true'),
  FEATURE_FDFP_MODULE:      z.string().transform(v => v === 'true').default('true'),
  FEATURE_OHADA_CONTRACTS:  z.string().transform(v => v === 'true').default('true'),
  FEATURE_OFFLINE_PWA:      z.string().transform(v => v === 'true').default('true'),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Variables d\'environnement invalides:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

const env = parsed.data

export const config = {
  env:      env.NODE_ENV,
  appName:  env.APP_NAME,
  appUrl:   env.APP_URL,
  apiUrl:   env.API_URL,
  port:     env.API_PORT,
  logLevel: env.LOG_LEVEL,
  locale:   env.LOCALE,
  currency: env.CURRENCY,
  timezone: env.TIMEZONE,

  database: {
    url:     env.DATABASE_URL,
    poolMin: env.DATABASE_POOL_MIN,
    poolMax: env.DATABASE_POOL_MAX,
  },

  redis: { url: env.REDIS_URL },

  jwt: {
    secret:         env.JWT_SECRET,
    expiresIn:      env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
    mfaIssuer:      env.MFA_ISSUER,
  },

  google: {
    clientId:     env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackUrl:  env.GOOGLE_CALLBACK_URL,
  },

  ai: {
    apiKey:      env.ANTHROPIC_API_KEY,
    model:       env.AI_MODEL,
    maxTokens:   env.AI_MAX_TOKENS,
    temperature: env.AI_TEMPERATURE,
  },

  mistral: {
    apiKey: env.MISTRAL_API_KEY,
    model:  env.MISTRAL_MODEL,
    apiUrl: env.MISTRAL_API_URL,
  },

  smtp: {
    host:   env.SMTP_HOST,
    port:   env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user:   env.SMTP_USER,
    pass:   env.SMTP_PASS,
    from:   env.SMTP_FROM,
  },

  s3: {
    endpoint:       env.S3_ENDPOINT,
    accessKey:      env.S3_ACCESS_KEY,
    secretKey:      env.S3_SECRET_KEY,
    bucket:         env.S3_BUCKET,
    region:         env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  },

  meilisearch: {
    url:       env.MEILISEARCH_URL,
    masterKey: env.MEILISEARCH_MASTER_KEY,
  },

  mobileMoney: {
    wave: {
      apiKey:        env.WAVE_API_KEY,
      apiUrl:        env.WAVE_API_URL,
      webhookSecret: env.WAVE_WEBHOOK_SECRET,
    },
    mtn: {
      apiKey:          env.MTN_MOMO_API_KEY,
      apiUrl:          env.MTN_MOMO_API_URL,
      subscriptionKey: env.MTN_MOMO_SUBSCRIPTION_KEY,
      env:             env.MTN_MOMO_ENV,
    },
    orange: {
      apiKey:       env.ORANGE_MONEY_API_KEY,
      apiUrl:       env.ORANGE_MONEY_API_URL,
      merchantKey:  env.ORANGE_MONEY_MERCHANT_KEY,
    },
  },

  features: {
    aiAssistant:    env.FEATURE_AI_ASSISTANT,
    mobileMoney:    env.FEATURE_MOBILE_MONEY,
    cnpsAutoExport: env.FEATURE_CNPS_AUTO_EXPORT,
    disaGenerator:  env.FEATURE_DISA_GENERATOR,
    fdfpModule:     env.FEATURE_FDFP_MODULE,
    ohadaContracts: env.FEATURE_OHADA_CONTRACTS,
    offlinePwa:     env.FEATURE_OFFLINE_PWA,
  },
} as const
