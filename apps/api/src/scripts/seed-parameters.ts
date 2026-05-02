/**
 * Migration one-shot : peuple la table parameters pour les tenants existants
 * créés avant l'ajout de seedDefaultParameters dans createTenantTables.
 *
 * Usage : pnpm --filter api run db:seed-params
 *   ou  : tsx src/scripts/seed-parameters.ts
 */
import { Pool, PoolClient } from 'pg'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { seedDefaultParameters } from '../db/provisioning'

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../../../.env') })

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })

async function main() {
  const tenantsRes = await pool.query<{ schema_name: string; name: string; slug: string }>(
    `SELECT schema_name, name, slug FROM platform.tenants ORDER BY created_at`,
  )

  if (tenantsRes.rows.length === 0) {
    console.log('Aucun tenant trouvé.')
    await pool.end()
    return
  }

  console.log(`Traitement de ${tenantsRes.rows.length} tenant(s)...\n`)

  for (const tenant of tenantsRes.rows) {
    const client: PoolClient = await pool.connect()
    try {
      await client.query(`SET search_path TO "${tenant.schema_name}", public`)

      // ── Paramètres référentiels ──
      await seedDefaultParameters(client, tenant.schema_name)
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM "${tenant.schema_name}".parameters`,
      )

      // ── Départements par défaut (si aucun n'existe) ──
      const deptCount = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM "${tenant.schema_name}".departments`,
      )
      if (Number(deptCount.rows[0]?.count ?? 0) === 0) {
        // Get first entity_id
        const entityRes = await client.query<{ id: string }>(
          `SELECT id FROM "${tenant.schema_name}".legal_entities LIMIT 1`,
        )
        const entityId = entityRes.rows[0]?.id
        if (entityId) {
          const defaultDepts = [
            { code: 'DIR', name: 'Direction Générale' },
            { code: 'RH',  name: 'Ressources Humaines' },
            { code: 'FIN', name: 'Finance & Comptabilité' },
            { code: 'IT',  name: 'Informatique / IT' },
            { code: 'COM', name: 'Commercial' },
            { code: 'MKT', name: 'Marketing & Communication' },
            { code: 'OPS', name: 'Opérations' },
            { code: 'JUR', name: 'Juridique & Conformité' },
          ]
          for (const dept of defaultDepts) {
            await client.query(
              `INSERT INTO "${tenant.schema_name}".departments (entity_id, code, name)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [entityId, dept.code, dept.name],
            )
          }
          console.log(`  + 8 départements ajoutés`)
        }
      } else {
        console.log(`  ↳ ${deptCount.rows[0]?.count} département(s) existants — skip`)
      }

      console.log(`✓ ${tenant.name} (${tenant.schema_name}) — ${countRes.rows[0]?.count ?? 0} paramètres`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`✗ ${tenant.name} (${tenant.schema_name}) — Erreur : ${message}`)
    } finally {
      client.release()
    }
  }

  console.log('\nTerminé.')
  await pool.end()
}

main().catch(err => {
  console.error('Erreur fatale:', err.message)
  process.exit(1)
})
