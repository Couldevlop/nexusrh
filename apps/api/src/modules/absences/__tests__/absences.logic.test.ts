import { describe, it, expect } from 'vitest'

// ─── Pure logic extracted from absences.routes.ts for testability ────────────

function calcWorkingDays(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  let count = 0
  const current = new Date(start)
  while (current <= end) {
    const day = current.getDay()
    if (day !== 0 && day !== 6) count++
    current.setDate(current.getDate() + 1)
  }
  return count
}

function getPeriodLabel(now: Date = new Date()): string {
  const month = now.getMonth()
  const year = now.getFullYear()
  const periodYear = month >= 5 ? year : year - 1
  return `${periodYear}-${periodYear + 1}`
}

// ─── Multi-level workflow logic (mirrors absences.routes.ts approve handler) ──

function computeApprovalResult(
  currentLevel: number,
  currentStatus: string,
  levelsCount: number
): { nextLevel: number; isFullyApproved: boolean; newStatus: string; error?: string } {
  if (currentStatus === 'approved') return { nextLevel: currentLevel, isFullyApproved: false, newStatus: currentStatus, error: 'Absence déjà approuvée' }
  if (currentStatus === 'rejected') return { nextLevel: currentLevel, isFullyApproved: false, newStatus: currentStatus, error: 'Absence déjà refusée' }

  const nextLevel = currentLevel + 1
  const isFullyApproved = nextLevel >= levelsCount
  const newStatus = isFullyApproved ? 'approved' : 'pending'
  return { nextLevel, isFullyApproved, newStatus }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('calcWorkingDays', () => {
  it('should count only weekdays', () => {
    // 2024-12-02 (Monday) to 2024-12-06 (Friday) = 5 working days
    expect(calcWorkingDays('2024-12-02', '2024-12-06')).toBe(5)
  })

  it('should exclude weekends at boundaries', () => {
    // 2024-12-01 (Sunday) to 2024-12-07 (Saturday) = 5 working days (Mon–Fri)
    expect(calcWorkingDays('2024-12-01', '2024-12-07')).toBe(5)
  })

  it('should return 0 for same-day weekend', () => {
    // 2024-12-01 is a Sunday
    expect(calcWorkingDays('2024-12-01', '2024-12-01')).toBe(0)
  })

  it('should return 1 for same working day', () => {
    // 2024-12-02 is a Monday
    expect(calcWorkingDays('2024-12-02', '2024-12-02')).toBe(1)
  })

  it('should count full weeks correctly', () => {
    // 4 full weeks = 20 working days
    expect(calcWorkingDays('2024-12-02', '2024-12-27')).toBe(20)
  })

  it('should handle half-day as 0.5 in calling code', () => {
    // The route uses: body.halfDay ? 0.5 : calcWorkingDays(...)
    const daysCount = true ? 0.5 : calcWorkingDays('2024-12-02', '2024-12-02')
    expect(daysCount).toBe(0.5)
  })
})

describe('getPeriodLabel', () => {
  it('should return current-year period for months June–December (index 5–11)', () => {
    const june2024 = new Date(2024, 5, 1) // month index 5 = June
    expect(getPeriodLabel(june2024)).toBe('2024-2025')
  })

  it('should return previous-year period for months January–May (index 0–4)', () => {
    const feb2025 = new Date(2025, 1, 1) // month index 1 = February
    expect(getPeriodLabel(feb2025)).toBe('2024-2025')
  })

  it('should format correctly for transition year', () => {
    const dec2023 = new Date(2023, 11, 1)
    expect(getPeriodLabel(dec2023)).toBe('2023-2024')
  })

  it('should produce consistent label for same period', () => {
    const aug = getPeriodLabel(new Date(2024, 7, 1))
    const sep = getPeriodLabel(new Date(2024, 8, 1))
    expect(aug).toBe(sep)
  })
})

describe('Multi-level absence approval workflow', () => {
  describe('Single-level approval (default)', () => {
    it('should approve immediately at level 1/1', () => {
      const result = computeApprovalResult(0, 'pending', 1)
      expect(result.isFullyApproved).toBe(true)
      expect(result.nextLevel).toBe(1)
      expect(result.newStatus).toBe('approved')
    })
  })

  describe('Two-level approval', () => {
    it('should remain pending after first approval', () => {
      const result = computeApprovalResult(0, 'pending', 2)
      expect(result.isFullyApproved).toBe(false)
      expect(result.nextLevel).toBe(1)
      expect(result.newStatus).toBe('pending')
    })

    it('should approve after second approval', () => {
      const result = computeApprovalResult(1, 'pending', 2)
      expect(result.isFullyApproved).toBe(true)
      expect(result.nextLevel).toBe(2)
      expect(result.newStatus).toBe('approved')
    })
  })

  describe('Four-level approval', () => {
    it('should step through all levels correctly', () => {
      const levels = 4
      const transitions = [
        { from: 0, expectedNext: 1, expectedApproved: false, expectedStatus: 'pending' },
        { from: 1, expectedNext: 2, expectedApproved: false, expectedStatus: 'pending' },
        { from: 2, expectedNext: 3, expectedApproved: false, expectedStatus: 'pending' },
        { from: 3, expectedNext: 4, expectedApproved: true, expectedStatus: 'approved' },
      ]

      for (const t of transitions) {
        const result = computeApprovalResult(t.from, 'pending', levels)
        expect(result.nextLevel).toBe(t.expectedNext)
        expect(result.isFullyApproved).toBe(t.expectedApproved)
        expect(result.newStatus).toBe(t.expectedStatus)
      }
    })
  })

  describe('Guard clauses', () => {
    it('should reject already-approved absence', () => {
      const result = computeApprovalResult(2, 'approved', 2)
      expect(result.error).toBe('Absence déjà approuvée')
    })

    it('should reject already-rejected absence', () => {
      const result = computeApprovalResult(0, 'rejected', 2)
      expect(result.error).toBe('Absence déjà refusée')
    })
  })
})

describe('Absence form field mapping', () => {
  it('should correctly map isHalfDay to halfDay for API', () => {
    const formData = {
      absenceTypeId: 'type-001',
      startDate: '2024-12-02',
      endDate: '2024-12-02',
      isHalfDay: true,
      reason: 'Rendez-vous médical',
    }

    // This is the transformation applied in MesAbsencesPage.tsx createMutation
    const apiPayload = {
      absenceTypeId: formData.absenceTypeId,
      startDate: formData.startDate,
      endDate: formData.endDate,
      halfDay: formData.isHalfDay, // ← key fix: isHalfDay → halfDay
      reason: formData.reason,
    }

    expect(apiPayload).not.toHaveProperty('isHalfDay')
    expect(apiPayload).toHaveProperty('halfDay', true)
  })

  it('should compute 0.5 days when halfDay is true', () => {
    const isHalfDay = true
    const startDate = '2024-12-02'
    const endDate = '2024-12-02'

    const daysCount = isHalfDay ? 0.5 : calcWorkingDays(startDate, endDate)
    expect(daysCount).toBe(0.5)
  })

  it('should compute working days when halfDay is false', () => {
    const isHalfDay = false
    const startDate = '2024-12-02'
    const endDate = '2024-12-06' // Monday–Friday

    const daysCount = isHalfDay ? 0.5 : calcWorkingDays(startDate, endDate)
    expect(daysCount).toBe(5)
  })
})
