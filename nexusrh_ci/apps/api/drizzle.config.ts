import type { Config } from 'drizzle-kit'
import { config } from './src/config.js'

export default {
  schema: './src/db/schema/*',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: { connectionString: config.database.url },
  verbose: true,
  strict: true,
} satisfies Config
