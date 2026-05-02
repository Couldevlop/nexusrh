export type PayPeriodStatus = 'open' | 'calculating' | 'review' | 'validated' | 'closed';
export type PaySlipStatus = 'draft' | 'generated' | 'sent' | 'viewed';
export type PaySlipLineType = 'earning' | 'deduction' | 'employer_contribution' | 'employee_contribution' | 'info';
export interface PaySlipLine {
    ruleCode: string;
    label: string;
    base: number;
    quantity?: number;
    employeeRate?: number;
    employerRate?: number;
    employeeAmount: number;
    employerAmount: number;
    type: PaySlipLineType;
}
export interface VariableElementSummary {
    ruleCode: string;
    label: string;
    amount: number;
}
export interface PayrollRule {
    id: string;
    entityId: string;
    code: string;
    label: string;
    type: PaySlipLineType;
    formula: string;
    base?: string;
    employeeRate?: string;
    employerRate?: string;
    ceilingSS?: string;
    isActive: boolean;
    order: number;
    appliesTo: {
        profileTypes?: string[];
        departments?: string[];
        collectiveAgreements?: string[];
    };
    validFrom?: string;
    validUntil?: string;
    legalReference?: string;
    createdAt: string;
    updatedAt: string;
}
export interface PayPeriod {
    id: string;
    entityId: string;
    year: number;
    month: number;
    status: PayPeriodStatus;
    openedAt?: string;
    validatedAt?: string;
    closedAt?: string;
    closedBy?: string;
    totalGross?: string;
    totalNet?: string;
    totalEmployerCost?: string;
    paymentDate?: string;
}
export interface PaySlip {
    id: string;
    employeeId: string;
    periodId: string;
    year: number;
    month: number;
    grossSalary: string;
    netBeforeTax?: string;
    incomeTax: string;
    netPayable: string;
    employerCost?: string;
    lines: PaySlipLine[];
    variableElements: VariableElementSummary[];
    workingDays?: string;
    pdfUrl?: string;
    status: PaySlipStatus;
    generatedAt?: string;
    sentAt?: string;
    viewedByEmployeeAt?: string;
    createdAt: string;
}
export interface VariableElement {
    id: string;
    employeeId: string;
    periodId: string;
    ruleCode: string;
    label?: string;
    amount?: string;
    quantity?: string;
    rate?: string;
    note?: string;
    source: 'manual' | 'import' | 'automatic' | 'absence' | 'overtime';
    createdBy?: string;
    createdAt: string;
}
export interface PayrollCalculationResult {
    lines: PaySlipLine[];
    grossSalary: number;
    netBeforeTax: number;
    incomeTax: number;
    netPayable: number;
    employerCost: number;
    workingDays: number;
}
//# sourceMappingURL=payroll.d.ts.map