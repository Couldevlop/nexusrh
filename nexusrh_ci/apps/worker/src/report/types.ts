import type { Period } from './period.js'

/** Statistiques d'une entreprise sur la période. Aucun champ nominatif. */
export interface TenantStats {
  tenantId: string
  name: string
  schemaName: string
  status: string
  planType: string
  sector: string | null
  maxUsers: number
  maxEmployees: number
  trialEndsAt: Date | null
  createdAt: Date
  /** false = schéma indisponible ; les compteurs sont alors à zéro. */
  collected: boolean
  headcount: number
  hires: number
  departures: number
  /** Répartition des arrivées par type de contrat — jamais de nom. */
  hiresByContract: Record<string, number>
  activeUsers: number
  usersLoggedIn: number
  lastLoginAt: Date | null
  loginSuccess: number
  /**
   * Connexions refusées parce que le tenant est hors ligne. C'est le SEUL
   * compteur d'échec attribuable à une entreprise : l'API l'écrit dans le
   * schéma du tenant (identifiants valides → tenant connu). Les échecs
   * d'identifiants et les verrouillages, eux, sont écrits dans le schéma
   * `platform` (l'utilisateur n'est pas identifié, donc son tenant non plus)
   * et remontent dans `ReportData.platformAuth`, jamais ici.
   */
  blockedOffline: number
  mfaRequired: number
  auditWrites: number
  /** 'YYYY-MM-DD' → nombre de connexions réussies. */
  loginsByDay: Record<string, number>
}

export interface AgencyStats {
  agencyId: string
  name: string
  status: string
  tenantIds: string[]
  managedTenants: number
  headcount: number
  attached: number
  detached: number
}

/**
 * Échecs d'authentification de l'ENSEMBLE de la plateforme.
 *
 * Non attribuables à une entreprise : au moment d'un échec d'identifiants,
 * l'utilisateur n'est pas identifié, donc son tenant non plus — l'API écrit
 * donc ces lignes dans `platform.audit_log` (auth.routes.ts). Les présenter par
 * entreprise donnerait « 0 échec » partout, c'est-à-dire un faux signal
 * rassurant sur le seul indicateur de sécurité du rapport.
 */
export interface PlatformAuthStats {
  loginFailed: number
  loginLocked: number
}

/** Un point de la série d'évolution. `label` est la date de début de tranche. */
export interface TrendPoint {
  label: string
  hires: number
  logins: number
}

export interface ReportData {
  period: Period
  generatedAt: Date
  tenants: TenantStats[]
  agencies: AgencyStats[]
  /** Échecs de connexion, ensemble de la plateforme (jamais par entreprise). */
  platformAuth: PlatformAuthStats
  /** true = le parc dépasse le plafond de collecte ; le rapport est partiel. */
  truncated: boolean
  /** 12 dernières périodes, de la plus ancienne à la plus récente. */
  trend: TrendPoint[]
}
