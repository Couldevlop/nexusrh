/**
 * Types d'absence et règle de durée du congé de maternité (pack pays), partagés
 * entre la demande en self-service (Mon espace) et la saisie RH/manager.
 */

export interface MaternityRule {
  legalDays: number; multipleBirthDays: number; illnessDays: number; maxHospitalizationDays: number
}
export interface AbsenceType { id: string; label: string; code: string; color: string; maternity_rule?: MaternityRule }

/** Date + n jours (YYYY-MM-DD, sans décalage de fuseau). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Durée totale du congé : durée légale + prolongations (naissance multiple, maladie, hospitalisation bornée). */
export function maternityTotalDays(
  rule: MaternityRule,
  opts: { multipleBirth?: boolean; illnessExtension?: boolean; hospitalizedDays?: number },
): number {
  return rule.legalDays
    + (opts.multipleBirth ? rule.multipleBirthDays : 0)
    + (opts.illnessExtension ? rule.illnessDays : 0)
    + Math.min(Math.max(0, opts.hospitalizedDays ?? 0), rule.maxHospitalizationDays)
}
