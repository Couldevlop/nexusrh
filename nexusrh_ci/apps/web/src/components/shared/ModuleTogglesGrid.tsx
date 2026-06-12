import { useTranslation } from 'react-i18next'
import { Eye } from 'lucide-react'
import { MODULE_KEYS, type ModuleKey } from '@/lib/modules'
import { cn } from '@/lib/utils'

interface ModuleSwitchProps {
  checked: boolean
  onChange: (enabled: boolean) => void
  disabled?: boolean
  ariaLabel: string
}

/** Interrupteur (switch) accessible — pattern role="switch" + aria-checked. */
function ModuleSwitch({ checked, onChange, disabled = false, ariaLabel }: ModuleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

interface ModuleTogglesGridProps {
  /** État courant de chaque module (clé canonique → activé). */
  values: Record<ModuleKey, boolean>
  onToggle: (key: ModuleKey, enabled: boolean) => void
  disabled?: boolean
}

/**
 * Grille de toggles des modules activables par tenant (portail super_admin).
 * La « Vue DG 360° » (dg_view, opt-in) est mise en avant au-dessus de la grille.
 * Libellés/descriptions : namespace platform, clés modules.items.<key>.{label,desc}.
 */
export function ModuleTogglesGrid({ values, onToggle, disabled = false }: ModuleTogglesGridProps) {
  const { t } = useTranslation('platform')
  const standardKeys = MODULE_KEYS.filter((key): key is ModuleKey => key !== 'dg_view')

  return (
    <div className="space-y-3">
      {/* Vue DG 360° — opt-in, mise en avant */}
      <div
        className={cn(
          'flex items-start justify-between gap-3 rounded-lg border p-3',
          values.dg_view ? 'border-purple-300 bg-purple-50' : 'border-purple-200 bg-purple-50/50',
        )}
      >
        <div className="flex items-start gap-2">
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" />
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-purple-900">
              {t('modules.items.dg_view.label')}
              <span className="rounded-full bg-purple-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-800">
                {t('modules.dgViewBadge')}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-purple-800">{t('modules.items.dg_view.desc')}</p>
          </div>
        </div>
        <ModuleSwitch
          checked={values.dg_view}
          disabled={disabled}
          ariaLabel={t('modules.items.dg_view.label')}
          onChange={(enabled) => onToggle('dg_view', enabled)}
        />
      </div>

      {/* Modules standard (actifs par défaut) */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {standardKeys.map((key) => (
          <div key={key} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">{t(`modules.items.${key}.label`)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t(`modules.items.${key}.desc`)}</p>
            </div>
            <ModuleSwitch
              checked={values[key]}
              disabled={disabled}
              ariaLabel={t(`modules.items.${key}.label`)}
              onChange={(enabled) => onToggle(key, enabled)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
