import { z } from 'zod';
export declare const createVariableElementSchema: z.ZodObject<{
    employeeId: z.ZodString;
    periodId: z.ZodString;
    ruleCode: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    amount: z.ZodOptional<z.ZodString>;
    quantity: z.ZodOptional<z.ZodString>;
    rate: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
    source: z.ZodDefault<z.ZodOptional<z.ZodEnum<["manual", "import", "automatic", "absence", "overtime"]>>>;
}, "strip", z.ZodTypeAny, {
    employeeId: string;
    periodId: string;
    ruleCode: string;
    source: "manual" | "absence" | "import" | "automatic" | "overtime";
    label?: string | undefined;
    amount?: string | undefined;
    quantity?: string | undefined;
    rate?: string | undefined;
    note?: string | undefined;
}, {
    employeeId: string;
    periodId: string;
    ruleCode: string;
    label?: string | undefined;
    amount?: string | undefined;
    quantity?: string | undefined;
    rate?: string | undefined;
    note?: string | undefined;
    source?: "manual" | "absence" | "import" | "automatic" | "overtime" | undefined;
}>;
export declare const createPayPeriodSchema: z.ZodObject<{
    entityId: z.ZodString;
    year: z.ZodNumber;
    month: z.ZodNumber;
    paymentDate: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    entityId: string;
    year: number;
    month: number;
    paymentDate?: string | undefined;
}, {
    entityId: string;
    year: number;
    month: number;
    paymentDate?: string | undefined;
}>;
export declare const payrollRuleSchema: z.ZodObject<{
    entityId: z.ZodString;
    code: z.ZodString;
    label: z.ZodString;
    type: z.ZodEnum<["earning", "deduction", "employer_contribution", "employee_contribution", "info"]>;
    formula: z.ZodString;
    base: z.ZodOptional<z.ZodString>;
    employeeRate: z.ZodOptional<z.ZodString>;
    employerRate: z.ZodOptional<z.ZodString>;
    ceilingSS: z.ZodOptional<z.ZodString>;
    isActive: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    order: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    appliesTo: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        profileTypes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        departments: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        collectiveAgreements: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        departments?: string[] | undefined;
        profileTypes?: string[] | undefined;
        collectiveAgreements?: string[] | undefined;
    }, {
        departments?: string[] | undefined;
        profileTypes?: string[] | undefined;
        collectiveAgreements?: string[] | undefined;
    }>>>;
    validFrom: z.ZodOptional<z.ZodString>;
    validUntil: z.ZodOptional<z.ZodString>;
    legalReference: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    code: string;
    type: "info" | "earning" | "employee_contribution" | "deduction" | "employer_contribution";
    entityId: string;
    isActive: boolean;
    label: string;
    formula: string;
    order: number;
    appliesTo: {
        departments?: string[] | undefined;
        profileTypes?: string[] | undefined;
        collectiveAgreements?: string[] | undefined;
    };
    base?: string | undefined;
    employeeRate?: string | undefined;
    employerRate?: string | undefined;
    ceilingSS?: string | undefined;
    validFrom?: string | undefined;
    validUntil?: string | undefined;
    legalReference?: string | undefined;
}, {
    code: string;
    type: "info" | "earning" | "employee_contribution" | "deduction" | "employer_contribution";
    entityId: string;
    label: string;
    formula: string;
    isActive?: boolean | undefined;
    base?: string | undefined;
    employeeRate?: string | undefined;
    employerRate?: string | undefined;
    ceilingSS?: string | undefined;
    order?: number | undefined;
    appliesTo?: {
        departments?: string[] | undefined;
        profileTypes?: string[] | undefined;
        collectiveAgreements?: string[] | undefined;
    } | undefined;
    validFrom?: string | undefined;
    validUntil?: string | undefined;
    legalReference?: string | undefined;
}>;
export type CreateVariableElementInput = z.infer<typeof createVariableElementSchema>;
export type CreatePayPeriodInput = z.infer<typeof createPayPeriodSchema>;
export type PayrollRuleInput = z.infer<typeof payrollRuleSchema>;
//# sourceMappingURL=payroll.validator.d.ts.map