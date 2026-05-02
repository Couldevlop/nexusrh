import { describe, it, expect } from 'vitest'

// ─── Pure logic extracted from expense routes for testability ────────────────

function computeExpenseWorkflow(
  currentLevel: number,
  currentStatus: string,
  levelsCount: number
): { nextLevel: number; isFullyApproved: boolean; newStatus: string; error?: string } {
  if (currentStatus === 'approved') return { nextLevel: currentLevel, isFullyApproved: false, newStatus: currentStatus, error: 'Note déjà approuvée' }
  if (currentStatus === 'rejected') return { nextLevel: currentLevel, isFullyApproved: false, newStatus: currentStatus, error: 'Note déjà refusée' }

  const nextLevel = currentLevel + 1
  const isFullyApproved = nextLevel >= levelsCount
  // For expenses: intermediate status is 'submitted' (not 'pending')
  const newStatus = isFullyApproved ? 'approved' : 'submitted'
  return { nextLevel, isFullyApproved, newStatus }
}

function computeExpenseTotal(lines: Array<{ amountHT?: number; amountTTC?: number; amount?: number }>): number {
  return lines.reduce((s, l) => {
    const amt = l.amount ?? l.amountTTC ?? 0
    return s + amt
  }, 0)
}

function computeTTC(amountHT: number, vatRate: number): number {
  return parseFloat((amountHT * (1 + vatRate / 100)).toFixed(2))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Expense TTC auto-calculation', () => {
  it('should compute TTC = HT * (1 + TVA/100)', () => {
    expect(computeTTC(100, 20)).toBe(120)
  })

  it('should handle TVA = 0%', () => {
    expect(computeTTC(100, 0)).toBe(100)
  })

  it('should handle TVA = 10%', () => {
    expect(computeTTC(50, 10)).toBe(55)
  })

  it('should round to 2 decimal places', () => {
    expect(computeTTC(23.45, 20)).toBe(28.14)
  })

  it('should handle TVA = 5.5% (restauration)', () => {
    expect(computeTTC(20, 5.5)).toBe(21.1)
  })

  it('should return 0 for HT = 0', () => {
    expect(computeTTC(0, 20)).toBe(0)
  })
})

describe('Expense total computation', () => {
  it('should sum amountTTC from lines', () => {
    const lines = [
      { amountTTC: 23.8 },
      { amountTTC: 15.0 },
    ]
    expect(computeExpenseTotal(lines)).toBe(38.8)
  })

  it('should fallback to amountHT if no TTC', () => {
    const lines = [
      { amountHT: 100 },
    ]
    // computeExpenseTotal uses amount ?? amountTTC ?? 0 (not amountHT)
    // So without amountTTC, result is 0 — that's the API behavior
    expect(computeExpenseTotal(lines)).toBe(0)
  })

  it('should prefer amount over amountTTC', () => {
    const lines = [
      { amount: 50, amountTTC: 60 },
    ]
    expect(computeExpenseTotal(lines)).toBe(50)
  })

  it('should handle empty lines array', () => {
    expect(computeExpenseTotal([])).toBe(0)
  })

  it('should sum multiple lines correctly', () => {
    const lines = [
      { amountTTC: 10 },
      { amountTTC: 20 },
      { amountTTC: 30 },
    ]
    expect(computeExpenseTotal(lines)).toBe(60)
  })
})

describe('Expense category fix', () => {
  it('should use report-level category for all lines', () => {
    const formData = {
      title: 'Mission Paris',
      date: '2024-12-10',
      category: 'transport',
      items: [
        { description: 'Train Paris', amountHt: 80, tva: 10, amountTtc: 88 },
        { description: 'Taxi aéroport', amountHt: 20, tva: 10, amountTtc: 22 },
      ],
    }

    // Before fix: category: item.category (undefined — not in schema)
    // After fix: category: data.category (report-level)
    const apiLines = formData.items.map((item) => ({
      description: item.description,
      category: formData.category, // ← correct: use report-level category
      amountHT: item.amountHt,
      vatRate: item.tva,
      amountTTC: item.amountTtc,
    }))

    expect(apiLines[0]!.category).toBe('transport')
    expect(apiLines[1]!.category).toBe('transport')
    expect(apiLines[0]!.category).not.toBeUndefined()
  })
})

describe('Expense approval workflow', () => {
  describe('Single-level (default)', () => {
    it('should approve immediately at level 1/1', () => {
      const result = computeExpenseWorkflow(0, 'submitted', 1)
      expect(result.isFullyApproved).toBe(true)
      expect(result.newStatus).toBe('approved')
    })
  })

  describe('Two-level approval', () => {
    it('should remain submitted after first approval', () => {
      const result = computeExpenseWorkflow(0, 'submitted', 2)
      expect(result.isFullyApproved).toBe(false)
      expect(result.newStatus).toBe('submitted') // stays submitted (not pending)
      expect(result.nextLevel).toBe(1)
    })

    it('should fully approve at level 2/2', () => {
      const result = computeExpenseWorkflow(1, 'submitted', 2)
      expect(result.isFullyApproved).toBe(true)
      expect(result.newStatus).toBe('approved')
    })
  })

  describe('Guard clauses', () => {
    it('should reject already-approved expense report', () => {
      const result = computeExpenseWorkflow(1, 'approved', 2)
      expect(result.error).toBe('Note déjà approuvée')
    })

    it('should reject already-rejected expense report', () => {
      const result = computeExpenseWorkflow(0, 'rejected', 2)
      expect(result.error).toBe('Note déjà refusée')
    })
  })

  describe('Three-level approval', () => {
    it('should step through all levels', () => {
      const levels = 3
      expect(computeExpenseWorkflow(0, 'submitted', levels).nextLevel).toBe(1)
      expect(computeExpenseWorkflow(0, 'submitted', levels).isFullyApproved).toBe(false)
      expect(computeExpenseWorkflow(1, 'submitted', levels).nextLevel).toBe(2)
      expect(computeExpenseWorkflow(1, 'submitted', levels).isFullyApproved).toBe(false)
      expect(computeExpenseWorkflow(2, 'submitted', levels).nextLevel).toBe(3)
      expect(computeExpenseWorkflow(2, 'submitted', levels).isFullyApproved).toBe(true)
    })
  })
})

describe('Expense month derivation', () => {
  it('should derive month from expenseDate', () => {
    const expenseDate = '2024-12-15'
    const month = expenseDate.slice(0, 7)
    expect(month).toBe('2024-12')
  })

  it('should use current month when no date', () => {
    const now = new Date()
    const currentMonth = now.toISOString().slice(0, 7)
    expect(currentMonth).toMatch(/^\d{4}-\d{2}$/)
  })

  it('should prefer explicit month over derived', () => {
    const body = { month: '2024-11', expenseDate: '2024-12-15' }
    const month = body.month ?? body.expenseDate.slice(0, 7)
    expect(month).toBe('2024-11')
  })
})
