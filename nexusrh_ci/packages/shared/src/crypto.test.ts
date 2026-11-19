/**
 * Chiffrement AES-256-GCM des colonnes sensibles (NNI, IBAN, secrets TOTP,
 * clés IA par tenant, en-têtes de webhooks).
 *
 * Le point sensible est la LONGUEUR DU TAG d'authentification. Node accepte par
 * défaut des tags GCM de 4, 8, 12, 13, 14, 15 ou 16 octets. Si `decrypt` ne
 * l'impose pas, quelqu'un capable d'écrire dans la colonne chiffrée peut y
 * déposer un cryptogramme accompagné d'un tag tronqué à 4 octets : la résistance
 * à la falsification tombe de 2^128 à 2^32, soit une force brute réalisable.
 *
 * C'est une défense en profondeur (il faut déjà un accès en écriture à la base),
 * mais c'est le genre de marge qu'on ne laisse pas ouverte.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createCipheriv, randomBytes } from 'crypto'

const KEY = '0'.repeat(64) // 32 octets en hexadécimal

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY
})

// Le module lit ENCRYPTION_KEY au chargement : import dynamique APRÈS beforeAll.
async function loadCrypto() {
  return import('./crypto.js')
}

describe('crypto AES-256-GCM', () => {
  it('chiffre et déchiffre un aller-retour', async () => {
    const { encrypt, decrypt } = await loadCrypto()
    expect(decrypt(encrypt('CI-1234567890'))).toBe('CI-1234567890')
  })

  it('produit un cryptogramme différent à chaque appel (IV aléatoire)', async () => {
    const { encrypt } = await loadCrypto()
    expect(encrypt('même valeur')).not.toBe(encrypt('même valeur'))
  })

  it('émet toujours un tag de 16 octets', async () => {
    const { encrypt } = await loadCrypto()
    const [, tagHex] = encrypt('x').split(':')
    expect(tagHex).toHaveLength(32) // 16 octets = 32 caractères hex
  })

  it('REFUSE un tag d’authentification tronqué à 4 octets', async () => {
    const { decrypt } = await loadCrypto()

    // Forge un cryptogramme authentique mais à tag court — exactement ce qu'un
    // attaquant ayant accès en écriture à la base déposerait.
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv, { authTagLength: 4 })
    const enc = Buffer.concat([cipher.update('donnée sensible', 'utf8'), cipher.final()])
    const shortTag = cipher.getAuthTag()
    expect(shortTag).toHaveLength(4) // le tag court est bien de 4 octets

    const forged = `${iv.toString('hex')}:${shortTag.toString('hex')}:${enc.toString('hex')}`
    expect(() => decrypt(forged)).toThrow()
  })

  it('refuse un cryptogramme altéré', async () => {
    const { encrypt, decrypt } = await loadCrypto()
    const [ivHex, tagHex, encHex] = encrypt('donnée sensible').split(':')
    const flipped = (parseInt(encHex.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0')
    expect(() => decrypt(`${ivHex}:${tagHex}:${flipped}${encHex.slice(2)}`)).toThrow()
  })

  it('refuse un tag altéré de longueur correcte', async () => {
    const { encrypt, decrypt } = await loadCrypto()
    const [ivHex, tagHex, encHex] = encrypt('donnée sensible').split(':')
    const flipped = (parseInt(tagHex.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0')
    expect(() => decrypt(`${ivHex}:${flipped}${tagHex.slice(2)}:${encHex}`)).toThrow()
  })

  it('refuse un format non conforme', async () => {
    const { decrypt } = await loadCrypto()
    expect(() => decrypt('pas-un-cryptogramme')).toThrow('Invalid encrypted format')
  })

  it('decryptIfPresent renvoie null plutôt que de propager', async () => {
    const { decryptIfPresent } = await loadCrypto()
    expect(decryptIfPresent('pas-un-cryptogramme')).toBeNull()
    expect(decryptIfPresent(null)).toBeNull()
  })
})
