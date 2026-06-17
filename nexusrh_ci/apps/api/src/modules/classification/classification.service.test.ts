import { describe, it, expect } from 'vitest'
import {
  LEVELS, LEVEL_KEYS, isValidLevel, roleCanAccess, roleCanExport, accessRequiresAudit,
  type LevelRule,
} from './classification.service.js'

const L4: LevelRule = { level: 4, allowedRoles: ['admin', 'hr_manager', 'hr_officer'], exportAllowed: false, encryptionRequired: true, auditRequired: true }
const L3: LevelRule = { level: 3, allowedRoles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'dg', 'readonly'], exportAllowed: true, encryptionRequired: true, auditRequired: true }
const L1: LevelRule = { level: 1, allowedRoles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg'], exportAllowed: true, encryptionRequired: false, auditRequired: false }

describe('classification.service — niveaux', () => {
  it('4 niveaux + clés', () => {
    expect(LEVELS).toEqual([1, 2, 3, 4])
    expect(LEVEL_KEYS[1]).toBe('public')
    expect(LEVEL_KEYS[4]).toBe('restricted')
    expect(isValidLevel(4)).toBe(true)
    expect(isValidLevel(5)).toBe(false)
    expect(isValidLevel(0)).toBe(false)
  })
})

describe('classification.service — contrôle d\'accès', () => {
  it('niveau 4 : RH habilités seulement, jamais manager/employee', () => {
    expect(roleCanAccess(L4, 'hr_manager')).toBe(true)
    expect(roleCanAccess(L4, 'manager')).toBe(false)
    expect(roleCanAccess(L4, 'employee')).toBe(false)
    expect(roleCanAccess(L4, 'readonly')).toBe(false)
  })
  it('super_admin n\'accède JAMAIS aux données RH', () => {
    expect(roleCanAccess(L1, 'super_admin')).toBe(false)
    expect(roleCanAccess(L4, 'super_admin')).toBe(false)
  })
  it('export : niveau 4 interdit même pour RH ; niveau 3 autorisé si accès', () => {
    expect(roleCanExport(L4, 'hr_manager')).toBe(false) // export_allowed=false
    expect(roleCanExport(L3, 'hr_manager')).toBe(true)
    expect(roleCanExport(L3, 'employee')).toBe(false)   // pas d'accès niveau 3
  })
  it('audit requis sur niveaux sensibles (3 et 4)', () => {
    expect(accessRequiresAudit(L4)).toBe(true)
    expect(accessRequiresAudit(L3)).toBe(true)
    expect(accessRequiresAudit(L1)).toBe(false)
    expect(accessRequiresAudit(undefined)).toBe(false)
  })
  it('règle absente → aucun accès', () => {
    expect(roleCanAccess(undefined, 'admin')).toBe(false)
  })
})
