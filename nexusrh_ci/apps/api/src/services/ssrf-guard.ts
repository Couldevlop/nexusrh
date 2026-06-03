import { lookup } from 'dns/promises'
import { isIP } from 'net'

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
