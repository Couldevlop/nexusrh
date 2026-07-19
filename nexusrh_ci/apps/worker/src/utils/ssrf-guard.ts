import { lookup } from 'dns/promises'
import { isIP, type LookupFunction } from 'net'
import { Agent } from 'undici'

/**
 * Garde anti-SSRF (OWASP A10) pour les appels sortants du worker vers une
 * badgeuse tenant (`attendance-poll`, cf. `jobs/attendance-poll.ts`).
 *
 * Copie fonctionnellement IDENTIQUE à `apps/api/src/services/ssrf-guard.ts`.
 * Le worker (`@nexusrhci/worker`) est un package séparé sans dépendance vers
 * `@nexusrhci/api` (aucun job existant n'importe depuis l'API — cf.
 * legal-watch.ts, cnps.ts) : le module est donc dupliqué ici plutôt
 * qu'importé, avec les mêmes garanties (schéma http(s) uniquement, pas de
 * credentials dans l'URL, résolution DNS réelle et rejet de toute IP privée /
 * loopback / link-local / metadata cloud).
 */

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true // prudence
  const [a, b] = p as [number, number, number, number]
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true            // link-local + metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT
  if (a >= 224) return true                           // multicast / réservé
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const x = ip.toLowerCase()
  if (x === '::1' || x === '::') return true
  if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true // link-local / ULA
  if (x.startsWith('::ffff:')) return isPrivateIPv4(x.slice(7))                     // IPv4-mapped
  return false
}

function isPrivateIP(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isPrivateIPv4(ip)
  if (v === 6) return isPrivateIPv6(ip)
  return true
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal'])

export class SsrfBlockedError extends Error {
  constructor(reason: string) { super(reason); this.name = 'SsrfBlockedError' }
}

/**
 * Valide une URL sortante. Lève SsrfBlockedError si dangereuse.
 * Renvoie l'URL normalisée (objet URL) si sûre.
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new SsrfBlockedError('URL invalide') }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Seuls http(s) sont autorisés')
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('Identifiants dans l\'URL interdits')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfBlockedError('Hôte interne interdit')
  }

  // Si le hostname est déjà une IP littérale → vérifier directement.
  if (isIP(host)) {
    if (isPrivateIP(host)) throw new SsrfBlockedError('Adresse IP privée/interne interdite')
    return url
  }

  // Sinon, résoudre le DNS et rejeter si une IP résolue est privée.
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new SsrfBlockedError('Hôte introuvable (DNS)')
  }
  if (addrs.length === 0) throw new SsrfBlockedError('Hôte introuvable')
  for (const a of addrs) {
    if (isPrivateIP(a.address)) throw new SsrfBlockedError('L\'hôte résout vers une adresse interne')
  }
  return url
}

/** Variante non-levante (booléen) pour la validation avant fetch. */
export async function isSafeOutboundUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try { await assertSafeOutboundUrl(raw); return { ok: true } }
  catch (e) { return { ok: false, reason: (e as Error).message } }
}

/**
 * Résultat d'une résolution sûre : l'URL validée + l'IP EXACTE que la garde a
 * contrôlée + un dispatcher undici épinglé sur cette IP.
 */
export interface SafeOutbound {
  url: URL
  ip: string
  family: number
  dispatcher: Agent
}

/**
 * Construit un dispatcher undici dont la résolution DNS est ÉPINGLÉE sur l'IP
 * déjà validée par la garde. Ferme la fenêtre de DNS-rebinding (TOCTOU) : la
 * connexion TCP vise EXACTEMENT l'IP contrôlée, tandis que l'en-tête `Host` et
 * le SNI TLS d'origine restent intacts. Le socket ne peut plus être détourné
 * vers 169.254.169.254 / 10.x / 127.0.0.1 entre le contrôle et la connexion.
 *
 * `lookup` suit la signature Node `dns.lookup`. undici l'appelle avec
 * `{ all: true }` → forme tableau ; on gère AUSSI `(err, address, family)`.
 */
/**
 * Fabrique une fonction `lookup` (signature Node `dns.lookup`) qui renvoie
 * TOUJOURS l'IP épinglée. undici l'appelle avec `{ all: true }` → forme
 * tableau ; on gère aussi `(err, address, family)`. Exportée pour test direct.
 */
export function pinnedLookupFor(ip: string, family: number): LookupFunction {
  const fam = family === 6 ? 6 : 4
  return (_hostname, options, callback) => {
    if (options && (options as { all?: boolean }).all) {
      callback(null, [{ address: ip, family: fam }])
    } else {
      callback(null, ip, fam)
    }
  }
}

export function pinnedDispatcher(ip: string, family: number): Agent {
  return new Agent({ connect: { lookup: pinnedLookupFor(ip, family) } })
}

/**
 * Valide une URL sortante ET construit le dispatcher épinglé sur l'IP validée.
 * L'appelant DOIT fermer le dispatcher (`await dispatcher.close()`) dans un
 * `finally`. Lève `SsrfBlockedError` si dangereuse ; pour le cas DNS : vérifie
 * que TOUTES les adresses sont publiques, puis épingle sur la PREMIÈRE.
 */
export async function resolveSafeOutbound(raw: string): Promise<SafeOutbound> {
  let url: URL
  try { url = new URL(raw) } catch { throw new SsrfBlockedError('URL invalide') }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Seuls http(s) sont autorisés')
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('Identifiants dans l\'URL interdits')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfBlockedError('Hôte interne interdit')
  }

  // IP littérale → épinglage direct (aucun rebinding possible).
  const litFamily = isIP(host)
  if (litFamily) {
    if (isPrivateIP(host)) throw new SsrfBlockedError('Adresse IP privée/interne interdite')
    return { url, ip: host, family: litFamily, dispatcher: pinnedDispatcher(host, litFamily) }
  }

  // DNS : vérifier TOUTES les adresses résolues, épingler la première validée.
  let addrs: { address: string; family: number }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new SsrfBlockedError('Hôte introuvable (DNS)')
  }
  if (addrs.length === 0) throw new SsrfBlockedError('Hôte introuvable')
  for (const a of addrs) {
    if (isPrivateIP(a.address)) throw new SsrfBlockedError('L\'hôte résout vers une adresse interne')
  }
  const pinned = addrs[0]!
  return { url, ip: pinned.address, family: pinned.family, dispatcher: pinnedDispatcher(pinned.address, pinned.family) }
}

/** Variante non-levante de `resolveSafeOutbound` (l'appel badgeuse ne doit
 *  JAMAIS lever hors de la fonction). */
export async function resolveSafeOutboundResult(
  raw: string,
): Promise<{ ok: true; value: SafeOutbound } | { ok: false; reason: string }> {
  try { return { ok: true, value: await resolveSafeOutbound(raw) } }
  catch (e) { return { ok: false, reason: (e as Error).message } }
}
