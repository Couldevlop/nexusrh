/**
 * Migration idempotente de TOUS les schémas tenants existants.
 *
 * Pourquoi : `index.ts` n'exécute au boot que `createPlatformSchema()` (colonnes
 * du schéma `platform`). Les migrations de schéma *tenant* (colonnes multi-pays,
 * bascule de la clé d'unicité pay_periods → (month, legal_entity_id), index…)
 * vivent dans `provisionTenantSchema()` qui n'est appelé qu'à la création d'un
 * tenant. Sur la version en ligne, les tenants déjà provisionnés ne reçoivent
 * donc PAS automatiquement ces évolutions.
 *
 * Ce runner lit la liste réelle des tenants dans `platform.tenants` (jamais en
 * dur) et applique `provisionTenantSchema()` à chacun. Tout est idempotent
 * (CREATE/ALTER … IF NOT EXISTS, DROP CONSTRAINT IF EXISTS). À relancer sans
 * risque, autant de fois que nécessaire.
 *
 * Exécution :
 *   - Local : pnpm --filter @nexusrhci/api run db:migrate-tenants
 *   - K8s   : kubectl apply -f k8s/jobs/migrate-tenants-job.yaml
 *             (ou : kubectl exec -n nexusrh deploy/nexusrh-api -- node dist/db/migrate-tenants.js)
 *
 * Conformité OWASP :
 *   - A09 (Logging & Monitoring Failures) : chaque tenant est tracé (succès /
 *     échec + raison). Aucune erreur n'est avalée silencieusement — contrairement
 *     à la migration lazy de fallback. Un échec ⇒ exit code ≠ 0 ⇒ le Job K8s
 *     échoue visiblement.
 *   - A04 (Insecure Design) : la migration est purement structurelle (aucune
 *     donnée RH touchée) et observable, plutôt que dépendante du trafic.
 */
import { Pool } from 'pg'
import { config } from '../config.js'
import { provisionTenantSchema } from './provisioning.js'

const pool = new Pool({ connectionString: config.database.url })

function maskedDbUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '<URL invalide>'
  }
}

interface TenantRow {
  slug: string | null
  name: string | null
  schema_name: string | null
}

async function main(): Promise<void> {
  console.log('=== Migration des schémas tenants (idempotente) ===')
  console.log(`DB URL : ${maskedDbUrl(config.database.url)}\n`)

  const dryRun = process.argv.includes('--dry-run')

  // Fail-fast : si la DB n'est pas joignable, inutile de continuer.
  try {
    await pool.query('SELECT 1')
    console.log('✓ Connexion DB OK')
  } catch (err) {
    console.error('✗ Connexion DB impossible :', (err as Error).message)
    console.error('   Vérifier DATABASE_URL (ConfigMap nexusrh-config + secret postgres).')
    await pool.end().catch(() => {})
    process.exit(1)
  }

  let tenants: TenantRow[]
  try {
    const res = await pool.query<TenantRow>(
      `SELECT slug, name, schema_name
         FROM platform.tenants
        WHERE schema_name IS NOT NULL
        ORDER BY created_at NULLS LAST`,
    )
    tenants = res.rows
  } catch (err) {
    console.error('✗ Lecture de platform.tenants impossible :', (err as Error).message)
    await pool.end().catch(() => {})
    process.exit(1)
  }

  console.log(`Tenants à migrer : ${tenants.length}\n`)
  if (dryRun) {
    for (const t of tenants) {
      console.log(`  DRY-RUN ${(t.schema_name ?? '').padEnd(32)} (${t.name ?? t.slug ?? '?'})`)
    }
    console.log('\nMode DRY-RUN — aucun changement appliqué.')
    await pool.end().catch(() => {})
    process.exit(0)
  }

  let okCount = 0
  let koCount = 0
  const failures: Array<{ schema: string; reason: string }> = []

  for (const t of tenants) {
    const schema = t.schema_name as string
    const prefix = `${schema.padEnd(32)} (${t.name ?? t.slug ?? '?'})`
    try {
      await provisionTenantSchema(schema)
      console.log(`✓ ${prefix}`)
      okCount++
    } catch (err) {
      const reason = (err as Error).message
      console.error(`✗ ${prefix} — ${reason}`)
      failures.push({ schema, reason })
      koCount++
    }
  }

  console.log(`\n${okCount} migré(s) · ${koCount} échec(s)`)
  if (failures.length > 0) {
    console.error('\nÉchecs (à investiguer — souvent données en doublon (month) avant bascule de clé) :')
    for (const f of failures) console.error(`  - ${f.schema} : ${f.reason}`)
  }

  await pool.end().catch(() => {})
  // Exit ≠ 0 si au moins un tenant a échoué ⇒ le Job K8s est marqué Failed.
  process.exit(koCount > 0 ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error('Échec inattendu de la migration tenants :', err)
  process.exit(1)
})
