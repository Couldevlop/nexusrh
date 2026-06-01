/**
 * Vérification de fuite de mot de passe — API « Pwned Passwords » (HaveIBeenPwned)
 * en k-anonymat.
 *
 * Sécurité :
 *   A02 — le mot de passe en clair ne quitte JAMAIS le serveur. On envoie
 *         uniquement les 5 premiers caractères hex du SHA-1 ; le suffixe (35
 *         caractères) est comparé localement à la liste renvoyée par l'API.
 *   A10 — toute erreur réseau / DNS / timeout retourne `null` (vérif impossible),
 *         JAMAIS une exception : la fonctionnalité est strictement non bloquante
 *         « quand il y a accès internet ». Pas d'accès → on n'empêche pas le login.
 *
 * Note : `Add-Padding: true` demande à l'API de renvoyer des entrées factices
 * (count = 0) pour masquer, côté réseau, la présence réelle d'un hash. On ignore
 * donc les lignes dont le compteur est à 0.
 */
import { createHash } from 'crypto'

const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range/'
const DEFAULT_TIMEOUT_MS = 2500

export interface BreachCheckOptions {
  /** Délai max avant abandon (défaut 2500 ms). Au-delà → null (non bloquant). */
  timeoutMs?: number
  /** Injection de `fetch` (tests). Défaut : `globalThis.fetch` (Node 20+). */
  fetchImpl?: typeof fetch
  /** Override de l'URL de l'API range (tests). */
  rangeUrl?: string
}

/**
 * @returns `true`  → le mot de passe figure dans une fuite connue
 *          `false` → absent des fuites connues
 *          `null`  → vérification impossible (pas d'accès internet, timeout,
 *                    API indisponible) — l'appelant NE DOIT PAS bloquer là-dessus.
 */
export async function isPasswordBreached(
  plain: string,
  opts: BreachCheckOptions = {},
): Promise<boolean | null> {
  if (!plain) return null

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
  const rangeUrl = opts.rangeUrl ?? PWNED_RANGE_URL
  if (typeof doFetch !== 'function') return null

  const sha1 = createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(`${rangeUrl}${prefix}`, {
      method: 'GET',
      headers: {
        'Add-Padding': 'true',
        'User-Agent': 'NexusRH-CI-BreachCheck',
      },
      signal: controller.signal,
    })
    if (!res.ok) return null

    const text = await res.text()
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const sepIdx = line.indexOf(':')
      const hashSuffix = (sepIdx === -1 ? line : line.slice(0, sepIdx)).trim().toUpperCase()
      if (hashSuffix !== suffix) continue
      // Match : vérifier le compteur (les lignes de padding ont count = 0).
      const countStr = sepIdx === -1 ? '' : line.slice(sepIdx + 1).trim()
      const count = parseInt(countStr, 10)
      if (countStr === '' || (Number.isFinite(count) && count > 0)) return true
      return false
    }
    return false
  } catch {
    // AbortError (timeout) / réseau / DNS → pas d'accès internet : non bloquant.
    return null
  } finally {
    clearTimeout(timer)
  }
}
