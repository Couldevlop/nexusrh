import { z } from 'zod';
export declare const addressSchema: z.ZodObject<{
    street: z.ZodString;
    city: z.ZodString;
    postalCode: z.ZodString;
    country: z.ZodString;
}, "strip", z.ZodTypeAny, {
    street: string;
    city: string;
    postalCode: string;
    country: string;
}, {
    street: string;
    city: string;
    postalCode: string;
    country: string;
}>;
export declare const createEmployeeSchema: z.ZodObject<{
    entityId: z.ZodString;
    profileType: z.ZodDefault<z.ZodOptional<z.ZodEnum<["employee", "intern", "contractor", "temp", "candidate", "apprentice"]>>>;
    firstName: z.ZodString;
    lastName: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    phone: z.ZodOptional<z.ZodString>;
    birthDate: z.ZodOptional<z.ZodString>;
    birthPlace: z.ZodOptional<z.ZodString>;
    nationality: z.ZodOptional<z.ZodString>;
    address: z.ZodOptional<z.ZodObject<{
        street: z.ZodString;
        city: z.ZodString;
        postalCode: z.ZodString;
        country: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    }, {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    }>>;
    hireDate: z.ZodOptional<z.ZodString>;
    jobTitle: z.ZodOptional<z.ZodString>;
    jobLevel: z.ZodOptional<z.ZodString>;
    departmentId: z.ZodOptional<z.ZodString>;
    managerId: z.ZodOptional<z.ZodString>;
    workingTimePercentage: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    weeklyHours: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    customFields: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, "strip", z.ZodTypeAny, {
    firstName: string;
    lastName: string;
    entityId: string;
    profileType: "employee" | "candidate" | "intern" | "contractor" | "temp" | "apprentice";
    workingTimePercentage: string;
    weeklyHours: string;
    customFields: Record<string, unknown>;
    email?: string | undefined;
    address?: {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    } | undefined;
    phone?: string | undefined;
    birthDate?: string | undefined;
    birthPlace?: string | undefined;
    nationality?: string | undefined;
    hireDate?: string | undefined;
    jobTitle?: string | undefined;
    jobLevel?: string | undefined;
    managerId?: string | undefined;
    departmentId?: string | undefined;
}, {
    firstName: string;
    lastName: string;
    entityId: string;
    email?: string | undefined;
    address?: {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    } | undefined;
    profileType?: "employee" | "candidate" | "intern" | "contractor" | "temp" | "apprentice" | undefined;
    phone?: string | undefined;
    birthDate?: string | undefined;
    birthPlace?: string | undefined;
    nationality?: string | undefined;
    hireDate?: string | undefined;
    jobTitle?: string | undefined;
    jobLevel?: string | undefined;
    managerId?: string | undefined;
    departmentId?: string | undefined;
    workingTimePercentage?: string | undefined;
    weeklyHours?: string | undefined;
    customFields?: Record<string, unknown> | undefined;
}>;
export declare const updateEmployeeSchema: z.ZodObject<{
    entityId: z.ZodOptional<z.ZodString>;
    profileType: z.ZodOptional<z.ZodDefault<z.ZodOptional<z.ZodEnum<["employee", "intern", "contractor", "temp", "candidate", "apprentice"]>>>>;
    firstName: z.ZodOptional<z.ZodString>;
    lastName: z.ZodOptional<z.ZodString>;
    email: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    phone: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    birthDate: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    birthPlace: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    nationality: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    address: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        street: z.ZodString;
        city: z.ZodString;
        postalCode: z.ZodString;
        country: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    }, {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    }>>>;
    hireDate: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    jobTitle: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    jobLevel: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    departmentId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    managerId: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    workingTimePercentage: z.ZodOptional<z.ZodDefault<z.ZodOptional<z.ZodString>>>;
    weeklyHours: z.ZodOptional<z.ZodDefault<z.ZodOptional<z.ZodString>>>;
    customFields: z.ZodOptional<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
} & {
    status: z.ZodOptional<z.ZodEnum<["active", "inactive", "onLeave", "terminated"]>>;
    photoUrl: z.ZodOptional<z.ZodString>;
    endDate: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status?: "active" | "inactive" | "onLeave" | "terminated" | undefined;
    email?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
    address?: {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    } | undefined;
    entityId?: string | undefined;
    profileType?: "employee" | "candidate" | "intern" | "contractor" | "temp" | "apprentice" | undefined;
    phone?: string | undefined;
    birthDate?: string | undefined;
    birthPlace?: string | undefined;
    nationality?: string | undefined;
    hireDate?: string | undefined;
    endDate?: string | undefined;
    jobTitle?: string | undefined;
    jobLevel?: string | undefined;
    managerId?: string | undefined;
    departmentId?: string | undefined;
    workingTimePercentage?: string | undefined;
    weeklyHours?: string | undefined;
    photoUrl?: string | undefined;
    customFields?: Record<string, unknown> | undefined;
}, {
    status?: "active" | "inactive" | "onLeave" | "terminated" | undefined;
    email?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
    address?: {
        street: string;
        city: string;
        postalCode: string;
        country: string;
    } | undefined;
    entityId?: string | undefined;
    profileType?: "employee" | "candidate" | "intern" | "contractor" | "temp" | "apprentice" | undefined;
    phone?: string | undefined;
    birthDate?: string | undefined;
    birthPlace?: string | undefined;
    nationality?: string | undefined;
    hireDate?: string | undefined;
    endDate?: string | undefined;
    jobTitle?: string | undefined;
    jobLevel?: string | undefined;
    managerId?: string | undefined;
    departmentId?: string | undefined;
    workingTimePercentage?: string | undefined;
    weeklyHours?: string | undefined;
    photoUrl?: string | undefined;
    customFields?: Record<string, unknown> | undefined;
}>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
//# sourceMappingURL=employee.validator.d.ts.map