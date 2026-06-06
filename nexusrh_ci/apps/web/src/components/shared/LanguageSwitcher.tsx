import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'
import { cn } from '@/lib/utils'

interface LanguageSwitcherProps {
  /** Variante compacte (FR | EN) pour les sidebars/headers denses. */
  compact?: boolean
  className?: string
}

/**
 * Sélecteur de langue FR/EN — persiste le choix (localStorage `nexusrh:lang`)
 * via le listener languageChanged du module i18n.
 */
export function LanguageSwitcher({ compact = true, className }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation('common')
  const current = (i18n.resolvedLanguage ?? i18n.language ?? 'fr').slice(0, 2) as SupportedLanguage

  const switchTo = (lng: SupportedLanguage): void => {
    if (lng !== current) void i18n.changeLanguage(lng)
  }

  return (
    <div
      role="group"
      aria-label={t('language.label')}
      className={cn('inline-flex items-center rounded-lg border border-border bg-muted/40 p-0.5', className)}
    >
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => switchTo(lng)}
          aria-pressed={current === lng}
          title={t(`language.${lng}`)}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-semibold uppercase transition-colors',
            current === lng
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {compact ? lng : t(`language.${lng}`)}
        </button>
      ))}
    </div>
  )
}
