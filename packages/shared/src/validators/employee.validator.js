import { z } from 'zod';
export const addressSchema = z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().length(2),
});
export const createEmployeeSchema = z.object({
    entityId: z.string().uuid(),
    profileType: z
        .enum(['employee', 'intern', 'contractor', 'temp', 'candidate', 'apprentice'])
        .optional()
        .default('employee'),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    email: z.string().email().optional(),
    phone: z.string().max(20).optional(),
    birthDate: z.string().date().optional(),
    birthPlace: z.string().max(100).optional(),
    nationality: z.string().length(2).optional(),
    address: addressSchema.optional(),
    hireDate: z.string().date().optional(),
    jobTitle: z.string().max(200).optional(),
    jobLevel: z.string().max(50).optional(),
    departmentId: z.string().uuid().optional(),
    managerId: z.string().uuid().optional(),
    workingTimePercentage: z.string().optional().default('100.00'),
    weeklyHours: z.string().optional().default('35.00'),
    customFields: z.record(z.unknown()).optional().default({}),
});
export const updateEmployeeSchema = createEmployeeSchema.partial().extend({
    status: z.enum(['active', 'inactive', 'onLeave', 'terminated']).optional(),
    photoUrl: z.string().url().optional(),
    endDate: z.string().date().optional(),
});
//# sourceMappingURL=employee.validator.js.map