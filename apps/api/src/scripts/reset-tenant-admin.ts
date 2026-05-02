/**
 * Script de secours : réinitialise le mot de passe d'un admin tenant.
 * Usage : tsx src/scripts/reset-tenant-admin.ts <email> <nouveau_mot_de_passe>
 * Exemple : tsx src/scripts/reset-tenant-admin.ts coulwao@gmail.com Openlab2025!
 */
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../../../.env') })

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })

async function main() {
  const [, , email, newPassword] = process.argv

  if (!email || !newPassword) {
    console.error('Usage: tsx src/scripts/reset-tenant-admin.ts <email> <nouveau_mot_de_passe>')
    process.exit(1)
  }

  // Find the tenant containing this user
  const tenantsRes = await pool.query<{ schema_name: string; name: string }>(
    `SELECT schema_name, name FROM platform.tenants WHERE status != 'suspended'`,
  )

  let found = false
  for (const tenant of tenantsRes.rows) {
    const userRes = await pool.query<{ id: string; email: string; role: string }>(
      `SELECT id, email, role FROM "${tenant.schema_name}".users WHERE email = $1 LIMIT 1`,
      [email],
    ).catch(() => ({ rows: [] as { id: string; email: string; role: string }[] }))

    const user = userRes.rows[0]
    if (!user) continue

    const hash = await bcrypt.hash(newPassword, 12)
    await pool.query(
      `UPDATE "${tenant.schema_name}".users SET password_hash = $1, is_active = true, updated_at = NOW() WHERE id = $2`,
      [hash, user.id],
    )

    console.log(`✓ Mot de passe réinitialisé`)
    console.log(`  Tenant : ${tenant.name} (${tenant.schema_name})`)
    console.log(`  Email  : ${user.email}`)
    console.log(`  Rôle   : ${user.role}`)
    console.log(`  Mdp    : ${newPassword}`)
    found = true
    break
  }

  if (!found) {
    console.error(`✗ Utilisateur "${email}" introuvable dans les tenants actifs`)
    process.exit(1)
  }

  await pool.end()
}

main().catch(err => {
  console.error('Erreur:', err.message)
  process.exit(1)
})
