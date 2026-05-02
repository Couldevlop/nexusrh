/**
 * Relations definitions for Drizzle relational query API.
 * These register all tables so they appear in db.query.* with proper TypeScript types.
 */
import { relations } from 'drizzle-orm'
import { users, refreshTokens, auditLog } from './auth'
import { employees, departments, legalEntities, hrEvents, employeeDocuments } from './employees'
import { contracts, payrollRules, payPeriods, paySlips, variableElements } from './payroll'
import { absenceTypes, absenceBalances, absences } from './absences'
import { expenseReports, expenseLines } from './expenses'
import { skills, employeeSkills, evaluations, developmentPlans, careerPaths, nineBox } from './careers'

// ── Auth ──────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
}))

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}))

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}))

// ── Employees ─────────────────────────────────────────────────────────────────

export const legalEntitiesRelations = relations(legalEntities, ({ many }) => ({
  employees: many(employees),
  departments: many(departments),
}))

export const departmentsRelations = relations(departments, ({ one, many }) => ({
  entity: one(legalEntities, { fields: [departments.entityId], references: [legalEntities.id] }),
  employees: many(employees),
}))

export const employeesRelations = relations(employees, ({ one, many }) => ({
  entity: one(legalEntities, { fields: [employees.entityId], references: [legalEntities.id] }),
  department: one(departments, { fields: [employees.departmentId], references: [departments.id] }),
  contracts: many(contracts),
  absences: many(absences),
  absenceBalances: many(absenceBalances),
  expenseReports: many(expenseReports),
  evaluations: many(evaluations),
  developmentPlans: many(developmentPlans),
  hrEvents: many(hrEvents),
  employeeDocuments: many(employeeDocuments),
}))

export const hrEventsRelations = relations(hrEvents, ({ one }) => ({
  employee: one(employees, { fields: [hrEvents.employeeId], references: [employees.id] }),
}))

export const employeeDocumentsRelations = relations(employeeDocuments, ({ one }) => ({
  employee: one(employees, { fields: [employeeDocuments.employeeId], references: [employees.id] }),
}))

// ── Payroll ───────────────────────────────────────────────────────────────────

export const contractsRelations = relations(contracts, ({ one }) => ({
  employee: one(employees, { fields: [contracts.employeeId], references: [employees.id] }),
}))

export const payPeriodsRelations = relations(payPeriods, ({ one, many }) => ({
  entity: one(legalEntities, { fields: [payPeriods.entityId], references: [legalEntities.id] }),
  paySlips: many(paySlips),
}))

export const paySlipsRelations = relations(paySlips, ({ one }) => ({
  employee: one(employees, { fields: [paySlips.employeeId], references: [employees.id] }),
  period: one(payPeriods, { fields: [paySlips.periodId], references: [payPeriods.id] }),
}))

export const payrollRulesRelations = relations(payrollRules, ({ one }) => ({
  entity: one(legalEntities, { fields: [payrollRules.entityId], references: [legalEntities.id] }),
}))

export const variableElementsRelations = relations(variableElements, ({ one }) => ({
  employee: one(employees, { fields: [variableElements.employeeId], references: [employees.id] }),
}))

// ── Absences ──────────────────────────────────────────────────────────────────

export const absenceTypesRelations = relations(absenceTypes, ({ many }) => ({
  absences: many(absences),
  absenceBalances: many(absenceBalances),
}))

export const absenceBalancesRelations = relations(absenceBalances, ({ one }) => ({
  employee: one(employees, { fields: [absenceBalances.employeeId], references: [employees.id] }),
  absenceType: one(absenceTypes, { fields: [absenceBalances.absenceTypeId], references: [absenceTypes.id] }),
}))

export const absencesRelations = relations(absences, ({ one }) => ({
  employee: one(employees, { fields: [absences.employeeId], references: [employees.id] }),
  absenceType: one(absenceTypes, { fields: [absences.absenceTypeId], references: [absenceTypes.id] }),
}))

// ── Expenses ──────────────────────────────────────────────────────────────────

export const expenseReportsRelations = relations(expenseReports, ({ one, many }) => ({
  employee: one(employees, { fields: [expenseReports.employeeId], references: [employees.id] }),
  lines: many(expenseLines),
}))

export const expenseLinesRelations = relations(expenseLines, ({ one }) => ({
  report: one(expenseReports, { fields: [expenseLines.reportId], references: [expenseReports.id] }),
}))

// ── Careers ───────────────────────────────────────────────────────────────────

export const skillsRelations = relations(skills, ({ one, many }) => ({
  entity: one(legalEntities, { fields: [skills.entityId], references: [legalEntities.id] }),
  employeeSkills: many(employeeSkills),
}))

export const employeeSkillsRelations = relations(employeeSkills, ({ one }) => ({
  employee: one(employees, { fields: [employeeSkills.employeeId], references: [employees.id] }),
  skill: one(skills, { fields: [employeeSkills.skillId], references: [skills.id] }),
}))

export const evaluationsRelations = relations(evaluations, ({ one }) => ({
  employee: one(employees, { fields: [evaluations.employeeId], references: [employees.id] }),
}))

export const developmentPlansRelations = relations(developmentPlans, ({ one }) => ({
  employee: one(employees, { fields: [developmentPlans.employeeId], references: [employees.id] }),
}))

export const careerPathsRelations = relations(careerPaths, ({ one }) => ({
  employee: one(employees, { fields: [careerPaths.employeeId], references: [employees.id] }),
}))

export const nineBoxRelations = relations(nineBox, ({ one }) => ({
  employee: one(employees, { fields: [nineBox.employeeId], references: [employees.id] }),
}))
