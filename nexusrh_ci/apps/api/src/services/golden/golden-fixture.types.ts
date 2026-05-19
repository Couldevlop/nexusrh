import type { PayrollContext, PayrollResult } from '../payroll-engine-ci.js'

export interface GoldenFixtureExpectedLine {
  code: string
  type: 'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution'
  amount: number
}

export interface GoldenFixtureExpectedBordereau {
  motif: 'maternite' | 'accident_travail'
  montant: number
}

export interface GoldenFixtureExpected {
  baseSalary: number
  brutProrata: number
  grossSalary: number
  cnpsRetraiteSal: number
  cnpsRetraitePat: number
  cnpsPfPat: number
  cnpsAtPat: number
  totalCnpsSal: number
  totalCnpsPat: number
  baseImposable: number
  its: number
  totalDeductions: number
  netPayable: number
  employerCost: number
  workingDays: number
  smigCompliant: boolean
  indemniteAbsence?: number
  bordereauCnps?: GoldenFixtureExpectedBordereau
  lines: GoldenFixtureExpectedLine[]
}

export interface GoldenFixtureMetadata {
  pack: string
  category: 'cadre' | 'non-cadre' | 'mandataire' | 'apprenti' | 'stagiaire'
  period: string
  createdAt: string
  validatedBy: string
  changelog: Array<{
    date: string
    author: string
    reason: string
    deltaSummary?: string
  }>
}

export interface GoldenFixture {
  id: string
  description: string
  metadata: GoldenFixtureMetadata
  input: PayrollContext
  expected: GoldenFixtureExpected
}

export type GoldenComparisonResult = PayrollResult
