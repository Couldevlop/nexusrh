import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

dotenvConfig({ path: resolve(process.cwd(), '../../.env') })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://nexusrh:nexusrh@localhost:5432/nexusrh'

async function runMigrations() {
  const pool = new Pool({ connectionString: DATABASE_URL })
  const db = drizzle(pool)

  console.log('Exécution des migrations...')

  await migrate(db, {
    migrationsFolder: path.join(__dirname, 'migrations'),
  })

  console.log('Migrations terminées ✓')
  await pool.end()
}

runMigrations().catch((err) => {
  console.error('Erreur lors des migrations:', err)
  process.exit(1)
})
