import type { ReportData, TenantStats } from './types.js'

export interface Slice { label: string; value: number }
export interface Alert { severity: 'high' | 'medium'; tenant: string; detail: string }

export interface Totals {
  tenants: number; active: number; trial: number; suspended: number
  newTenants: number; headcount: number; hires: number; departures: number
  activeUsers: number; usersLoggedIn: number
  loginSuccess: number; loginFailed: number; loginLocked: number; mfaRequired: number
}

export interface Analysis {
  totals: Totals
  byPlan: Slice[]
  bySector: Slice[]
  agencyShare: Slice[]
  loginsByDay: Slice[]
  topFailures: Slice[]
  alerts: Alert[]
  unavailable: string[]
}

const JOURS_SANS_CONNEXION = 14
const JOURS_AVANT_FIN_ESSAI = 14
const SEUIL_PLAFOND = 0.9
const JOUR_MS = 86_400_000

function groupe(items: TenantStats[], cle: (t: TenantStats) => string | null): Slice[] {
  const m = new Map<string, number>()
  for (const t of items) {
    const k = cle(t) ?? 'non précisé'
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

export function analyze(data: ReportData, now: Date): Analysis {
  const { tenants, agencies, period } = data
  const vus = tenants.filter((t) => t.collected)

  const totals: Totals = {
    tenants: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    trial: tenants.filter((t) => t.status === 'trial').length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
    newTenants: tenants.filter((t) => t.createdAt >= period.start && t.createdAt < period.end).length,
    headcount: vus.reduce((s, t) => s + t.headcount, 0),
    hires: vus.reduce((s, t) => s + t.hires, 0),
    departures: vus.reduce((s, t) => s + t.departures, 0),
    activeUsers: vus.reduce((s, t) => s + t.activeUsers, 0),
    usersLoggedIn: vus.reduce((s, t) => s + t.usersLoggedIn, 0),
    loginSuccess: vus.reduce((s, t) => s + t.loginSuccess, 0),
    loginFailed: vus.reduce((s, t) => s + t.loginFailed, 0),
    loginLocked: vus.reduce((s, t) => s + t.loginLocked, 0),
    mfaRequired: vus.reduce((s, t) => s + t.mfaRequired, 0),
  }

  const parJour = new Map<string, number>()
  for (const t of vus) {
    for (const [jour, n] of Object.entries(t.loginsByDay)) {
      parJour.set(jour, (parJour.get(jour) ?? 0) + n)
    }
  }

  const alerts: Alert[] = []
  for (const t of tenants) {
    if (!t.collected) {
      alerts.push({ severity: 'high', tenant: t.name, detail: 'données indisponibles — schéma inaccessible' })
      continue
    }
    if (t.lastLoginAt) {
      if (now.getTime() - t.lastLoginAt.getTime() > JOURS_SANS_CONNEXION * JOUR_MS) {
        alerts.push({ severity: 'high', tenant: t.name, detail: `aucune connexion depuis ${JOURS_SANS_CONNEXION} jours` })
      }
    } else if (now.getTime() - t.createdAt.getTime() > JOURS_SANS_CONNEXION * JOUR_MS) {
      alerts.push({ severity: 'high', tenant: t.name, detail: 'aucune connexion depuis sa création' })
    }
    if (t.status === 'trial' && t.trialEndsAt
        && t.trialEndsAt.getTime() - now.getTime() < JOURS_AVANT_FIN_ESSAI * JOUR_MS) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: 'essai arrivant à échéance' })
    }
    if (t.maxEmployees > 0 && t.headcount / t.maxEmployees >= SEUIL_PLAFOND) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: `plafond employés atteint à ${Math.round(100 * t.headcount / t.maxEmployees)} %` })
    }
    if (t.maxUsers > 0 && t.activeUsers / t.maxUsers >= SEUIL_PLAFOND) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: `plafond utilisateurs atteint à ${Math.round(100 * t.activeUsers / t.maxUsers)} %` })
    }
    if (t.departures > t.hires) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: `effectif en baisse (${t.hires} arrivées, ${t.departures} départs)` })
    }
  }

  return {
    totals,
    byPlan: groupe(tenants, (t) => t.planType),
    bySector: groupe(tenants, (t) => t.sector),
    agencyShare: agencies.map((a) => ({ label: a.name, value: a.managedTenants }))
      .filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
    loginsByDay: [...parJour.entries()].map(([label, value]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    topFailures: vus.filter((t) => t.loginFailed > 0)
      .map((t) => ({ label: t.name, value: t.loginFailed }))
      .sort((a, b) => b.value - a.value).slice(0, 10),
    alerts,
    unavailable: tenants.filter((t) => !t.collected).map((t) => t.name),
  }
}
