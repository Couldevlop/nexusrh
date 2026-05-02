import type { Config } from 'drizzle-kit'
import { config as dotenvConfig } from 'dotenv'

dotenvConfig({ path: '../../.env' })

export default {
  schema: './src/db/schema',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://nexusrh:nexusrh@localhost:5432/nexusrh',
  },
  verbose: true,
  strict: true,
} satisfies Config
