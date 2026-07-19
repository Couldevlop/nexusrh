/**
 * Lecture BORNÉE des corps de réponse HTTP sortants (OWASP A10 / A04 — DoS
 * mémoire cross-tenant).
 *
 * Problème corrigé : tous les appels sortants configurés par un admin tenant
 * (badgeuse, webhook, connecteur REST, API Mobile Money, veille légale) visent
 * une cible NON FIABLE. Bufferiser d'abord (`res.json()`, `res.text()`,
 * `res.arrayBuffer()`) puis vérifier la taille est inutile : une cible qui
 * streame plusieurs Go épuise la mémoire du process API/worker PARTAGÉ entre
 * tous les tenants avant même que le contrôle ne s'exécute.
 *
 * Correctif : on compte les octets EN FLUX (`response.body` lu via son reader
 * web stream) et on ANNULE le flux (`reader.cancel()`) dès que le cap est
 * dépassé — la mémoire consommée est bornée par `maxBytes`, jamais par la
 * taille annoncée ou réelle de la réponse. Si `Content-Length` est présent et
 * déjà supérieur au cap, on rejette SANS RIEN LIRE.
 *
 * Les messages d'erreur sont GÉNÉRIQUES (taille annoncée/cap uniquement) :
 * aucun détail réseau ou contenu distant ne fuit vers le client.
 *
 * DUPLICATION ASSUMÉE : copie fonctionnellement IDENTIQUE de
 * `apps/api/src/services/http-body-limit.ts`. Le worker (`@nexusrhci/worker`)
 * est un package séparé SANS dépendance vers `@nexusrhci/api` — même patron que
 * `utils/ssrf-guard.ts` (copie de `services/ssrf-guard.ts`) : on duplique
 * plutôt que d'introduire une dépendance cross-package.
 */

/** Cap par défaut : 5 Mo. Toute réponse légitime d'intégration est très en deçà. */
export const DEFAULT_MAX_BODY_BYTES = 5_000_000

/** Erreur typée : la réponse distante dépasse le cap autorisé. */
export class BodyTooLargeError extends Error {
  readonly maxBytes: number
  constructor(maxBytes: number) {
    super(`Réponse distante trop volumineuse (limite ${maxBytes} octets)`)
    this.name = 'BodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

/**
 * Forme minimale d'une réponse acceptée par ce module. On ne dépend pas du type
 * `Response` global : les appelants (et leurs tests) fournissent parfois un
 * objet partiel. Tout est optionnel sauf rien — les chemins absents sont gérés.
 */
export interface CappedReadable {
  body?: ReadableStream<Uint8Array> | null
  headers?: { get(name: string): string | null } | undefined
  text?: () => Promise<string>
  json?: () => Promise<unknown>
}

/** Annule le flux sans jamais lever (best-effort : libère le socket). */
async function cancelQuietly(response: CappedReadable): Promise<void> {
  try {
    const stream = response.body
    if (stream && typeof stream.cancel === 'function') await stream.cancel()
  } catch {
    /* flux déjà consommé/annulé — sans conséquence */
  }
}

/**
 * Rejette AVANT toute lecture si `Content-Length` est présent et dépasse le cap.
 * Un en-tête absent, non numérique ou mensonger n'affaiblit rien : le comptage
 * en flux reste la garantie réelle.
 */
async function assertContentLengthWithin(response: CappedReadable, maxBytes: number): Promise<void> {
  let declared: string | null = null
  try {
    declared = response.headers?.get('content-length') ?? null
  } catch {
    declared = null
  }
  if (declared === null) return
  const size = Number(declared)
  if (Number.isFinite(size) && size > maxBytes) {
    await cancelQuietly(response)
    throw new BodyTooLargeError(maxBytes)
  }
}

/**
 * Lit le corps d'une réponse en octets, en s'arrêtant (et en annulant le flux)
 * dès que `maxBytes` est dépassé.
 *
 * @throws {BodyTooLargeError} si le corps dépasse le cap (ou l'annonce déjà).
 */
export async function readBodyCapped(
  response: CappedReadable,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  await assertContentLengthWithin(response, maxBytes)

  const stream = response.body
  if (!stream || typeof stream.getReader !== 'function') {
    // Chemin dégradé : réponse sans flux web (implémentation partielle / double
    // de test). On lit alors le corps complet puis on applique le MÊME cap —
    // la garantie mémoire n'est plus stricte, mais ce chemin n'existe pas avec
    // le `fetch` d'undici en production, qui expose toujours `body`.
    if (typeof response.text !== 'function') return ''
    let text: string
    try {
      text = await response.text()
    } catch {
      return ''
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new BodyTooLargeError(maxBytes)
    return text
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        // Cap dépassé : on ANNULE immédiatement le flux (le reste n'est jamais
        // téléchargé ni alloué) et on abandonne les octets déjà bufferisés.
        chunks.length = 0
        try { await reader.cancel() } catch { /* best-effort */ }
        throw new BodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof BodyTooLargeError) throw e
    try { await reader.cancel() } catch { /* best-effort */ }
    throw e
  }

  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

/**
 * Variante JSON : lit le corps borné puis le parse. Lève `BodyTooLargeError`
 * au-delà du cap, ou une `SyntaxError` si le JSON est invalide (l'appelant
 * traduit en message générique).
 */
export async function readJsonCapped(
  response: CappedReadable,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const stream = response.body
  if ((!stream || typeof stream.getReader !== 'function') && typeof response.json === 'function') {
    // Chemin dégradé (cf. readBodyCapped) : on respecte au moins Content-Length.
    await assertContentLengthWithin(response, maxBytes)
    return await response.json()
  }
  const text = await readBodyCapped(response, maxBytes)
  return JSON.parse(text) as unknown
}
