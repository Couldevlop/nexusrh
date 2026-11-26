import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO = 'aes-256-gcm'
/** Longueur du tag d'authentification GCM, imposée en chiffrement ET en déchiffrement. */
const TAG_BYTES = 16
const KEY_HEX = process.env.ENCRYPTION_KEY ?? ''
/**
 * Clé PRÉCÉDENTE, facultative : utilisée UNIQUEMENT en déchiffrement, jamais
 * en chiffrement.
 *
 * POURQUOI ELLE EXISTE. Avec une seule clé, la roter rend illisible tout
 * l'existant — et le pire est la façon dont cela se manifeste :
 * `decryptIfPresent` avale l'échec et rend `null`. Les NNI, IBAN, secrets
 * TOTP et mots de passe SMTP des tenants ne donneraient donc pas une erreur,
 * ils DISPARAÎTRAIENT en silence, comme s'ils n'avaient jamais été saisis.
 *
 * Avec cette seconde clé, la rotation se fait sans coupure ni perte :
 *   1. `ENCRYPTION_KEY` = nouvelle clé, `ENCRYPTION_KEY_PREVIOUS` = ancienne ;
 *      les écritures utilisent déjà la nouvelle, les lectures de l'existant
 *      retombent sur l'ancienne ;
 *   2. un passage de ré-chiffrement réécrit tous les cryptogrammes ;
 *   3. `ENCRYPTION_KEY_PREVIOUS` est retirée — l'ancienne clé ne déchiffre
 *      plus rien.
 *
 * Tant que l'étape 3 n'est pas faite, l'ancienne clé reste valable : ce n'est
 * donc PAS une rotation terminée, seulement une rotation en cours.
 */
const KEY_HEX_PRECEDENTE = process.env.ENCRYPTION_KEY_PREVIOUS ?? ''

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

/** Une clé précédente est-elle configurée (rotation en cours) ? */
export function hasPreviousKey(): boolean {
  return KEY_HEX_PRECEDENTE.length === 64
}

/** Déchiffre avec UNE clé donnée. Lève si le tag ne correspond pas. */
function dechiffrerAvec(ivHex: string, tagHex: string, encHex: string, cle: Buffer): string {
  const decipher = createDecipheriv(ALGO, cle, Buffer.from(ivHex, 'hex'), { authTagLength: TAG_BYTES })
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8')
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
  try {
    return dechiffrerAvec(ivHex, tagHex, encHex, getKey())
  } catch (err) {
    // Le format est valide mais la clé courante ne l'authentifie pas : c'est le
    // cas d'un cryptogramme écrit AVANT une rotation. On tente alors la clé
    // précédente, si elle est configurée. Sans elle, l'erreur remonte telle
    // quelle — on ne masque jamais un échec d'authentification.
    if (!hasPreviousKey()) throw err
    return dechiffrerAvec(ivHex, tagHex, encHex, Buffer.from(KEY_HEX_PRECEDENTE, 'hex'))
  }
}

export function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null
  return encrypt(value)
}

export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null
  try { return decrypt(value) } catch { return null }
}

/**
 * Forme exacte d'un cryptogramme produit par `encrypt` : iv (12 octets) puis
 * tag (16 octets, longueur IMPOSÉE par `decrypt`) puis le chiffré.
 */
const FORME_CRYPTOGRAMME = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/

/**
 * Lit une colonne sensible qui peut contenir SOIT un cryptogramme, SOIT du clair
 * d'avant la mise en place du chiffrement.
 *
 * POURQUOI ELLE EXISTE. Mesuré en production le 26/11/2026 : les 157 NNI sont
 * en clair (écrits par les seeds et les imports), tandis que les IBAN saisis
 * par l'interface sont chiffrés. Une même colonne porte donc les deux formes.
 *
 * Or les exports légaux — XML DISA, CSV CNPS, RNS, bulletin PDF, export SAGE,
 * attestations — lisaient ces colonnes BRUTES et les émettaient telles quelles.
 * Tant que la colonne est en clair cela passe inaperçu ; au premier NNI saisi
 * par l'interface, la déclaration CNPS part avec un cryptogramme à la place du
 * numéro d'identification. C'est déjà le cas des IBAN dans l'export SAGE.
 *
 * POURQUOI PAS `decryptIfPresent`. Celle-ci rend `null` dès que le
 * déchiffrement échoue : une valeur en clair deviendrait `null`, et un
 * cryptogramme illisible deviendrait `null` aussi — on ne saurait plus
 * distinguer « pas de donnée » de « donnée perdue ». Ici le format décide :
 *   - ne ressemble pas à un cryptogramme → c'est du clair, rendu tel quel ;
 *   - ressemble à un cryptogramme → déchiffré, et toute erreur LÈVE.
 */
export function decryptStoredValue(value: string | null | undefined): string | null {
  if (!value) return null
  if (!FORME_CRYPTOGRAMME.test(value)) return value
  return decrypt(value)
}

