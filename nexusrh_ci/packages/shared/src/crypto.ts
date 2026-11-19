import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO = 'aes-256-gcm'
/** Longueur du tag d'authentification GCM, imposée en chiffrement ET en déchiffrement. */
const TAG_BYTES = 16
const KEY_HEX = process.env.ENCRYPTION_KEY ?? ''

/**
 * Erreur typée levée quand ENCRYPTION_KEY est absente/malformée. Porte un `code`
 * et un `statusCode` reconnus par le error handler global et par describeDbError
 * → le client reçoit un message clair (503) au lieu d'une « Erreur interne du
 * serveur » opaque. C'est la cause classique d'un 500 à la création d'un employé
 * portant un NNI/IBAN quand la clé n'est pas provisionnée.
 */
export class EncryptionUnavailableError extends Error {
  readonly code = 'ENCRYPTION_UNAVAILABLE'
  readonly statusCode = 503
  constructor() {
    super("Le chiffrement des données sensibles (NNI, IBAN) n'est pas configuré sur le serveur. Contactez votre administrateur.")
    this.name = 'EncryptionUnavailableError'
  }
}

/** Le chiffrement est-il opérationnel (clé 64 hex présente) ? */
export function isEncryptionConfigured(): boolean {
  return KEY_HEX.length === 64
}

function getKey(): Buffer {
  if (KEY_HEX.length !== 64) throw new EncryptionUnavailableError()
  return Buffer.from(KEY_HEX, 'hex')
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, getKey(), iv, { authTagLength: TAG_BYTES })
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, encHex] = stored.split(':')
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid encrypted format')
  // Node accepte par défaut des tags GCM de 4, 8, 12, 13, 14, 15 ou 16 octets.
  // Sans ces deux garde-fous, quelqu'un capable d'écrire dans la colonne
  // chiffrée y dépose un cryptogramme à tag tronqué à 4 octets : la résistance
  // à la falsification tombe de 2^128 à 2^32, soit une force brute réalisable.
  // `encrypt` n'émet QUE des tags de 16 octets — rien de légitime n'est refusé.
  if (tagHex.length !== TAG_BYTES * 2) throw new Error('Invalid encrypted format')
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'), { authTagLength: TAG_BYTES })
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8')
}

export function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null
  return encrypt(value)
}

export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null
  try { return decrypt(value) } catch { return null }
}
