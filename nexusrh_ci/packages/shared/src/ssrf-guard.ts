import { lookup } from 'dns/promises'
import { isIP, type LookupFunction } from 'net'
import { Agent } from 'undici'

/**
 * Garde anti-SSRF (OWASP A10) pour TOUS les appels sortants configurés par un
 * tenant (webhooks, connecteurs). Empêche qu'une URL pointe vers le réseau
 * interne / la boucle locale / l'endpoint de métadonnées cloud.
 *
 * Stratégie : schéma http(s) uniquement, pas de credentials dans l'URL, et
 * résolution DNS du hostname → on rejette si une IP résolue est privée /
 * loopback / link-local / metadata. La résolution réelle (et non une simple
 * regex sur le hostname) bloque les domaines qui pointent vers du privé.
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

/** Variante non-levante (booléen) pour la validation à la création. */
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
 * le SNI TLS d'origine restent intacts (routage vhost/HTTPS des serveurs
 * légitimes préservé). Le socket ne peut donc plus être détourné vers
 * 169.254.169.254 / 10.x / 127.0.0.1 entre le contrôle de la garde et la
 * connexion réelle de `fetch`.
 *
 * `lookup` suit la signature Node `dns.lookup` (celle attendue par
 * net.connect / undici). undici l'appelle avec `{ all: true }` → forme tableau ;
 * on gère AUSSI la forme `(err, address, family)` par prudence (compat versions).
 */
/**
 * Fabrique une fonction `lookup` (signature Node `dns.lookup`) qui renvoie
 * TOUJOURS l'IP épinglée, quel que soit le hostname demandé. undici l'appelle
 * avec `{ all: true }` → forme tableau ; on gère aussi `(err, address, family)`
 * par prudence (compat versions). Exportée pour test unitaire direct.
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
 * À utiliser à la place de `assertSafeOutboundUrl` + `fetch(url)` : passer
 * `dispatcher` à `fetch` garantit que la connexion TCP vise l'IP contrôlée
 * (anti DNS-rebinding). L'appelant DOIT fermer le dispatcher (`await
 * dispatcher.close()`) dans un `finally` pour ne pas fuiter de sockets.
 *
 * Lève `SsrfBlockedError` si l'URL est dangereuse. Pour le cas DNS : vérifie que
 * TOUTES les adresses résolues sont publiques, puis épingle sur la PREMIÈRE.
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

  // IP littérale → on épingle directement sur cette IP (aucun rebinding possible).
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

/** Variante non-levante de `resolveSafeOutbound` (pour les appelants qui ne
 *  doivent JAMAIS lever, ex. l'appel badgeuse attendance). */
export async function resolveSafeOutboundResult(
  raw: string,
): Promise<{ ok: true; value: SafeOutbound } | { ok: false; reason: string }> {
  try { return { ok: true, value: await resolveSafeOutbound(raw) } }
  catch (e) { return { ok: false, reason: (e as Error).message } }
}

/**
 * Garde anti-SSRF pour un hôte SMTP (host seul, sans schéma URL). Un admin
 * tenant configure host+port de son serveur SMTP puis peut déclencher une
 * connexion sortante depuis le pod API (POST /settings/email/test). Sans cette
 * garde, il pourrait viser l'endpoint de métadonnées cloud (169.254.169.254),
 * un service interne (postgres.<ns>.svc, 10.x, localhost…) et s'en servir comme
 * oracle de scan de ports / SSRF. Même politique de résolution DNS que
 * `assertSafeOutboundUrl` : on rejette si UNE SEULE adresse résolue est privée.
 * Lève `SsrfBlockedError` si dangereux, retourne void si sûr.
 */
export async function assertSafeSmtpHost(host: string): Promise<void> {
  const h = (host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) throw new SsrfBlockedError('Hôte SMTP vide')
  if (BLOCKED_HOSTNAMES.has(h) || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new SsrfBlockedError('Hôte SMTP interne interdit')
  }

  // Hôte déjà une IP littérale → vérifier directement.
  if (isIP(h)) {
    if (isPrivateIP(h)) throw new SsrfBlockedError('Adresse IP privée/interne interdite pour le SMTP')
    return
  }

  // Sinon résoudre le DNS et rejeter si une IP résolue est privée.
  let addrs: { address: string }[]
  try {
    addrs = await lookup(h, { all: true })
  } catch {
    throw new SsrfBlockedError('Hôte SMTP introuvable (DNS)')
  }
  if (addrs.length === 0) throw new SsrfBlockedError('Hôte SMTP introuvable')
  for (const a of addrs) {
    if (isPrivateIP(a.address)) throw new SsrfBlockedError('L\'hôte SMTP résout vers une adresse interne')
  }
}

/**
 * Alias générique : valider un hôte:port sortant (hors URL http) revient à la
 * même politique que pour le SMTP. Conservé pour les appelants qui raisonnent en
 * termes d'« hôte sortant » plutôt que « SMTP ».
 */
export const assertSafeOutboundHost = assertSafeSmtpHost
