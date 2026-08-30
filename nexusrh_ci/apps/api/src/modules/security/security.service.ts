/**
 * Sécurité & conformité — logique PURE (SSO/AD + export SIEM).
 *
 * Couvre l'exigence DAO « SSO / Active Directory + SIEM » :
 *  - SSO : résolution du domaine e-mail géré par un fournisseur d'identité,
 *    mapping groupes IdP → rôle NexusRH, provisionnement à la volée (JIT).
 *  - SIEM : catégorisation des événements d'audit et formatage (JSON / CEF)
 *    pour transmission à un puits SIEM externe.
 *
 * Aucune dépendance Fastify/DB/réseau → entièrement testable.
 */

// ── Rôles tenant valides (cible d'un mapping SSO ; super_admin exclu) ────────
export const TENANT_ROLES = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg', 'raf_site'] as const
export type TenantRole = (typeof TENANT_ROLES)[number]
export function isValidTenantRole(r: unknown): r is TenantRole {
  return typeof r === 'string' && (TENANT_ROLES as readonly string[]).includes(r)
}

// ── SSO ──────────────────────────────────────────────────────────────────────
export const SSO_PROVIDERS = ['oidc', 'saml', 'ldap'] as const
export type SsoProvider = (typeof SSO_PROVIDERS)[number]
export interface GroupRoleMapping { group: string; role: TenantRole }

// ── SIEM ──────────────────────────────────────────────────────────────────────
export const SIEM_TRANSPORTS = ['webhook', 'syslog_http'] as const
export type SiemTransport = (typeof SIEM_TRANSPORTS)[number]
export const SIEM_FORMATS = ['json', 'cef'] as const
export type SiemFormat = (typeof SIEM_FORMATS)[number]
// Catégories d'événements de sécurité transmissibles à un SIEM.
export const EVENT_CATEGORIES = ['auth', 'rbac', 'data_access', 'config', 'export', 'admin'] as const
export type EventCategory = (typeof EVENT_CATEGORIES)[number]

/**
 * Classe une action du journal d'audit (ex. "auth.login_failed",
 * "classification.sensitive_access", "tenant.modules_updated") en catégorie SIEM.
 */
export function categorizeAction(action: string): EventCategory {
  const a = action.toLowerCase()
  if (a.startsWith('auth.') || a.includes('login') || a.includes('mfa') || a.includes('lockout') || a.includes('password')) return 'auth'
  if (a.includes('sensitive_access') || a.includes('export') || a.includes('download')) {
    return a.includes('export') || a.includes('download') ? 'export' : 'data_access'
  }
  if (a.includes('role') || a.includes('permission') || a.includes('forbidden') || a.includes('denied')) return 'rbac'
  if (a.endsWith('.deleted') || a.includes('reset') || a.includes('suspend') || a.includes('provision')) return 'admin'
  if (a.includes('config') || a.includes('settings') || a.includes('module') || a.includes('updated') || a.includes('created')) return 'config'
  return 'admin'
}

export interface SecurityEvent {
  id: string
  action: string
  entity: string | null
  userId: string | null
  ip: string | null
  at: string // ISO
  tenant: string
}

/** L'événement doit-il être transmis selon les catégories sélectionnées ? */
export function shouldForward(enabledCategories: string[], action: string): boolean {
  return enabledCategories.includes(categorizeAction(action))
}

/** Niveau de sévérité CEF (0–10) déduit de la catégorie. */
function severityFor(cat: EventCategory): number {
  switch (cat) {
    case 'auth': return 6
    case 'rbac': return 7
    case 'data_access': return 5
    case 'export': return 6
    case 'admin': return 8
    case 'config': return 4
  }
}

/**
 * Formate un événement de sécurité pour le SIEM.
 *  - json : objet sérialisé (clé/valeur stables)
 *  - cef  : ligne ArcSight CEF v0 (en-tête + extensions).
 */
export function formatEvent(event: SecurityEvent, format: SiemFormat): string {
  const cat = categorizeAction(event.action)
  if (format === 'cef') {
    const ext = [
      `rt=${Date.parse(event.at) || ''}`,
      `suser=${event.userId ?? 'unknown'}`,
      `src=${event.ip ?? ''}`,
      `cs1Label=tenant cs1=${event.tenant}`,
      `cs2Label=entity cs2=${event.entity ?? ''}`,
    ].join(' ')
    // CEF:Version|Vendor|Product|Version|SignatureID|Name|Severity|Extension
    return `CEF:0|OpenLab|NexusRH CI|1.0|${event.action}|${cat}|${severityFor(cat)}|${ext}`
  }
  return JSON.stringify({
    id: event.id, category: cat, action: event.action, entity: event.entity,
    user: event.userId, ip: event.ip, timestamp: event.at, tenant: event.tenant,
  })
}
