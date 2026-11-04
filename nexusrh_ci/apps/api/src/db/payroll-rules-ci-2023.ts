/**
 * Rubriques de paie CI des heures supplémentaires — décret n° 2024-898 du
 * 16/10/2024 relatif à la durée du travail, art. 25 (abroge le décret n° 96-203,
 * mêmes taux) : 41e–46e h +15 % ; au-delà de la 46e h +50 % ; nuit +75 % ;
 * dimanche / férié de jour +75 % ; dimanche / férié de nuit +100 %.
 *
 * Source unique pour le provisioning (nouveaux tenants) et la migration lazy
 * (tenants existants). Le libellé imprimé sur le bulletin reste dérivé du pack
 * par le moteur (`overtimeLabels`) ; celui-ci est le libellé du paramétrage.
 */

import { assertValidSchemaName } from '../utils/schema-name.js'

export interface CiPayrollRule {
  code: string
  label: string
  type: 'earning'
  formula: string
  order: number
}

export const CI_OVERTIME_RULES: readonly CiPayrollRule[] = [
  { code: '1400', label: 'Heures supplémentaires +15 % (41e à 46e heure)',            type: 'earning', formula: 'VAR:HEURES_SUPP_NORM',  order: 50 },
  { code: '1450', label: 'Heures supplémentaires +50 % (au-delà de la 46e heure)',    type: 'earning', formula: 'VAR:HEURES_SUPP_47',    order: 55 },
  { code: '1500', label: 'Heures supplémentaires de nuit (+75 %)',                     type: 'earning', formula: 'VAR:HEURES_SUPP_NUIT',  order: 60 },
  { code: '1520', label: 'Heures supplémentaires dimanche/férié de jour (+75 %)',     type: 'earning', formula: 'VAR:HEURES_SUPP_DIM',   order: 62 },
  { code: '1550', label: 'Heures supplémentaires dimanche/férié de nuit (+100 %)',    type: 'earning', formula: 'VAR:HEURES_SUPP_FERIE', order: 65 },
]

/** Libellés d'origine (provisioning avant le 04/11/2026). */
export const CI_OVERTIME_LEGACY_LABELS: Readonly<Record<string, string>> = {
  '1400': 'Heures supplémentaires (+15%)',
  '1500': 'Heures supplémentaires (+50%)',
  '1550': 'Heures supplémentaires (+100%)',
}

const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`

/**
 * Migration idempotente des rubriques d'un tenant existant :
 *  - libellés 1400 / 1500 / 1550 mis à jour seulement s'ils valent encore
 *    exactement le libellé d'origine (un libellé personnalisé est gardé) ;
 *  - rubriques 1450 / 1520 ajoutées si absentes, uniquement pour les tenants
 *    dotés des rubriques CI (présence de VAR:HEURES_SUPP_NORM).
 */
export function ciOvertimeRuleMigrations(schemaName: string): string[] {
  assertValidSchemaName(schemaName)
  const t = `"${schemaName}".payroll_rules`
  const out: string[] = []
  for (const r of CI_OVERTIME_RULES) {
    const legacy = CI_OVERTIME_LEGACY_LABELS[r.code]
    if (legacy !== undefined) {
      out.push(`UPDATE ${t} SET label = ${lit(r.label)} WHERE code = ${lit(r.code)} AND label = ${lit(legacy)}`)
    }
  }
  for (const r of CI_OVERTIME_RULES) {
    if (CI_OVERTIME_LEGACY_LABELS[r.code] !== undefined) continue
    out.push(
      `INSERT INTO ${t} (code, label, type, formula, "order") `
      + `SELECT ${lit(r.code)}, ${lit(r.label)}, ${lit(r.type)}, ${lit(r.formula)}, ${r.order} `
      + `WHERE EXISTS (SELECT 1 FROM ${t} WHERE formula = 'VAR:HEURES_SUPP_NORM') `
      + `AND NOT EXISTS (SELECT 1 FROM ${t} WHERE formula = ${lit(r.formula)})`,
    )
  }
  return out
}

/**
 * Colonnes CMU de la fiche salarié (loi n° 2014-131 ; CLEISS 2025) :
 *  - `cmu_spouse_covered` : conjoint SANS EMPLOI, donc couvert par la CMU du
 *    salarié. NULL = situation non renseignée (un salarié marié est alors
 *    signalé « à vérifier ») ; false = conjoint qui travaille ou non couvert.
 *    Colonne nullable sans défaut ; les lignes existantes ne sont pas reprises
 *    (false garde son sens).
 *  - `cmu_children_covered` : enfants de moins de 21 ans couverts ; NULL = le
 *    nombre d'enfants à charge (l'âge des enfants n'est pas suivi).
 * Idempotent : rejouable à chaque migration lazy.
 */
export function ciCmuEmployeeColumnMigrations(schemaName: string): string[] {
  assertValidSchemaName(schemaName)
  const t = `"${schemaName}".employees`
  return [
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cmu_spouse_covered boolean`,
    `ALTER TABLE ${t} ALTER COLUMN cmu_spouse_covered DROP NOT NULL`,
    `ALTER TABLE ${t} ALTER COLUMN cmu_spouse_covered DROP DEFAULT`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cmu_children_covered integer`,
  ]
}
