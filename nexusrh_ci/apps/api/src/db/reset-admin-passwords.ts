/**
 * Reset rapide des mots de passe admin sans relancer le seed complet.
 *
 * Cible : récupération d'accès en prod quand le seed a tourné avec ON CONFLICT
 * DO NOTHING (les hashes ne sont pas rafraîchis). Idempotent — peut être
 * exécuté plusieurs fois sans risque.
 *
 * Exécution :
 *   - Local  : pnpm --filter @nexusrhci/api run admin:reset-passwords
 *   - K8s    : kubectl exec -n nexusrh deploy/nexusrh-api -- node dist/db/reset-admin-passwords.js
 *   - Job    : voir nexusrh_ci/k8s/jobs/reset-admin-passwords-job.yaml
 *
 * Conformité OWASP A02 (Cryptographic Failures) : bcrypt 12 rounds, lecture
 * des passwords depuis variable d'environnement RESET_PWD_OVERRIDE possible
 * (sinon valeurs par défaut documentées).
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'

const pool = new Pool({ connectionString: config.database.url })

interface Target {
  scope:   'platform' | 'tenant'
  schema:  string
  table:   string
  email:   string
  password: string
  label:   string
}

const TARGETS: Target[] = [
  // Super admin (schema platform)
  { scope: 'platform', schema: 'platform', table: 'platform_users',
    email: 'superadmin@nexusrh-ci.com', password: 'SuperAdmin1234!',
    label: 'Super Admin' },

  // SOTRA
  { scope: 'tenant', schema: 'tenant_sotra', table: 'users',
    email: 'admin@sotra.ci', password: 'Admin1234!', label: 'SOTRA admin' },
  { scope: 'tenant', schema: 'tenant_sotra', table: 'users',
    email: 'rh@sotra.ci', password: 'Admin1234!', label: 'SOTRA hr_manager' },
  { scope: 'tenant', schema: 'tenant_sotra', table: 'users',
    email: 'manager@sotra.ci', password: 'Admin1234!', label: 'SOTRA manager' },
  { scope: 'tenant', schema: 'tenant_sotra', table: 'users',
    email: 'employe@sotra.ci', password: 'Admin1234!', label: 'SOTRA employee' },

  // Cabinet Expertise CI
  { scope: 'tenant', schema: 'tenant_cabinet_expertise_ci', table: 'users',
    email: 'admin@cabinet-expertise.ci', password: 'Admin1234!',
    label: 'Cabinet admin' },
  { scope: 'tenant', schema: 'tenant_cabinet_expertise_ci', table: 'users',
    email: 'employe2@cabinet-expertise.ci', password: 'Admin1234!',
    label: 'Cabinet employee' },

  // OpenLab Consulting
  { scope: 'tenant', schema: 'tenant_openlab_consulting', table: 'users',
    email: 'coulwao@gmail.com', password: 'Openlab1234!',
    label: 'OpenLab admin' },
]

async function resetOne(target: Target): Promise<{ ok: boolean; reason: string }> {
  // Override possible via env (utile pour rotation : RESET_PWD_<email_slug>=...)
  const envKey = `RESET_PWD_${target.email.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`
  const password = process.env[envKey] ?? target.password
  const hash = await bcrypt.hash(password, 12)

  try {
    const res = await pool.query(
      `UPDATE "${target.schema}".${target.table}
          SET password_hash = $1,
              is_active = true,
              updated_at = now()
        WHERE email = $2
        RETURNING id`,
      [hash, target.email],
    )
    if (res.rowCount === 0) {
      // L'utilisateur n'existe pas — on l'insère seulement pour le super_admin
      // (les autres comptes sont créés via le seed complet).
      if (target.scope === 'platform') {
        await pool.query(
          `INSERT INTO "${target.schema}".${target.table}
             (email, password_hash, first_name, last_name, role, is_active)
           VALUES ($1, $2, 'Super', 'Admin', 'super_admin', true)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
          [target.email, hash],
        )
        return { ok: true, reason: 'inséré (n\'existait pas)' }
      }
      return { ok: false, reason: 'utilisateur introuvable — lancer le seed complet d\'abord' }
    }
    return { ok: true, reason: 'mis à jour' }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

async function main(): Promise<void> {
  console.log('=== Reset admin passwords (OWASP A02 — bcrypt 12 rounds) ===\n')

  const dryRun = process.argv.includes('--dry-run')
  if (dryRun) {
    console.log('Mode DRY-RUN — aucun changement DB.\n')
  }

  let okCount = 0
  let koCount = 0

  for (const target of TARGETS) {
    const prefix = `[${target.scope}/${target.schema}] ${target.email}`
    if (dryRun) {
      console.log(`${prefix} — DRY-RUN (password "${target.password}")`)
      continue
    }
    const r = await resetOne(target)
    if (r.ok) {
      console.log(`✓ ${prefix} — ${r.reason}`)
      okCount++
    } else {
      console.log(`✗ ${prefix} — ${r.reason}`)
      koCount++
    }
  }

  console.log(`\n${okCount} succès · ${koCount} échec(s)\n`)
  console.log('Comptes utilisables :')
  for (const t of TARGETS) {
    console.log(`  ${t.email.padEnd(35)} ${t.password.padEnd(20)} (${t.label})`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error('Erreur reset:', err)
  process.exit(1)
})
