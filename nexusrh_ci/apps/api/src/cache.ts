/** Shared in-process caches to avoid circular imports */

export const maintenanceCache = {
  value: false,
  expiresAt: 0,
  invalidate() { this.value = false; this.expiresAt = 0 },
}
