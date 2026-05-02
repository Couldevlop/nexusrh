import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// ─── Schemas mirroring shared + frontend form validation ─────────────────────

// Absence form schema (from MesAbsencesPage.tsx)
const absenceFormSchema = z
  .object({
    absenceTypeId: z.string().min(1, 'Veuillez sélectionner un type'),
    startDate: z.string().min(1, 'Date de début requise'),
    endDate: z.string().min(1, 'Date de fin requise'),
    isHalfDay: z.boolean(),
    reason: z.string().optional(),
  })
  .refine((d) => new Date(d.endDate) >= new Date(d.startDate), {
    message: 'La date de fin doit être après la date de début',
    path: ['endDate'],
  })

// Expense form schema (from MesNotesDeFraisPage.tsx)
const expenseItemSchema = z.object({
  description: z.string().min(1, 'Description requise'),
  amountHt: z.coerce.number().min(0, 'Montant invalide'),
  tva: z.coerce.number().min(0).max(100),
  amountTtc: z.coerce.number().min(0, 'Montant TTC invalide'),
})

const expenseFormSchema = z.object({
  title: z.string().min(1, 'Titre requis'),
  date: z.string().min(1, 'Date requise'),
  category: z.string().min(1, 'Catégorie requise'),
  items: z.array(expenseItemSchema).min(1, 'Au moins une ligne requise'),
})

// Employee update schema
const employeeUpdateSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  jobTitle: z.string().max(200).optional(),
  departmentId: z.string().uuid().optional(),
  workingTimePercentage: z.string().optional(),
  weeklyHours: z.string().optional(),
  status: z.enum(['active', 'inactive', 'onLeave', 'terminated']).optional(),
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Absence form validation', () => {
  const validAbsence = {
    absenceTypeId: 'type-uuid-001',
    startDate: '2024-12-02',
    endDate: '2024-12-06',
    isHalfDay: false,
    reason: 'Congé annuel',
  }

  it('should accept a valid absence request', () => {
    const result = absenceFormSchema.safeParse(validAbsence)
    expect(result.success).toBe(true)
  })

  it('should reject empty absenceTypeId', () => {
    const result = absenceFormSchema.safeParse({ ...validAbsence, absenceTypeId: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.errors.map(e => e.path.join('.'))
      expect(paths).toContain('absenceTypeId')
    }
  })

  it('should reject missing startDate', () => {
    const result = absenceFormSchema.safeParse({ ...validAbsence, startDate: '' })
    expect(result.success).toBe(false)
  })

  it('should reject endDate before startDate', () => {
    const result = absenceFormSchema.safeParse({
      ...validAbsence,
      startDate: '2024-12-10',
      endDate: '2024-12-05',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msg = result.error.errors[0]?.message
      expect(msg).toContain('date de fin doit être après')
    }
  })

  it('should accept same start and end date', () => {
    const result = absenceFormSchema.safeParse({
      ...validAbsence,
      startDate: '2024-12-02',
      endDate: '2024-12-02',
    })
    expect(result.success).toBe(true)
  })

  it('should accept half-day with same start/end', () => {
    const result = absenceFormSchema.safeParse({
      ...validAbsence,
      isHalfDay: true,
      startDate: '2024-12-02',
      endDate: '2024-12-02',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.isHalfDay).toBe(true)
    }
  })

  it('should accept optional reason as undefined', () => {
    const { reason: _, ...noReason } = validAbsence
    const result = absenceFormSchema.safeParse(noReason)
    expect(result.success).toBe(true)
  })
})

describe('Expense form validation', () => {
  const validExpense = {
    title: 'Mission Lyon',
    date: '2024-12-10',
    category: 'transport',
    items: [
      { description: 'Train', amountHt: 80, tva: 10, amountTtc: 88 },
    ],
  }

  it('should accept a valid expense with one line', () => {
    const result = expenseFormSchema.safeParse(validExpense)
    expect(result.success).toBe(true)
  })

  it('should reject empty title', () => {
    const result = expenseFormSchema.safeParse({ ...validExpense, title: '' })
    expect(result.success).toBe(false)
  })

  it('should reject empty category', () => {
    const result = expenseFormSchema.safeParse({ ...validExpense, category: '' })
    expect(result.success).toBe(false)
  })

  it('should reject expense with no lines', () => {
    const result = expenseFormSchema.safeParse({ ...validExpense, items: [] })
    expect(result.success).toBe(false)
  })

  it('should reject line with empty description', () => {
    const result = expenseFormSchema.safeParse({
      ...validExpense,
      items: [{ description: '', amountHt: 80, tva: 10, amountTtc: 88 }],
    })
    expect(result.success).toBe(false)
  })

  it('should accept multiple lines', () => {
    const result = expenseFormSchema.safeParse({
      ...validExpense,
      items: [
        { description: 'Train', amountHt: 80, tva: 10, amountTtc: 88 },
        { description: 'Repas', amountHt: 23, tva: 20, amountTtc: 27.6 },
        { description: 'Taxi', amountHt: 15, tva: 10, amountTtc: 16.5 },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.items).toHaveLength(3)
    }
  })

  it('should coerce string amounts to numbers', () => {
    const result = expenseFormSchema.safeParse({
      ...validExpense,
      items: [{ description: 'Repas', amountHt: '23.50', tva: '20', amountTtc: '28.20' }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.items[0]!.amountHt).toBe('number')
    }
  })

  it('should reject negative amountHt', () => {
    const result = expenseFormSchema.safeParse({
      ...validExpense,
      items: [{ description: 'Repas', amountHt: -10, tva: 20, amountTtc: -12 }],
    })
    expect(result.success).toBe(false)
  })

  it('should reject TVA > 100', () => {
    const result = expenseFormSchema.safeParse({
      ...validExpense,
      items: [{ description: 'Repas', amountHt: 10, tva: 150, amountTtc: 25 }],
    })
    expect(result.success).toBe(false)
  })
})

describe('Employee update schema', () => {
  it('should accept partial updates', () => {
    const result = employeeUpdateSchema.safeParse({ jobTitle: 'Senior Developer' })
    expect(result.success).toBe(true)
  })

  it('should accept empty object (all optional)', () => {
    const result = employeeUpdateSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should reject invalid email', () => {
    const result = employeeUpdateSchema.safeParse({ email: 'not-an-email' })
    expect(result.success).toBe(false)
  })

  it('should reject invalid status', () => {
    const result = employeeUpdateSchema.safeParse({ status: 'fired' })
    expect(result.success).toBe(false)
  })

  it('should accept all valid statuses', () => {
    const statuses = ['active', 'inactive', 'onLeave', 'terminated']
    for (const status of statuses) {
      const result = employeeUpdateSchema.safeParse({ status })
      expect(result.success).toBe(true)
    }
  })

  it('should reject phone longer than 20 chars', () => {
    const result = employeeUpdateSchema.safeParse({ phone: '123456789012345678901' }) // 21 chars
    expect(result.success).toBe(false)
  })

  it('workingTimePercentage should accept string values', () => {
    const result = employeeUpdateSchema.safeParse({
      workingTimePercentage: '100.00',
      weeklyHours: '35.00',
    })
    expect(result.success).toBe(true)
  })
})
