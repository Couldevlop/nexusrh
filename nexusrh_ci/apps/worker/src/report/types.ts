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
  loginFailed: number
  loginLocked: number
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

export interface ReportData {
  period: Period
  generatedAt: Date
  tenants: TenantStats[]
  agencies: AgencyStats[]
}
