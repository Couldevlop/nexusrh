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
import { describe, it, expect, beforeAll, vi } from 'vitest'
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
    const parties = encrypt('donnée sensible').split(':')
    // `noUncheckedIndexedAccess` a raison : deconstruire un split() rend
    // `string | undefined`. Le test presupposait un format que rien ne
    // verifiait — et c'est justement le format que ce module doit garantir.
    // On l'affirme donc : si encrypt change de forme, ce test le DIT, au lieu
    // de planter plus bas sur un `undefined` au message obscur.
    expect(parties).toHaveLength(3)
    const [ivHex, tagHex, encHex] = parties as [string, string, string]
    const flipped = (parseInt(encHex.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0')
    expect(() => decrypt(`${ivHex}:${tagHex}:${flipped}${encHex.slice(2)}`)).toThrow()
  })

  it('refuse un tag altéré de longueur correcte', async () => {
    const { encrypt, decrypt } = await loadCrypto()
    const parties = encrypt('donnée sensible').split(':')
    // `noUncheckedIndexedAccess` a raison : deconstruire un split() rend
    // `string | undefined`. Le test presupposait un format que rien ne
    // verifiait — et c'est justement le format que ce module doit garantir.
    // On l'affirme donc : si encrypt change de forme, ce test le DIT, au lieu
    // de planter plus bas sur un `undefined` au message obscur.
    expect(parties).toHaveLength(3)
    const [ivHex, tagHex, encHex] = parties as [string, string, string]
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

describe('rotation de clé — ENCRYPTION_KEY_PREVIOUS', () => {
  const ANCIENNE = 'a'.repeat(64)
  const NOUVELLE = 'b'.repeat(64)

  /**
   * Chiffre comme le ferait `encrypt()` avec une clé donnée, sans passer par le
   * module : on fabrique ainsi un cryptogramme « écrit avant la rotation ».
   */
  function chiffrerAvec(clé: string, clair: string): string {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', Buffer.from(clé, 'hex'), iv, { authTagLength: 16 })
    const enc = Buffer.concat([c.update(clair, 'utf8'), c.final()])
    return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`
  }

  /** Recharge le module avec un environnement neuf (la clé est lue à l'import). */
  async function chargerAvec(courante: string, precedente?: string) {
    vi.resetModules()
    process.env.ENCRYPTION_KEY = courante
    if (precedente) process.env.ENCRYPTION_KEY_PREVIOUS = precedente
    else delete process.env.ENCRYPTION_KEY_PREVIOUS
    return import('./crypto.js')
  }

  it('un cryptogramme de l’ANCIENNE clé reste lisible pendant la rotation', async () => {
    const avant = chiffrerAvec(ANCIENNE, 'CI-1234567890')
    const { decrypt, hasPreviousKey } = await chargerAvec(NOUVELLE, ANCIENNE)
    expect(hasPreviousKey()).toBe(true)
    expect(decrypt(avant)).toBe('CI-1234567890')
  })

  it('les ÉCRITURES utilisent la nouvelle clé, pas la précédente', async () => {
    const { encrypt } = await chargerAvec(NOUVELLE, ANCIENNE)
    const apres = encrypt('IBAN-CI-99')
    // Relu avec la nouvelle clé SEULE : donc il a bien été écrit avec elle.
    const { decrypt } = await chargerAvec(NOUVELLE)
    expect(decrypt(apres)).toBe('IBAN-CI-99')
  })

  it('sans clé précédente, un cryptogramme de l’ancienne clé LÈVE — il ne devient pas null', async () => {
    // C'est le point qui rend la rotation dangereuse sans ce support :
    // `decryptIfPresent` avale l'échec, donc une rotation sans ré-chiffrement
    // ferait DISPARAÎTRE les NNI et IBAN au lieu de signaler une erreur.
    const avant = chiffrerAvec(ANCIENNE, 'CI-1234567890')
    const { decrypt, decryptIfPresent, hasPreviousKey } = await chargerAvec(NOUVELLE)
    expect(hasPreviousKey()).toBe(false)
    expect(() => decrypt(avant)).toThrow()
    expect(decryptIfPresent(avant)).toBeNull()
  })

  it('une clé précédente malformée n’est pas prise pour une clé valable', async () => {
    const avant = chiffrerAvec(ANCIENNE, 'secret')
    const { hasPreviousKey, decrypt } = await chargerAvec(NOUVELLE, 'trop-courte')
    expect(hasPreviousKey()).toBe(false)
    expect(() => decrypt(avant)).toThrow()
  })
})


describe('decryptStoredValue — colonne mixte clair / chiffré', () => {
  it('rend le clair tel quel (NNI d’avant le chiffrement)', async () => {
    const { decryptStoredValue } = await loadCrypto()
    expect(decryptStoredValue('CI-1985-0042')).toBe('CI-1985-0042')
  })

  it('déchiffre un cryptogramme', async () => {
    const { encrypt, decryptStoredValue } = await loadCrypto()
    expect(decryptStoredValue(encrypt('CI-1985-0042'))).toBe('CI-1985-0042')
  })

  it('LÈVE sur un cryptogramme illisible, au lieu de rendre null', async () => {
    // Le point qui distingue cette fonction de decryptIfPresent : une donnée
    // chiffrée qu'on ne sait plus lire est une ALERTE, pas une absence.
    const { decryptStoredValue } = await loadCrypto()
    const faux = `${'0'.repeat(24)}:${'1'.repeat(32)}:abcdef`
    expect(() => decryptStoredValue(faux)).toThrow()
  })

  it('rend null sur vide ou absent', async () => {
    const { decryptStoredValue } = await loadCrypto()
    expect(decryptStoredValue(null)).toBeNull()
    expect(decryptStoredValue('')).toBeNull()
  })
})
