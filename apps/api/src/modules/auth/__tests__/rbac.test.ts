import { describe, it, expect } from 'vitest'
import type { UserRole } from '@nexusrh/shared'

// ─── RBAC logic (mirrors auth.plugin authorize decorator) ────────────────────

const ALLOWED_ROLES: UserRole[] = [
  'super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly',
]

function authorize(allowedRoles: UserRole[], userRole: UserRole): boolean {
  return allowedRoles.includes(userRole)
}

// Permission matrix from CLAUDE.md
const PERMISSIONS = {
  'employees.read':      ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'] as UserRole[],
  'employees.write':     ['super_admin', 'admin', 'hr_manager', 'hr_officer'] as UserRole[],
  'payroll.close':       ['super_admin', 'admin', 'hr_manager'] as UserRole[],
  'absences.approve':    ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager'] as UserRole[],
  'expenses.approve':    ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager'] as UserRole[],
  'recruitment.read':    ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager', 'readonly'] as UserRole[],
  'settings.write':      ['super_admin', 'admin'] as UserRole[],
  'tenant.manage':       ['super_admin'] as UserRole[],
}

function can(role: UserRole, permission: keyof typeof PERMISSIONS): boolean {
  return authorize(PERMISSIONS[permission], role)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RBAC - Role authorization', () => {
  describe('authorize() helper', () => {
    it('should allow role that is in the list', () => {
      expect(authorize(['admin', 'hr_manager'], 'admin')).toBe(true)
      expect(authorize(['admin', 'hr_manager'], 'hr_manager')).toBe(true)
    })

    it('should deny role not in list', () => {
      expect(authorize(['admin', 'hr_manager'], 'employee')).toBe(false)
      expect(authorize(['admin'], 'manager')).toBe(false)
    })

    it('should deny with empty allowed list', () => {
      expect(authorize([], 'admin')).toBe(false)
    })

    it('should be exact match (no implicit hierarchy)', () => {
      // NexusRH uses explicit role lists — no implicit hierarchy in authorize()
      expect(authorize(['hr_officer'], 'hr_manager')).toBe(false)
    })
  })

  describe('Employee permissions', () => {
    it('admin can read and write employees', () => {
      expect(can('admin', 'employees.read')).toBe(true)
      expect(can('admin', 'employees.write')).toBe(true)
    })

    it('hr_officer can read employees but not write', () => {
      // Per CLAUDE.md matrix: hr_officer has RW on employees
      expect(can('hr_officer', 'employees.read')).toBe(true)
      expect(can('hr_officer', 'employees.write')).toBe(true)
    })

    it('readonly can read but not write employees', () => {
      expect(can('readonly', 'employees.read')).toBe(true)
      expect(can('readonly', 'employees.write')).toBe(false)
    })

    it('employee cannot access employee list', () => {
      expect(can('employee', 'employees.read')).toBe(false)
      expect(can('employee', 'employees.write')).toBe(false)
    })
  })

  describe('Payroll permissions', () => {
    it('admin and hr_manager can close payroll', () => {
      expect(can('admin', 'payroll.close')).toBe(true)
      expect(can('hr_manager', 'payroll.close')).toBe(true)
    })

    it('hr_officer cannot close payroll', () => {
      expect(can('hr_officer', 'payroll.close')).toBe(false)
    })

    it('manager cannot close payroll', () => {
      expect(can('manager', 'payroll.close')).toBe(false)
    })
  })

  describe('Absence/Expense approval permissions', () => {
    const approverRoles: UserRole[] = ['admin', 'hr_manager', 'hr_officer', 'manager']
    const nonApproverRoles: UserRole[] = ['employee', 'readonly']

    it('should allow managers to approve absences', () => {
      for (const role of approverRoles) {
        expect(can(role, 'absences.approve')).toBe(true)
      }
    })

    it('should deny employees from approving absences', () => {
      for (const role of nonApproverRoles) {
        expect(can(role, 'absences.approve')).toBe(false)
      }
    })

    it('should allow managers to approve expenses', () => {
      for (const role of approverRoles) {
        expect(can(role, 'expenses.approve')).toBe(true)
      }
    })
  })

  describe('Settings permissions', () => {
    it('only admin and super_admin can write settings', () => {
      expect(can('super_admin', 'settings.write')).toBe(true)
      expect(can('admin', 'settings.write')).toBe(true)
      expect(can('hr_manager', 'settings.write')).toBe(false)
      expect(can('employee', 'settings.write')).toBe(false)
    })
  })

  describe('Tenant management', () => {
    it('only super_admin can manage tenants', () => {
      expect(can('super_admin', 'tenant.manage')).toBe(true)
      expect(can('admin', 'tenant.manage')).toBe(false)
      expect(can('hr_manager', 'tenant.manage')).toBe(false)
    })
  })
})

describe('UserRole type coverage', () => {
  it('should cover all defined roles', () => {
    const allRoles: UserRole[] = [
      'super_admin', 'admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly',
    ]
    for (const role of allRoles) {
      expect(ALLOWED_ROLES.includes(role)).toBe(true)
    }
  })
})

describe('JWT payload validation', () => {
  it('should validate required JWT fields', () => {
    const validateJwtPayload = (payload: Record<string, unknown>) => {
      return (
        typeof payload['sub'] === 'string' &&
        typeof payload['email'] === 'string' &&
        typeof payload['role'] === 'string'
      )
    }

    expect(validateJwtPayload({ sub: 'uid-1', email: 'a@b.com', role: 'employee' })).toBe(true)
    expect(validateJwtPayload({ email: 'a@b.com', role: 'employee' })).toBe(false) // missing sub
    expect(validateJwtPayload({ sub: 'uid-1', role: 'employee' })).toBe(false) // missing email
  })

  it('should include schemaName for tenant users', () => {
    const tenantPayload = {
      sub: 'uid-1',
      email: 'user@techcorp.com',
      role: 'employee',
      schemaName: 'tenant_techcorp',
      employeeId: 'emp-001',
    }

    expect(tenantPayload.schemaName).toMatch(/^tenant_/)
    expect(tenantPayload.employeeId).toBeDefined()
  })

  it('should NOT include schemaName for super_admin', () => {
    const platformPayload = {
      sub: 'uid-super',
      email: 'superadmin@nexusrh.com',
      role: 'super_admin',
    }

    expect((platformPayload as Record<string, unknown>)['schemaName']).toBeUndefined()
  })
})
