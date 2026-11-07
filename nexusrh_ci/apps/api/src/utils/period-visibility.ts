import { assertValidSchemaName } from './schema-name.js'

/**
 * Visibilité d'une période de paie `alias` (parente, fille ou mono-filiale) pour un
 * utilisateur restreint : visible si un bulletin d'un salarié du périmètre figure sur la
 * période ou ses déclinaisons ; une période SANS aucun bulletin n'est visible que si sa
 * filiale (ou celle d'une déclinaison) est dans le périmètre. 'TRUE' sans restriction.
 * `scopeFor` : fabrique de fragments (alias -> SQL), cf. requestHrScopeFactory.
 */
export function periodVisibilitySql(schema: string, alias: string, scopeFor: (a: string) => string): string {
  const own = scopeFor(alias)
  if (own === 'TRUE') return 'TRUE'
  assertValidSchemaName(schema)
  const family = `(SELECT hvc.id FROM "${schema}".pay_periods hvc WHERE hvc.id = ${alias}.id OR hvc.parent_period_id = ${alias}.id)`
  return `(EXISTS (SELECT 1 FROM "${schema}".pay_slips hvs
                    JOIN "${schema}".employees hve ON hve.id = hvs.employee_id
                   WHERE hvs.period_id IN ${family} AND ${scopeFor('hve')})
     OR (NOT EXISTS (SELECT 1 FROM "${schema}".pay_slips hvs2 WHERE hvs2.period_id IN ${family})
         AND (${own} OR EXISTS (SELECT 1 FROM "${schema}".pay_periods hvc2
                                 WHERE hvc2.parent_period_id = ${alias}.id AND ${scopeFor('hvc2')}))))`
}
