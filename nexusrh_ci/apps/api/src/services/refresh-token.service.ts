/**
 * Refresh tokens rotatifs (OWASP A07/A02).
 *
 * Permet de renouveler SILENCIEUSEMENT le JWT (durée courte) après son
 * expiration, sans re-login — l'utilisateur n'est pas déconnecté (AUTH-008).
 *
 * Sécurité :
 *  - Le token opaque (32 octets aléatoires) n'est JAMAIS stocké en clair : seul
 *    son SHA-256 est en base (`platform.refresh_tokens`). Centralisé au schéma
 *    platform → le endpoint de refresh n'a pas besoin de connaître le tenant.
 *  - ROTATION : chaque consommation révoque le token et en émet un nouveau →
 *    un refresh token rejoué (volé) est détectable et inutilisable deux fois.
 *  - Révocation à la déconnexion + TTL borné (30 j).
 *  - Les claims (rôle, email…) sont resnapshotés à l'émission ; l'appelant
 *    re-vérifie que le compte est toujours actif avant de re-signer un JWT.
 */
import { createHash, randomBytes } from 'crypto'
import type { Pool } from 'pg'

const REFRESH_TTL_DAYS = 30

export interface RefreshClaims {
  sub:        string
  tenantId:   string | null
  schemaName: string
  role:       string
  email:      string
  firstName:  string
  lastName:   string
  employeeId: string | null
  actorType?: 'agency'
  agencyId?:  string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Émet un nouveau refresh token (chaîne opaque retournée au client) et persiste
 * son hash + les claims. Non bloquant en cas d'échec DB : retourne null (le
 * login reste fonctionnel, simplement sans refresh silencieux).
 */
export async function issueRefreshToken(pool: Pool, claims: RefreshClaims): Promise<string | null> {
  try {
    const token = randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO platform.refresh_tokens (token_hash, user_id, schema_name, claims, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' days')::interval)`,
      [sha256(token), claims.sub, claims.schemaName, JSON.stringify(claims), String(REFRESH_TTL_DAYS)],
    )
    return token
  } catch {
    return null
  }
}

/**
 * Consomme un refresh token : le révoque (rotation) et retourne ses claims s'il
 * est valide (présent, non révoqué, non expiré). Sinon null.
 */
export async function consumeRefreshToken(pool: Pool, token: string | null | undefined): Promise<RefreshClaims | null> {
  if (!token || typeof token !== 'string') return null
  try {
    const res = await pool.query<{ claims: RefreshClaims }>(
      `UPDATE platform.refresh_tokens
          SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING claims`,
      [sha256(token)],
    )
    return res.rows[0]?.claims ?? null
  } catch {
    return null
  }
}

/** Révoque un refresh token (déconnexion). Non bloquant. */
export async function revokeRefreshToken(pool: Pool, token: string | null | undefined): Promise<void> {
  if (!token || typeof token !== 'string') return
  await pool.query(
    `UPDATE platform.refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(token)],
  ).catch(() => { /* non bloquant */ })
}

/**
 * Re-vérifie que le compte derrière les claims existe TOUJOURS et est actif
 * (un compte désactivé ne peut pas rafraîchir). Renvoie le rôle courant (qui
 * peut avoir changé depuis l'émission) ou null si inactif/inexistant.
 */
export async function verifyAccountActive(
  pool: Pool, schemaName: string, userId: string,
): Promise<{ role: string; passwordChangedAt: Date | string | null } | null> {
  try {
    if (schemaName === 'platform') {
      const r = await pool.query<{ role: string; is_active: boolean; password_changed_at: Date | string | null }>(
        `SELECT role, is_active, password_changed_at FROM platform.platform_users WHERE id = $1 LIMIT 1`, [userId],
      )
      const u = r.rows[0]
      return u && u.is_active ? { role: u.role, passwordChangedAt: u.password_changed_at } : null
    }
    // Tenant : nom de schéma déjà validé en amont (JWT/claims), mais defense in depth.
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) return null
    const r = await pool.query<{ role: string; is_active: boolean; password_changed_at: Date | string | null }>(
      `SELECT role, is_active, password_changed_at FROM "${schemaName}".users WHERE id = $1 LIMIT 1`, [userId],
    )
    const u = r.rows[0]
    return u && u.is_active ? { role: u.role, passwordChangedAt: u.password_changed_at } : null
  } catch {
    return null
  }
}
