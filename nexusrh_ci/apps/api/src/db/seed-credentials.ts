/**
 * Préservation des identifiants entre deux seeds.
 *
 * Le pipeline re-seed à chaque déploiement (DROP SCHEMA ... CASCADE). Sans
 * sauvegarde, tous les mots de passe sont réinitialisés à la valeur de démo
 * (présente dans les fuites HIBP → re-demande de changement à chaque login).
 * On capture donc les credentials des utilisateurs existants avant le DROP,
 * puis on les restaure après recréation des schémas.
 *
 * Extrait de seed.ts pour être testable (seed.ts exécute main() à l'import).
 */
import type { Pool } from 'pg'

export interface PreservedCredential {
  password_hash: string
  password_changed_at: string | null
  last_login_at: string | null
}

export async function captureExistingCredentials(
  pool: Pool,
  schemas: string[],
): Promise<Map<string, PreservedCredential>> {
  const preserved = new Map<string, PreservedCredential>()
  for (const schema of schemas) {
    let rows: Array<{ email: string } & PreservedCredential> = []
    try {
      const r = await pool.query<{ email: string } & PreservedCredential>(
        `SELECT email, password_hash, password_changed_at, last_login_at FROM "${schema}".users`
      )
      rows = r.rows
    } catch {
      // Schéma absent (premier seed) ou colonne password_changed_at pas encore
      // migrée → repli sans elle. Si même ça échoue, rien à préserver.
      try {
        const r = await pool.query<{ email: string; password_hash: string; last_login_at: string | null }>(
          `SELECT email, password_hash, last_login_at FROM "${schema}".users`
        )
        rows = r.rows.map((u) => ({ ...u, password_changed_at: null }))
      } catch { /* premier seed : schéma inexistant */ }
    }
    for (const u of rows) preserved.set(`${schema}|${u.email}`, u)
    if (rows.length) console.log(`[0] ${rows.length} credentials préservés pour ${schema}`)
  }
  return preserved
}

export async function restorePreservedCredentials(
  pool: Pool,
  preserved: Map<string, PreservedCredential>,
): Promise<number> {
  let restored = 0
  for (const [key, cred] of preserved) {
    const sep = key.indexOf('|')
    const schema = key.slice(0, sep)
    const email = key.slice(sep + 1)
    try {
      const r = await pool.query(
        `UPDATE "${schema}".users
         SET password_hash = $1,
             password_changed_at = COALESCE($2::timestamptz, password_changed_at),
             last_login_at = COALESCE($3::timestamptz, last_login_at)
         WHERE email = $4`,
        [cred.password_hash, cred.password_changed_at, cred.last_login_at, email]
      )
      restored += r.rowCount ?? 0
    } catch (e) {
      console.warn(`[!] Restauration credentials impossible pour ${email}@${schema}:`, (e as Error).message)
    }
  }
  if (restored) console.log(`[0] ${restored} mots de passe existants restaurés (survie au re-seed)`)
  return restored
}
