export type ContractType = 'CDI' | 'CDD' | 'internship' | 'apprenticeship' | 'temp' | 'freelance';
export type ContractStatus = 'draft' | 'active' | 'terminated' | 'suspended';
export interface Contract {
    id: string;
    employeeId: string;
    type: ContractType;
    startDate: string;
    endDate?: string;
    trialPeriodEnd?: string;
    grossSalary: string;
    salaryBasis: 'monthly' | 'hourly';
    workingHoursPerWeek: string;
    collectiveAgreement?: string;
    jobClassification?: string;
    nonCompetitionClause: boolean;
    telecommutingDays: number;
    documentUrl?: string;
    status: ContractStatus;
    createdAt: string;
    updatedAt: string;
}
export interface CreateContractInput {
    employeeId: string;
    type: ContractType;
    startDate: string;
    endDate?: string;
    trialPeriodEnd?: string;
    grossSalary: string;
    salaryBasis?: 'monthly' | 'hourly';
    workingHoursPerWeek?: string;
    collectiveAgreement?: string;
    jobClassification?: string;
    nonCompetitionClause?: boolean;
    telecommutingDays?: number;
}
//# sourceMappingURL=contract.d.ts.map