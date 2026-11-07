/**
 * Grille d'habilitations : 18 fonctions × 9 actions, plus les droits transverses.
 *
 * Trois règles d'affichage, toutes volontaires :
 *  - une case qui n'existe pas dans le catalogue n'est pas rendue du tout
 *    (pas une case cochable qui échouerait à l'enregistrement) ;
 *  - une case hors plafond du sous-groupe est rendue, mais désactivée : l'admin
 *    voit qu'elle existe et comprend qu'elle est bornée par le plafond ;
 *  - en lecture seule, tout est désactivé — aucun changement n'est remonté.
 *
 * L'`aria-label` de chaque case est la clé de permission (`employees:view`) :
 * lisible par un lecteur d'écran autant que par un test.
 */
import { useTranslation } from 'react-i18next'
import { HAB_ACTIONS, HAB_EXTRA, HAB_FUNCTIONS, HAB_GRID, type HabAction, type HabFunction } from '@/lib/habilitations'
import { cn } from '@/lib/utils'

interface PermissionGridProps {
  value: string[]
  onChange?: (next: string[]) => void
  /** Plafond du sous-groupe ; `null`/absent = aucune borne affichée. */
  ceiling?: string[] | null
  readOnly?: boolean
}

export function PermissionGrid({ value, onChange, ceiling = null, readOnly = false }: PermissionGridProps) {
  const { t } = useTranslation('habilitations')
  const selected = new Set(value)
  const capped = (perm: string): boolean => ceiling !== null && !ceiling.includes(perm)

  const toggle = (perm: string): void => {
    if (readOnly || capped(perm) || !onChange) return
    if (selected.has(perm)) onChange(value.filter((p) => p !== perm))
    else onChange([...value, perm])
  }

  const checkbox = (perm: string) => (
    <input
      type="checkbox"
      aria-label={perm}
      checked={selected.has(perm)}
      disabled={readOnly || capped(perm)}
      onChange={() => toggle(perm)}
      className="h-4 w-4 rounded border-border accent-primary disabled:opacity-40"
    />
  )

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('grid.function')}</th>
              {HAB_ACTIONS.map((a) => (
                <th key={a} className="px-2 py-2 text-center font-medium whitespace-nowrap">{t(`gridActions.${a}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HAB_FUNCTIONS.map((fn: HabFunction) => (
              <tr key={fn} className="border-t border-border">
                <td className="px-3 py-2 whitespace-nowrap">{t(`functions.${fn}`)}</td>
                {HAB_ACTIONS.map((a: HabAction) => (
                  <td key={a} className="px-2 py-2 text-center">
                    {(HAB_GRID[fn] as readonly string[]).includes(a) ? checkbox(`${fn}:${a}`) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={cn('rounded-lg border border-border p-3', 'space-y-2')}>
        <p className="text-sm font-medium">{t('grid.extras')}</p>
        {HAB_EXTRA.map((e) => (
          <label key={e} className="flex items-center gap-2 text-sm">
            {checkbox(e)}
            <span>{t(`extras.${e}`)}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

export default PermissionGrid
