/**
 * Extraction de texte depuis un fichier CV uploadé.
 *
 * Infra utilitaire partagée entre l'upload RH (authentifié) et l'upload public
 * (page carrières). Centraliser ici évite la duplication et garantit le même
 * traitement (et les mêmes garde-fous) quelle que soit la source.
 *
 * - PDF : extraction native via `unpdf` (pas de binaire système requis).
 * - TXT : décodage UTF-8 direct.
 * - DOC/DOCX : fallback UTF-8 partiel (extraction native dans un sprint suivant).
 *
 * OWASP A03 (content-type spoofing) : l'appelant DOIT valider le MIME via
 * `CV_ALLOWED_MIMES` et la taille via `CV_MAX_BYTES` AVANT d'appeler ce module.
 * On expose ces constantes ici pour une politique unique.
 */

/** MIME autorisés pour un CV (allowlist stricte). */
export const CV_ALLOWED_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
])

/** Taille max d'un CV uploadé par un utilisateur authentifié (10 Mo). */
export const CV_MAX_BYTES = 10 * 1024 * 1024

/** Taille max d'un CV uploadé en public (5 Mo — surface non authentifiée). */
export const CV_MAX_BYTES_PUBLIC = 5 * 1024 * 1024

/** Longueur max de texte extrait conservée (anti-explosion de prompt IA). */
const MAX_TEXT = 50_000

/**
 * Vérifie la signature (magic bytes) du buffer contre le MIME déclaré.
 * OWASP A03 : empêche le content-type spoofing (un .exe renommé en .pdf).
 * Retourne true si cohérent OU si le format n'a pas de signature fiable (TXT).
 */
export function isMagicByteConsistent(buf: Buffer, mimetype: string): boolean {
  if (buf.length < 4) return false
  const mime = mimetype.toLowerCase()
  // PDF : "%PDF"
  if (mime === 'application/pdf') {
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
  }
  // DOCX (zip) : "PK\x03\x04"
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
  }
  // DOC (OLE) : D0 CF 11 E0
  if (mime === 'application/msword') {
    return buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
  }
  // TXT : pas de signature fiable → accepté
  if (mime === 'text/plain') return true
  return false
}

/**
 * Extrait le texte d'un CV. En cas d'échec d'extraction (PDF corrompu, etc.),
 * fallback UTF-8 pour ne pas bloquer — l'IA détectera un texte incohérent et
 * basculera, si un PDF est disponible, vers son mode document natif.
 */
export async function extractCvText(buf: Buffer, mimetype: string): Promise<string> {
  if (mimetype === 'application/pdf') {
    try {
      const { getDocumentProxy, extractText } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      const result = await extractText(pdf, { mergePages: true })
      const text = Array.isArray(result.text) ? result.text.join('\n') : (result.text ?? '')
      const cleaned = text.replace(/\s+/g, ' ').trim()
      if (cleaned.length > 0) return cleaned.slice(0, MAX_TEXT)
    } catch {
      // PDF illisible : fallback UTF-8 ci-dessous.
    }
  }
  return buf.toString('utf-8').slice(0, MAX_TEXT)
}
