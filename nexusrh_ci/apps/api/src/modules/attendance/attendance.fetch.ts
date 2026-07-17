import { isSafeOutboundUrl } from '../../services/ssrf-guard.js'
import { mapDeviceResponse } from './attendance.mapping.js'
import type { FieldMapping, NormalizedPunch } from './attendance.types.js'

const FETCH_TIMEOUT_MS = 15_000

export interface DeviceConnectionConfig {
  baseUrl: string
  authType: string
  authSecret: string | null
  authHeaderName: string | null
  defaultHeaders: Record<string, string>
  fieldMapping: FieldMapping
  syncCursor: string | null
}

export interface FetchDevicePunchesResult {
  punches: NormalizedPunch[]
  ok: boolean
  error?: string
}

/**
 * Construit les en-têtes HTTP sortants (headers par défaut du tenant + auth).
 * `authSecret` arrive DÉJÀ déchiffré par l'appelant — jamais loggé, jamais
 * renvoyé dans un message d'erreur. Si l'auth requiert un secret/nom d'en-tête
 * manquant, on l'ignore silencieusement plutôt que de lever une exception
 * (garde défensive — ne doit jamais faire échouer l'appel réseau).
 */
function buildHeaders(device: DeviceConnectionConfig): Record<string, string> {
  const headers: Record<string, string> = { ...device.defaultHeaders }

  switch (device.authType) {
    case 'bearer':
      if (device.authSecret) headers['Authorization'] = `Bearer ${device.authSecret}`
      break
    case 'basic':
      if (device.authSecret) headers['Authorization'] = `Basic ${device.authSecret}`
      break
    case 'api_key':
      if (device.authSecret && device.authHeaderName) headers[device.authHeaderName] = device.authSecret
      break
    case 'none':
    default:
      break
  }

  return headers
}

/**
 * Filtre les pointages normalisés selon le curseur de synchronisation.
 * Règle déterministe : `syncCursor` est l'ISO 8601 de `punchedAt` du dernier
 * pointage déjà tiré ; on ne garde que les pointages dont `punchedAt` est
 * STRICTEMENT postérieur au curseur (comparaison de timestamps epoch ms —
 * fiable même si les formats de sérialisation ISO diffèrent légèrement).
 * Sans curseur (première synchronisation), on garde tout.
 */
function filterBySyncCursor(punches: NormalizedPunch[], syncCursor: string | null): NormalizedPunch[] {
  if (!syncCursor) return punches
  const cursorTime = new Date(syncCursor).getTime()
  if (Number.isNaN(cursorTime)) return punches
  return punches.filter(p => p.punchedAt.getTime() > cursorTime)
}

/**
 * Appelle une badgeuse tenant (URL configurée par l'administrateur) pour
 * récupérer les pointages depuis le dernier curseur de synchronisation.
 *
 * SÉCURITÉ (OWASP A10 — SSRF) : la garde `isSafeOutboundUrl` est OBLIGATOIREMENT
 * exécutée AVANT tout `fetch` réseau, et son résultat `.ok` est vérifié —
 * jamais de court-circuit qui traiterait l'objet retourné comme un booléen.
 * Aucune exception ne doit se propager hors de cette fonction (frontière avec
 * un système externe non fiable) : tout échec (réseau, timeout, JSON invalide,
 * statut non-2xx) est converti en `{ ok: false, error }`, et le secret
 * d'authentification n'apparaît JAMAIS dans le message d'erreur retourné.
 */
export async function fetchDevicePunches(device: DeviceConnectionConfig): Promise<FetchDevicePunchesResult> {
  try {
    const safe = await isSafeOutboundUrl(device.baseUrl)
    if (safe.ok !== true) {
      return { punches: [], ok: false, error: safe.reason }
    }

    const headers = buildHeaders(device)

    let response: Response
    try {
      response = await fetch(device.baseUrl, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
      })
    } catch (e) {
      return { punches: [], ok: false, error: `Appel badgeuse échoué : ${(e as Error).message}` }
    }

    if (!response.ok) {
      return { punches: [], ok: false, error: `HTTP ${response.status}` }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (e) {
      return { punches: [], ok: false, error: `Réponse badgeuse illisible (JSON) : ${(e as Error).message}` }
    }

    const allPunches = mapDeviceResponse(body, device.fieldMapping)
    const punches = filterBySyncCursor(allPunches, device.syncCursor)

    return { punches, ok: true }
  } catch (e) {
    return { punches: [], ok: false, error: `Erreur inattendue : ${(e as Error).message}` }
  }
}
