import { createDecipheriv } from 'crypto'

const ALGO = 'aes-256-gcm'

/**
 * Déchiffrement AES-256-GCM des secrets tenant stockés en base (ex.
 * `attendance_devices.auth_secret_enc`). Copie fonctionnellement IDENTIQUE à
 * `apps/api/src/utils/crypto.ts` (même algorithme, même format sérialisé
 * `iv:tag:cipher` en hex, même variable d'environnement `ENCRYPTION_KEY`) :
 * un secret chiffré par l'API se déchiffre donc correctement ici, tant que
 * le pod worker reçoit la MÊME clé (cf. k8s — `nexusrh-app-secrets` /
 * `encryption-key`, câblée au worker au même titre qu'à l'API).
 *
 * Le worker (`@nexusrhci/worker`) n'a pas de dépendance vers `@nexusrhci/api`
 * (aucun job existant n'importe depuis l'API) : le module est donc dupliqué
 * ici plutôt qu'importé.
 *
 * Le secret déchiffré n'est JAMAIS loggé ni renvoyé dans un message
 * d'erreur — `decryptIfPresent` avale toute exception et renvoie `null`.
 */
function getKey(): Buffer {
  const keyHex = process.env['ENCRYPTION_KEY'] ?? ''
  if (keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY absente/malformée — déchiffrement indisponible')
  }
  return Buffer.from(keyHex, 'hex')
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, encHex] = stored.split(':')
  if (!ivHex || !tagHex || !encHex) throw new Error('Format chiffré invalide')
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8')
}

export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null
  try { return decrypt(value) } catch { return null }
}
