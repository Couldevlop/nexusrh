import type { PayrollRule, Employee, Contract } from '@nexusrh/shared'

export interface PaySlipLine {
  ruleCode: string
  label: string
  base: number
  quantity?: number
  employeeRate?: number
  employerRate?: number
  employeeAmount: number
  employerAmount: number
  type: 'earning' | 'deduction' | 'employer_contribution' | 'employee_contribution' | 'info'
}

export interface PaySlipResult {
  lines: PaySlipLine[]
  grossSalary: number
  netBeforeTax: number
  incomeTax: number
  netPayable: number
  employerCost: number
  workingDays: number
}

export interface PayrollContext {
  employee: Employee
  contract: Contract
  period: { year: number; month: number }
  variableElements: Array<{
    ruleCode: string
    amount?: string | null
    quantity?: string | null
    rate?: string | null
  }>
  rules: PayrollRule[]
  absenceDays?: number
  sickDays?: number
  overtimeHours?: number
}

const LEGAL_CONSTANTS_2024 = {
  SMIC_MONTHLY: 1766.92,
  SS_CEILING_MONTHLY: 3864,
  SS_CEILING_DAILY: 185,
  TRANSPORT_EXEMPTION_RATE: 0.5,
  MEAL_VOUCHER_EXEMPTION_MAX: 6.91,
}

export class PayrollEngine {
  calculate(ctx: PayrollContext): PaySlipResult {
    const vars = this.buildVariables(ctx)
    const lines: PaySlipLine[] = []

    const activeRules = ctx.rules
      .filter((r) => r.isActive && this.ruleApplies(r, ctx))
      .sort((a, b) => a.order - b.order)

    for (const rule of activeRules) {
      const line = this.evaluateRule(rule, vars)
      if (
        line &&
        (Math.abs(line.employeeAmount) > 0.001 ||
          Math.abs(line.employerAmount) > 0.001)
      ) {
        lines.push(line)
        vars[rule.code] = Math.abs(line.employeeAmount)
        vars[`EMP_${rule.code}`] = line.employerAmount
      }
    }

    return this.computeTotals(lines, ctx)
  }

  private buildVariables(
    ctx: PayrollContext
  ): Record<string, number> {
    const gross = Number(ctx.contract.grossSalary)
    const etp =
      Number(ctx.contract.workingHoursPerWeek ?? 35) / 35

    const workingDays = this.workingDaysInMonth(
      ctx.period.year,
      ctx.period.month
    )
    const absenceFraction = ctx.absenceDays
      ? 1 - ctx.absenceDays / workingDays
      : 1

    return {
      BRUT: gross,
      BRUT_PRORATA: Math.round(gross * absenceFraction * 100) / 100,
      ETP: etp,
      PLAFOND_SS: Math.round(LEGAL_CONSTANTS_2024.SS_CEILING_MONTHLY * etp * 100) / 100,
      TRANCHE_A: Math.min(gross, LEGAL_CONSTANTS_2024.SS_CEILING_MONTHLY * etp),
      TRANCHE_B: Math.max(
        0,
        Math.min(
          gross,
          LEGAL_CONSTANTS_2024.SS_CEILING_MONTHLY * 4 * etp
        ) - LEGAL_CONSTANTS_2024.SS_CEILING_MONTHLY * etp
      ),
      SMIC: Math.round(LEGAL_CONSTANTS_2024.SMIC_MONTHLY * etp * 100) / 100,
      ...this.expandVariableElements(ctx.variableElements),
      JOURS_ABSENCE: ctx.absenceDays ?? 0,
      JOURS_MALADIE: ctx.sickDays ?? 0,
      HEURES_SUPP: ctx.overtimeHours ?? 0,
    }
  }

  private expandVariableElements(
    elements: PayrollContext['variableElements']
  ): Record<string, number> {
    const result: Record<string, number> = {}
    for (const el of elements) {
      const amount = el.amount
        ? Number(el.amount)
        : Number(el.quantity ?? 0) * Number(el.rate ?? 1)
      result[el.ruleCode] = (result[el.ruleCode] ?? 0) + amount
    }
    return result
  }

  private evaluateRule(
    rule: PayrollRule,
    vars: Record<string, number>
  ): PaySlipLine | null {
    try {
      const base = rule.base
        ? this.safeEval(rule.base, vars)
        : (vars['BRUT'] ?? 0)

      const appliedBase =
        rule.ceilingSS
          ? Math.min(
              base,
              LEGAL_CONSTANTS_2024.SS_CEILING_MONTHLY * Number(rule.ceilingSS)
            )
          : base

      let employeeAmount: number
      let employerAmount: number

      if (rule.formula.startsWith('VAR:')) {
        const varName = rule.formula.slice(4)
        employeeAmount = vars[varName] ?? 0
        employerAmount = 0
      } else {
        employeeAmount = this.safeEval(rule.formula, {
          ...vars,
          BASE: appliedBase,
        })
        employerAmount = rule.employerRate
          ? Math.round(appliedBase * Number(rule.employerRate) * 100) / 100
          : 0
      }

      const isNegative =
        rule.type === 'deduction' || rule.type === 'employee_contribution'
      const finalEmployeeAmount = isNegative
        ? -Math.abs(employeeAmount)
        : employeeAmount

      return {
        ruleCode: rule.code,
        label: rule.label,
        base: appliedBase,
        employeeRate: rule.employeeRate
          ? Number(rule.employeeRate)
          : undefined,
        employerRate: rule.employerRate
          ? Number(rule.employerRate)
          : undefined,
        employeeAmount: Math.round(finalEmployeeAmount * 100) / 100,
        employerAmount: Math.round(employerAmount * 100) / 100,
        type: rule.type as PaySlipLine['type'],
      }
    } catch {
      return null
    }
  }

  private safeEval(
    expr: string,
    vars: Record<string, number>
  ): number {
    const sanitized = expr.trim()
    if (!/^[A-Z0-9_\s+\-*/.()\[\]]+$/.test(sanitized)) return 0
    try {
      const keys = Object.keys(vars)
      const values = Object.values(vars)
      // eslint-disable-next-line no-new-func
      const fn = new Function(...keys, `'use strict'; return (${sanitized})`)
      const result = fn(...values) as unknown
      return typeof result === 'number' && isFinite(result)
        ? Math.round(result * 100) / 100
        : 0
    } catch {
      return 0
    }
  }

  private ruleApplies(rule: PayrollRule, ctx: PayrollContext): boolean {
    const applies = rule.appliesTo as {
      profileTypes?: string[]
      departments?: string[]
    } | null

    if (!applies || Object.keys(applies).length === 0) return true
    if (
      applies.profileTypes?.length &&
      !applies.profileTypes.includes(ctx.employee.profileType)
    )
      return false
    if (
      applies.departments?.length &&
      ctx.employee.departmentId &&
      !applies.departments.includes(ctx.employee.departmentId)
    )
      return false
    return true
  }

  private computeTotals(
    lines: PaySlipLine[],
    ctx: PayrollContext
  ): PaySlipResult {
    const grossSalary = lines
      .filter((l) => l.type === 'earning')
      .reduce((s, l) => s + l.employeeAmount, 0)

    const employeeContributions = lines
      .filter(
        (l) =>
          l.type === 'employee_contribution' || l.type === 'deduction'
      )
      .reduce((s, l) => s + l.employeeAmount, 0)

    const netBeforeTax =
      Math.round((grossSalary + employeeContributions) * 100) / 100

    const employerCost =
      grossSalary +
      lines.reduce((s, l) => s + l.employerAmount, 0)

    const workingDays =
      this.workingDaysInMonth(ctx.period.year, ctx.period.month) -
      (ctx.absenceDays ?? 0)

    return {
      lines,
      grossSalary: Math.round(grossSalary * 100) / 100,
      netBeforeTax,
      incomeTax: 0,
      netPayable: netBeforeTax,
      employerCost: Math.round(employerCost * 100) / 100,
      workingDays,
    }
  }

  workingDaysInMonth(year: number, month: number): number {
    const daysInMonth = new Date(year, month, 0).getDate()
    let workDays = 0
    for (let d = 1; d <= daysInMonth; d++) {
      const day = new Date(year, month - 1, d).getDay()
      if (day !== 0 && day !== 6) workDays++
    }
    return workDays
  }
}

export const payrollEngine = new PayrollEngine()
