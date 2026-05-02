export declare const ABSENCE_TYPE_CODES: {
    readonly PAID_LEAVE: "CP";
    readonly RTT: "RTT";
    readonly SICK: "MAL";
    readonly MATERNITY: "MAT";
    readonly PATERNITY: "PAT";
    readonly CHILD_SICK: "ENF";
    readonly BEREAVEMENT: "DEUIL";
    readonly MOVING: "DEMEN";
    readonly UNPAID: "SSOL";
    readonly RECOVERY: "RECUP";
    readonly TRAINING: "FORM";
    readonly ACCIDENT: "AT";
};
export declare const DEFAULT_ABSENCE_TYPES: ({
    code: string;
    label: string;
    category: "paid_leave";
    color: string;
    requiresApproval: boolean;
    isPaid: boolean;
    maxDaysPerYear: string;
    requiresJustification?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "rtt";
    color: string;
    requiresApproval: boolean;
    isPaid: boolean;
    maxDaysPerYear?: undefined;
    requiresJustification?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "sick";
    color: string;
    requiresJustification: boolean;
    requiresApproval: boolean;
    impactsPayroll: boolean;
    isPaid?: undefined;
    maxDaysPerYear?: undefined;
} | {
    code: string;
    label: string;
    category: "maternity";
    color: string;
    requiresJustification: boolean;
    requiresApproval: boolean;
    maxDaysPerYear: string;
    isPaid?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "paternity";
    color: string;
    requiresJustification: boolean;
    requiresApproval: boolean;
    maxDaysPerYear: string;
    isPaid?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "family";
    color: string;
    requiresJustification: boolean;
    requiresApproval: boolean;
    maxDaysPerYear: string;
    isPaid?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "family";
    color: string;
    requiresJustification: boolean;
    requiresApproval: boolean;
    isPaid?: undefined;
    maxDaysPerYear?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "unpaid";
    color: string;
    requiresApproval: boolean;
    isPaid: boolean;
    maxDaysPerYear?: undefined;
    requiresJustification?: undefined;
    impactsPayroll?: undefined;
} | {
    code: string;
    label: string;
    category: "other";
    color: string;
    requiresApproval: boolean;
    isPaid: boolean;
    maxDaysPerYear?: undefined;
    requiresJustification?: undefined;
    impactsPayroll?: undefined;
})[];
//# sourceMappingURL=absence-types.d.ts.map