export type EmployeeStatus = 'active' | 'inactive' | 'onLeave' | 'terminated';
export type ProfileType = 'employee' | 'intern' | 'contractor' | 'temp' | 'candidate' | 'apprentice';
export type BurnoutRisk = 'low' | 'medium' | 'high';
export interface Address {
    street: string;
    city: string;
    postalCode: string;
    country: string;
}
export interface LegalEntity {
    id: string;
    name: string;
    siren?: string;
    siret?: string;
    apeCode?: string;
    collectiveAgreement?: string;
    countryCode: string;
    address?: Address;
    logoUrl?: string;
    createdAt: string;
    updatedAt: string;
}
export interface Department {
    id: string;
    entityId: string;
    name: string;
    code?: string;
    parentId?: string;
    managerId?: string;
    costCenter?: string;
    createdAt: string;
}
export interface Employee {
    id: string;
    entityId: string;
    employeeNumber?: string;
    profileType: ProfileType;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    birthDate?: string;
    birthPlace?: string;
    nationality?: string;
    socialSecurityNumber?: string;
    iban?: string;
    bic?: string;
    address?: Address;
    hireDate?: string;
    endDate?: string;
    jobTitle?: string;
    jobLevel?: string;
    departmentId?: string;
    managerId?: string;
    workingTimePercentage: string;
    weeklyHours: string;
    status: EmployeeStatus;
    photoUrl?: string;
    hasDisability: boolean;
    retentionScore?: string;
    burnoutRisk?: BurnoutRisk;
    aiScoreUpdatedAt?: string;
    aiScoreFactors: string[];
    customFields: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    department?: Department;
    manager?: Pick<Employee, 'id' | 'firstName' | 'lastName' | 'jobTitle'>;
    entity?: LegalEntity;
}
export interface EmployeeListItem {
    id: string;
    employeeNumber?: string;
    firstName: string;
    lastName: string;
    email?: string;
    jobTitle?: string;
    departmentId?: string;
    department?: Pick<Department, 'id' | 'name'>;
    status: EmployeeStatus;
    photoUrl?: string;
    hireDate?: string;
    retentionScore?: string;
    burnoutRisk?: BurnoutRisk;
}
export interface HREvent {
    id: string;
    employeeId: string;
    type: string;
    title: string;
    description?: string;
    eventDate: string;
    metadata: Record<string, unknown>;
    isPrivate: boolean;
    createdBy?: string;
    createdAt: string;
}
export interface EmployeeDocument {
    id: string;
    employeeId?: string;
    type: string;
    title: string;
    fileUrl: string;
    fileSize?: number;
    mimeType?: string;
    isConfidential: boolean;
    signedByEmployee: boolean;
    signedAt?: string;
    expiresAt?: string;
    createdBy?: string;
    createdAt: string;
}
export interface CreateEmployeeInput {
    entityId: string;
    profileType?: ProfileType;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    birthDate?: string;
    birthPlace?: string;
    nationality?: string;
    address?: Address;
    hireDate?: string;
    jobTitle?: string;
    jobLevel?: string;
    departmentId?: string;
    managerId?: string;
    workingTimePercentage?: string;
    weeklyHours?: string;
    customFields?: Record<string, unknown>;
}
export interface UpdateEmployeeInput extends Partial<CreateEmployeeInput> {
    status?: EmployeeStatus;
    photoUrl?: string;
    endDate?: string;
}
//# sourceMappingURL=employee.d.ts.map