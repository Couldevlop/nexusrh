/** Shared in-process caches to avoid circular imports */

export const maintenanceCache = {
  value: false,
  expiresAt: 0,
  invalidate() { this.value = false; this.expiresAt = 0 },
}

/**
 * Statut hors-ligne par organisation (tenant via schema_name, cabinet via id).
 * TTL 30s : évite une requête DB par requête API tout en propageant une mise
 * hors ligne en ≤ 30s sur tous les pods. invalidate() = effet immédiat sur le
 * pod qui a traité l'action super_admin.
 */
export interface OfflineStatus {
  offline: boolean
  message: string | null
}

const OFFLINE_TTL_MS = 30_000

export const offlineStatusCache = {
  entries: new Map<string, { status: OfflineStatus; expiresAt: number }>(),
  get(key: string): OfflineStatus | null {
    const e = this.entries.get(key)
    if (!e || Date.now() >= e.expiresAt) return null
    return e.status
  },
  set(key: string, status: OfflineStatus) {
    this.entries.set(key, { status, expiresAt: Date.now() + OFFLINE_TTL_MS })
  },
  invalidate() { this.entries.clear() },
}
