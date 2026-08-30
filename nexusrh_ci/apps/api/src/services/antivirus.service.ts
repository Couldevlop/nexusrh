/**
 * Analyse antivirale des fichiers déposés (OWASP A08 — Software and Data
 * Integrity Failures).
 *
 * Contexte : sept points de dépôt acceptent des fichiers, dont un ANONYME
 * (candidature publique). Taille, type MIME déclaré et signature de contenu sont
 * vérifiés en amont — mais la CHARGE ne l'était pas. Un PDF authentique porteur
 * d'un exploit de lecteur, ou un document bureautique macro-armé, atteignait le
 * poste RH qui le télécharge.
 *
 * Implémentation : protocole clamd natif (`INSTREAM`) sur socket TCP. Aucune
 * dépendance npm ajoutée — un client ClamAV tiers apporterait sa propre surface
 * de vulnérabilités pour ~80 lignes de protocole trivial.
 *
 * ── Comportement ────────────────────────────────────────────────────────────
 * Désactivé (CLAMAV_HOST absent, cas par défaut en dev et en test) : renvoie
 * `{ clean: true, scanned: false }`. Aucun changement de comportement.
 *
 * Activé : le fichier est analysé.
 *   - propre        → `{ clean: true,  scanned: true }`
 *   - infecté       → `{ clean: false, signature: '…' }`
 *   - erreur/timeout→ `{ clean: false, error: '…' }`  ← ÉCHEC FERMÉ, délibéré.
 *
 * L'échec fermé est un choix assumé : une fois l'antivirus activé, un dépôt qui
 * n'a PAS pu être analysé ne doit pas être accepté « au bénéfice du doute »,
 * sinon il suffit de saturer le service pour rouvrir le trou qu'il colmate. Le
 * coût est une indisponibilité temporaire du dépôt de fichiers si clamd tombe.
 */
import { connect, type Socket } from 'node:net'
import { config } from '../config.js'

export interface ScanResult {
  /** true = le fichier peut être accepté. */
  clean: boolean
  /** false = analyse désactivée (aucun antivirus configuré). */
  scanned: boolean
  /** Nom de la signature détectée, si infecté. */
  signature?: string
  /** Motif technique de l'échec, si l'analyse n'a pas pu aboutir. */
  error?: string
}

/** Réglages par défaut si le bloc `antivirus` est absent de la config. */
const DISABLED = { host: null as string | null, port: 3310, timeoutMs: 15_000, chunkSize: 64 * 1024 }

/**
 * Lecture DÉFENSIVE du bloc de configuration.
 *
 * Plusieurs suites de tests remplacent `config.js` par un objet partiel. Un
 * accès direct à `config.antivirus.host` y lèverait un TypeError DANS le
 * handler de dépôt — c'est-à-dire qu'un helper de sécurité ferait tomber en 500
 * la route qu'il est censé protéger. Bloc absent = antivirus non configuré =
 * analyse désactivée, exactement comme `CLAMAV_HOST` vide. En production le
 * bloc est toujours présent : ce repli ne peut pas désactiver un antivirus
 * réellement configuré.
 */
function settings(): typeof DISABLED {
  return (config as { antivirus?: typeof DISABLED }).antivirus ?? DISABLED
}

/**
 * Encode un buffer au format INSTREAM de clamd : une suite de blocs
 * `<longueur uint32 big-endian><données>`, terminée par une longueur nulle.
 */
function encodeInstream(buf: Buffer, chunkSize: number): Buffer {
  const parts: Buffer[] = [Buffer.from('zINSTREAM\0', 'utf8')]
  for (let off = 0; off < buf.length; off += chunkSize) {
    const slice = buf.subarray(off, Math.min(off + chunkSize, buf.length))
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(slice.length, 0)
    parts.push(len, slice)
  }
  const end = Buffer.allocUnsafe(4)
  end.writeUInt32BE(0, 0)
  parts.push(end)
  return Buffer.concat(parts)
}

/**
 * Interprète la réponse de clamd.
 * `stream: OK` → propre · `stream: <SIG> FOUND` → infecté · reste → erreur.
 */
export function parseClamdReply(reply: string): ScanResult {
  const line = reply.replace(/\0/g, '').trim()
  if (/\bOK$/.test(line)) return { clean: true, scanned: true }
  const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(line)
  if (found) return { clean: false, scanned: true, signature: found[1] }
  return { clean: false, scanned: true, error: line || 'réponse antivirus vide' }
}

/**
 * Analyse un buffer. Ne lève jamais : toute anomalie est traduite en
 * `{ clean: false, error }` pour que l'appelant décide de la réponse HTTP.
 */
export function scanBuffer(buf: Buffer): Promise<ScanResult> {
  const { host, port, timeoutMs, chunkSize } = settings()
  if (!host) return Promise.resolve({ clean: true, scanned: false })

  return new Promise<ScanResult>((resolve) => {
    let settled = false
    const done = (r: ScanResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(r)
    }

    const timer = setTimeout(
      () => done({ clean: false, scanned: false, error: `délai dépassé (${timeoutMs} ms)` }),
      timeoutMs,
    )

    let socket: Socket
    try {
      socket = connect({ host, port })
    } catch (e) {
      clearTimeout(timer)
      resolve({ clean: false, scanned: false, error: (e as Error).message })
      return
    }

    const chunks: Buffer[] = []
    socket.on('connect', () => {
      socket.write(encodeInstream(buf, chunkSize))
    })
    socket.on('data', (d: Buffer) => {
      chunks.push(d)
      // clamd termine sa réponse par un octet nul.
      if (d.includes(0)) done(parseClamdReply(Buffer.concat(chunks).toString('utf8')))
    })
    socket.on('end',   () => done(parseClamdReply(Buffer.concat(chunks).toString('utf8'))))
    socket.on('error', (e) => done({ clean: false, scanned: false, error: e.message }))
  })
}

/** Message utilisateur (français, sans détail technique — OWASP A09). */
export function scanRejectionMessage(r: ScanResult): string {
  if (r.signature) return 'Ce fichier a été identifié comme malveillant et a été refusé.'
  return "Le fichier n'a pas pu être contrôlé par l'antivirus. Réessayez dans quelques instants."
}
