import { describe, it, expect } from 'vitest'

// ─── Workflow config validation (mirrors settings.routes.ts) ─────────────────

const VALID_MODULES = ['absences', 'expenses'] as const
type WorkflowModule = typeof VALID_MODULES[number]

interface WorkflowConfig {
  module: WorkflowModule
  levelsCount: number
  level1Role?: string
  level2Role?: string
  level3Role?: string
  level4Role?: string
}

const VALID_ROLES = ['manager', 'hr_officer', 'hr_manager', 'admin'] as const
type WorkflowRole = typeof VALID_ROLES[number]

function validateWorkflowConfig(input: Record<string, unknown>): { valid: boolean; error?: string } {
  const { module, levelsCount, level1Role, level2Role, level3Role, level4Role } = input

  if (!VALID_MODULES.includes(module as WorkflowModule)) {
    return { valid: false, error: `Module invalide: ${String(module)}` }
  }

  const count = Number(levelsCount)
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    return { valid: false, error: 'levelsCount doit être entre 1 et 4' }
  }

  // Each active level must have a role
  const levelRoles = [level1Role, level2Role, level3Role, level4Role]
  for (let i = 0; i < count; i++) {
    const role = levelRoles[i]
    if (role && !VALID_ROLES.includes(role as WorkflowRole)) {
      return { valid: false, error: `Rôle invalide pour le niveau ${i + 1}: ${String(role)}` }
    }
  }

  return { valid: true }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Workflow configuration validation', () => {
  describe('Module validation', () => {
    it('should accept absences module', () => {
      const result = validateWorkflowConfig({ module: 'absences', levelsCount: 1 })
      expect(result.valid).toBe(true)
    })

    it('should accept expenses module', () => {
      const result = validateWorkflowConfig({ module: 'expenses', levelsCount: 1 })
      expect(result.valid).toBe(true)
    })

    it('should reject unknown modules', () => {
      const result = validateWorkflowConfig({ module: 'payroll', levelsCount: 1 })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Module invalide')
    })

    it('should reject empty module', () => {
      const result = validateWorkflowConfig({ module: '', levelsCount: 1 })
      expect(result.valid).toBe(false)
    })
  })

  describe('Levels count validation', () => {
    it('should accept 1 level', () => {
      expect(validateWorkflowConfig({ module: 'absences', levelsCount: 1 }).valid).toBe(true)
    })

    it('should accept 2 levels', () => {
      expect(validateWorkflowConfig({ module: 'absences', levelsCount: 2 }).valid).toBe(true)
    })

    it('should accept 3 levels', () => {
      expect(validateWorkflowConfig({ module: 'absences', levelsCount: 3 }).valid).toBe(true)
    })

    it('should accept 4 levels (maximum)', () => {
      expect(validateWorkflowConfig({ module: 'absences', levelsCount: 4 }).valid).toBe(true)
    })

    it('should reject 0 levels', () => {
      const result = validateWorkflowConfig({ module: 'absences', levelsCount: 0 })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('entre 1 et 4')
    })

    it('should reject 5 levels (above maximum)', () => {
      const result = validateWorkflowConfig({ module: 'absences', levelsCount: 5 })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('entre 1 et 4')
    })

    it('should reject non-integer levels', () => {
      const result = validateWorkflowConfig({ module: 'absences', levelsCount: 1.5 })
      expect(result.valid).toBe(false)
    })

    it('should reject string count', () => {
      const result = validateWorkflowConfig({ module: 'absences', levelsCount: 'deux' })
      expect(result.valid).toBe(false)
    })
  })

  describe('Role validation', () => {
    it('should accept valid roles for each level', () => {
      const result = validateWorkflowConfig({
        module: 'absences',
        levelsCount: 3,
        level1Role: 'manager',
        level2Role: 'hr_manager',
        level3Role: 'admin',
      })
      expect(result.valid).toBe(true)
    })

    it('should reject invalid role name', () => {
      const result = validateWorkflowConfig({
        module: 'absences',
        levelsCount: 2,
        level1Role: 'manager',
        level2Role: 'ceo', // not a valid workflow role
      })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Rôle invalide')
    })
  })

  describe('Default config', () => {
    it('should have sensible defaults for new tenants', () => {
      const defaultConfig: WorkflowConfig = {
        module: 'absences',
        levelsCount: 1,
        level1Role: 'manager',
      }

      expect(defaultConfig.levelsCount).toBe(1)
      expect(defaultConfig.level1Role).toBe('manager')
      expect(defaultConfig.level2Role).toBeUndefined()
    })
  })
})

describe('Workflow approval state machine', () => {
  interface AbsenceState { validationLevel: number; status: string }

  function applyApproval(
    state: AbsenceState,
    levelsCount: number,
    module: 'absences' | 'expenses'
  ): AbsenceState & { message: string; fullyApproved: boolean } {
    if (state.status === 'approved') throw new Error('Already approved')
    if (state.status === 'rejected') throw new Error('Already rejected')

    const nextLevel = state.validationLevel + 1
    const isFullyApproved = nextLevel >= levelsCount
    const pendingStatus = module === 'expenses' ? 'submitted' : 'pending'

    return {
      validationLevel: nextLevel,
      status: isFullyApproved ? 'approved' : pendingStatus,
      fullyApproved: isFullyApproved,
      message: isFullyApproved
        ? 'Approuvé définitivement'
        : `Niveau ${nextLevel}/${levelsCount} validé`,
    }
  }

  it('should complete 1-level absence workflow', () => {
    const state: AbsenceState = { validationLevel: 0, status: 'pending' }
    const result = applyApproval(state, 1, 'absences')
    expect(result.status).toBe('approved')
    expect(result.fullyApproved).toBe(true)
    expect(result.message).toBe('Approuvé définitivement')
  })

  it('should complete 2-level absence workflow in 2 steps', () => {
    let state: AbsenceState = { validationLevel: 0, status: 'pending' }

    const step1 = applyApproval(state, 2, 'absences')
    expect(step1.status).toBe('pending')
    expect(step1.fullyApproved).toBe(false)
    expect(step1.message).toContain('1/2')

    state = { validationLevel: step1.validationLevel, status: step1.status }
    const step2 = applyApproval(state, 2, 'absences')
    expect(step2.status).toBe('approved')
    expect(step2.fullyApproved).toBe(true)
  })

  it('should use "submitted" intermediate status for expenses', () => {
    const state: AbsenceState = { validationLevel: 0, status: 'submitted' }
    const result = applyApproval(state, 2, 'expenses')
    expect(result.status).toBe('submitted') // not 'pending'
    expect(result.fullyApproved).toBe(false)
  })

  it('should throw when trying to approve already-approved record', () => {
    const state: AbsenceState = { validationLevel: 2, status: 'approved' }
    expect(() => applyApproval(state, 2, 'absences')).toThrow('Already approved')
  })

  it('should throw when trying to approve rejected record', () => {
    const state: AbsenceState = { validationLevel: 0, status: 'rejected' }
    expect(() => applyApproval(state, 2, 'absences')).toThrow('Already rejected')
  })

  it('should format message correctly for 4-level workflow', () => {
    const state: AbsenceState = { validationLevel: 2, status: 'pending' }
    const result = applyApproval(state, 4, 'absences')
    expect(result.message).toBe('Niveau 3/4 validé')
    expect(result.fullyApproved).toBe(false)
  })
})
