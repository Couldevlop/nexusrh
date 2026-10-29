/**
 * En-têtes des colonnes cotisation salariale / impôt de la liste des bulletins.
 *
 * Chaque bulletin porte les libellés courts de son pack législatif
 * (`caisse_short` / `impot_short`, renvoyés par GET /payroll/payslips) :
 *   - un seul pack affiché → ses libellés (« CNPS sal. » / « ITS », « CNSS sal. » / « IUTS »…) ;
 *   - plusieurs packs (multi-filiales multi-pays) → en-têtes neutres.
 * Liste vide ou ancienne API sans libellés → libellés CI historiques.
 */
export interface SlipCountryLabels { caisse_short?: string | null; impot_short?: string | null }

export type PayslipColumnLabels =
  | { mixed: false; caisse: string; impot: string }
  | { mixed: true }

export function payslipColumnLabels(slips: ReadonlyArray<SlipCountryLabels>): PayslipColumnLabels {
  const pairs = new Set(slips.map(s => `${s.caisse_short || 'CNPS'}|${s.impot_short || 'ITS'}`))
  if (pairs.size > 1) return { mixed: true }
  const [caisse, impot] = (pairs.values().next().value ?? 'CNPS|ITS').split('|')
  return { mixed: false, caisse: caisse || 'CNPS', impot: impot || 'ITS' }
}