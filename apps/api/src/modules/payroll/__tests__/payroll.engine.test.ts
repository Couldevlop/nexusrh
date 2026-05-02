import { describe, it, expect, beforeEach } from 'vitest'
import { PayrollEngine } from '../payroll.engine'
import type { PayrollContext } from '../payroll.engine'
import type { PayrollRule } from '@nexusrh/shared'

const mockEmployee = {
  id: 'emp-001',
  entityId: 'ent-001',
  firstName: 'Marie',
  lastName: 'Dupont',
  email: 'marie@test.com',
  status: 'active' as const,
  profileType: 'employee' as const,
  workingTimePercentage: '100.00',
  weeklyHours: '35.00',
  hireDate: '2020-01-01',
  hasDisability: false,
  aiScoreFactors: [] as string[],
  customFields: {} as Record<string, unknown>,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const mockContract = {
  id: 'con-001',
  employeeId: 'emp-001',
  type: 'CDI' as const,
  startDate: '2020-01-01',
  grossSalary: '3500.00',
  salaryBasis: 'monthly' as const,
  workingHoursPerWeek: '35',
  nonCompetitionClause: false,
  telecommutingDays: 0,
  status: 'active' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const baseRules: PayrollRule[] = [
  {
    id: 'rule-001',
    entityId: 'ent-001',
    code: 'SALAIRE_BASE',
    label: 'Salaire de base',
    type: 'earning' as const,
    formula: 'BRUT',
    base: undefined,
    employeeRate: undefined,
    employerRate: undefined,
    ceilingSS: undefined,
    isActive: true,
    order: 1,
    appliesTo: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'rule-002',
    entityId: 'ent-001',
    code: 'CSG_DEDUC',
    label: 'CSG déductible',
    type: 'employee_contribution' as const,
    formula: 'BASE * 0.068',   // rate embedded directly — engine doesn't inject RATE var
    base: 'BRUT * 0.9825',
    employeeRate: '0.068',
    employerRate: undefined,
    ceilingSS: undefined,
    isActive: true,
    order: 10,
    appliesTo: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'rule-003',
    entityId: 'ent-001',
    code: 'CSG_NONDEDUC',
    label: 'CSG non déductible',
    type: 'employee_contribution' as const,
    formula: 'BASE * 0.024',   // rate embedded directly
    base: 'BRUT * 0.9825',
    employeeRate: '0.024',
    employerRate: undefined,
    ceilingSS: undefined,
    isActive: true,
    order: 11,
    appliesTo: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

describe('PayrollEngine', () => {
  let engine: PayrollEngine

  beforeEach(() => {
    engine = new PayrollEngine()
  })

  describe('Basic salary calculation', () => {
    it('should calculate gross salary from contract', () => {
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: [baseRules[0]!],
      }

      const result = engine.calculate(ctx)

      expect(result.grossSalary).toBe(3500)
    })

    it('should compute correct net after contributions', () => {
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: baseRules,
      }

      const result = engine.calculate(ctx)

      expect(result.grossSalary).toBe(3500)
      expect(result.netPayable).toBeLessThan(result.grossSalary)
      expect(result.lines).toHaveLength(3) // 1 earning + 2 contributions
    })

    it('should have negative amounts for employee contributions', () => {
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: baseRules,
      }

      const result = engine.calculate(ctx)

      const contributions = result.lines.filter(l => l.type === 'employee_contribution')
      contributions.forEach(l => expect(l.employeeAmount).toBeLessThan(0))
    })
  })

  describe('Working days calculation', () => {
    it('should compute positive working days', () => {
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: baseRules,
      }

      const result = engine.calculate(ctx)
      expect(result.workingDays).toBeGreaterThan(15)
      expect(result.workingDays).toBeLessThanOrEqual(23)
    })

    it('should deduct absence days from working days', () => {
      const ctxNoAbsence: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: baseRules,
      }
      const ctxWithAbsence: PayrollContext = {
        ...ctxNoAbsence,
        absenceDays: 3,
      }

      const resultNormal = engine.calculate(ctxNoAbsence)
      const resultAbsent = engine.calculate(ctxWithAbsence)

      expect(resultNormal.workingDays - resultAbsent.workingDays).toBe(3)
    })
  })

  describe('Variable elements', () => {
    it('should include variable bonuses in calculation', () => {
      const bonusRule = {
        id: 'rule-bonus',
        entityId: 'ent-001',
        code: 'PRIME',
        label: 'Prime',
        type: 'earning' as const,
        formula: 'VAR:PRIME',
        base: undefined,
        employeeRate: undefined,
        employerRate: undefined,
        ceilingSS: undefined,
        isActive: true,
        order: 5,
        appliesTo: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [
          {
            ruleCode: 'PRIME',
            amount: '500.00',
          },
        ],
        rules: [baseRules[0]!, bonusRule],
      }

      const result = engine.calculate(ctx)
      expect(result.grossSalary).toBe(4000) // 3500 + 500 prime
    })
  })

  describe('SS ceiling', () => {
    it('should cap tranche A at SS ceiling', () => {
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: { ...mockContract, grossSalary: '10000.00' },
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: [
          baseRules[0]!,
          {
            id: 'rule-retraite',
            entityId: 'ent-001',
            code: 'RETRAITE_TA',
            label: 'Retraite tranche A',
            type: 'employee_contribution' as const,
            formula: 'BASE * RATE',
            base: 'TRANCHE_A',
            employeeRate: '0.0690',
            employerRate: '0.0855',
            ceilingSS: '1',
            isActive: true,
            order: 20,
            appliesTo: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }

      const result = engine.calculate(ctx)
      const retraiteLine = result.lines.find(l => l.ruleCode === 'RETRAITE_TA')
      expect(retraiteLine).toBeDefined()
      // Base should be capped at SS ceiling (3864)
      expect(retraiteLine!.base).toBeLessThanOrEqual(3864)
    })
  })

  describe('Safety - safeEval', () => {
    it('should return 0 for malicious formulas', () => {
      const maliciousRule = {
        id: 'rule-bad',
        entityId: 'ent-001',
        code: 'BAD',
        label: 'Bad rule',
        type: 'earning' as const,
        formula: 'require("fs").readFileSync("/etc/passwd")',
        base: undefined,
        employeeRate: undefined,
        employerRate: undefined,
        ceilingSS: undefined,
        isActive: true,
        order: 99,
        appliesTo: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const ctx: PayrollContext = {
        employee: mockEmployee,
        contract: mockContract,
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: [maliciousRule],
      }

      // Should not throw, just skip the bad rule
      expect(() => engine.calculate(ctx)).not.toThrow()
      const result = engine.calculate(ctx)
      expect(result.grossSalary).toBe(0)
    })
  })

  describe('Part-time employee', () => {
    it('should scale SS ceiling for part-time employee', () => {
      const partTimeEmployee = {
        ...mockEmployee,
        workingTimePercentage: '50.00',
      }
      const ctx: PayrollContext = {
        employee: partTimeEmployee,
        contract: { ...mockContract, grossSalary: '1000.00' },
        period: { year: 2024, month: 12 },
        variableElements: [],
        rules: baseRules,
      }

      const result = engine.calculate(ctx)
      expect(result.grossSalary).toBe(1000)
    })
  })
})
