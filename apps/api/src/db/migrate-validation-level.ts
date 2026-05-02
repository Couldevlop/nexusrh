/**
 * Migration: Add `validation_level` column and `workflow_configs` table
 * to all existing tenant schemas.
 * Safe to run multiple times (idempotent — uses IF NOT EXISTS / ON CONFLICT).
 *
 * Run: pnpm --filter api run db:migrate-validation
 */

import { Pool } from 'pg'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

dotenvConfig({ path: resolve(process.cwd(), '../../.env') })

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://nexusrh:nexusrh@localhost:5432/nexusrh'

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL })

  try {
    console.log('🔍 Récupération des tenants...')

    const tenantsRes = await pool.query<{ schema_name: string; slug: string }>(
      `SELECT schema_name, slug FROM platform.tenants WHERE schema_name IS NOT NULL ORDER BY slug`
    )

    const tenants = tenantsRes.rows
    console.log(`📦 ${tenants.length} tenant(s) trouvé(s): ${tenants.map((t) => t.slug).join(', ')}`)

    for (const tenant of tenants) {
      const s = tenant.schema_name
      console.log(`\n⚙️  Migration: ${s}`)

      // 1. Add validation_level to absences
      await pool.query(
        `ALTER TABLE "${s}".absences ADD COLUMN IF NOT EXISTS validation_level INT NOT NULL DEFAULT 0`
      )
      console.log(`  ✓ absences.validation_level`)

      // 2. Add validation_level to expense_reports
      await pool.query(
        `ALTER TABLE "${s}".expense_reports ADD COLUMN IF NOT EXISTS validation_level INT NOT NULL DEFAULT 0`
      )
      console.log(`  ✓ expense_reports.validation_level`)

      // 3. Create workflow_configs table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${s}".workflow_configs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          module VARCHAR(50) NOT NULL UNIQUE,
          levels_count INT NOT NULL DEFAULT 1,
          level1_role VARCHAR(50) NOT NULL DEFAULT 'manager',
          level2_role VARCHAR(50),
          level3_role VARCHAR(50),
          level4_role VARCHAR(50),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      console.log(`  ✓ workflow_configs table`)

      // 4. Seed default workflow configs
      await pool.query(`
        INSERT INTO "${s}".workflow_configs (module, levels_count, level1_role)
        VALUES ('absences', 1, 'manager'), ('expenses', 1, 'manager')
        ON CONFLICT (module) DO NOTHING
      `)
      console.log(`  ✓ workflow_configs seeded`)
    }

    console.log('\n✅ Migration terminée avec succès.')
  } catch (err) {
    console.error('❌ Erreur de migration:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
