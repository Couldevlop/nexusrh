import type { ReportData, TenantStats } from './types.js'

export interface Slice { label: string; value: number }
export interface Alert { severity: 'high' | 'medium'; tenant: string; detail: string }

export interface Totals {
  tenants: number; active: number; trial: number; suspended: number
  newTenants: number; headcount: number; hires: number; departures: number
  /** Variation nette d'effectif sur la période (arrivées − départs). */
  headcountChange: number
  activeUsers: number; usersLoggedIn: number
  loginSuccess: number
  /** Échecs de connexion — TOTAL PLATEFORME, jamais attribuable à une entreprise. */
  loginFailed: number
  /** Verrouillages de compte — TOTAL PLATEFORME, même raison. */
  loginLocked: number
  /** Connexions refusées pour tenant hors ligne — celles-ci sont bien par entreprise. */
  blockedOffline: number
  mfaRequired: number
  auditWrites: number
}

export interface Analysis {
  totals: Totals
  byPlan: Slice[]
  bySector: Slice[]
  /** Arrivées de la période par type de contrat, tous tenants confondus. */
  byContract: Slice[]
  agencyShare: Slice[]
  loginsByDay: Slice[]
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

/**
 * Tous les jours de la période, du plus ancien au plus récent.
 *
 * La série des connexions est complétée à ZÉRO sur les jours sans connexion :
 * omettre ces jours donnait un graphique qui mentait sur la forme de la
 * semaine — cinq barres serrées se lisent comme cinq jours consécutifs, alors
 * que deux jours creux avaient simplement disparu.
 */
function joursDeLaPeriode(debut: Date, fin: Date): string[] {
  const jours: string[] = []
  const d = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), debut.getUTCDate()))
  // Garde-fou : une période aberrante ne doit pas produire une série infinie.
  for (let i = 0; d < fin && i < 400; i++) {
    jours.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return jours
}

export function analyze(data: ReportData, now: Date): Analysis {
  const { tenants, agencies, period, platformAuth } = data
  const vus = tenants.filter((t) => t.collected)

  const hires = vus.reduce((s, t) => s + t.hires, 0)
  const departures = vus.reduce((s, t) => s + t.departures, 0)

  const totals: Totals = {
    tenants: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    trial: tenants.filter((t) => t.status === 'trial').length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
    newTenants: tenants.filter((t) => t.createdAt >= period.start && t.createdAt < period.end).length,
    headcount: vus.reduce((s, t) => s + t.headcount, 0),
    hires,
    departures,
    headcountChange: hires - departures,
    activeUsers: vus.reduce((s, t) => s + t.activeUsers, 0),
    usersLoggedIn: vus.reduce((s, t) => s + t.usersLoggedIn, 0),
    loginSuccess: vus.reduce((s, t) => s + t.loginSuccess, 0),
    // Total PLATEFORME : ces deux compteurs viennent de platform.audit_log,
    // pas des schémas tenant (voir collect.collectPlatformAuth).
    loginFailed: platformAuth.loginFailed,
    loginLocked: platformAuth.loginLocked,
    blockedOffline: vus.reduce((s, t) => s + t.blockedOffline, 0),
    mfaRequired: vus.reduce((s, t) => s + t.mfaRequired, 0),
    auditWrites: vus.reduce((s, t) => s + t.auditWrites, 0),
  }

  const parJour = new Map<string, number>()
  for (const jour of joursDeLaPeriode(period.start, period.end)) parJour.set(jour, 0)
  for (const t of vus) {
    for (const [jour, n] of Object.entries(t.loginsByDay)) {
      parJour.set(jour, (parJour.get(jour) ?? 0) + n)
    }
  }

  const parContrat = new Map<string, number>()
  for (const t of vus) {
    for (const [contrat, n] of Object.entries(t.hiresByContract)) {
      parContrat.set(contrat, (parContrat.get(contrat) ?? 0) + n)
    }
  }

  const alerts: Alert[] = []
  if (data.truncated) {
    // Signalé plutôt que tronqué en silence : au-delà du plafond, le rapport
    // ne décrit qu'une PARTIE du parc, et le lire comme un tout serait faux.
    alerts.push({
      severity: 'high', tenant: 'Plateforme',
      detail: 'parc trop grand pour une collecte complète — le rapport ne couvre '
        + `que les ${tenants.length} premières entreprises (par ordre alphabétique)`,
    })
  }
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
    if (t.status === 'trial' && t.trialEndsAt) {
      // Borne BASSE indispensable : sans elle, un essai expiré depuis des mois
      // déclenchait indéfiniment « essai arrivant à échéance » — un libellé
      // mensonger qui inversait l'action à mener.
      const reste = t.trialEndsAt.getTime() - now.getTime()
      if (reste < 0) {
        alerts.push({
          severity: 'high', tenant: t.name,
          detail: `essai expiré depuis ${Math.floor(-reste / JOUR_MS)} jours`,
        })
      } else if (reste < JOURS_AVANT_FIN_ESSAI * JOUR_MS) {
        alerts.push({
          severity: 'medium', tenant: t.name,
          detail: `essai arrivant à échéance dans ${Math.floor(reste / JOUR_MS)} jours`,
        })
      }
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
    byContract: [...parContrat.entries()].map(([label, value]) => ({ label, value }))
      .filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
    agencyShare: agencies.map((a) => ({ label: a.name, value: a.managedTenants }))
      .filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
    loginsByDay: [...parJour.entries()].map(([label, value]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    alerts,
    unavailable: tenants.filter((t) => !t.collected).map((t) => t.name),
  }
}
