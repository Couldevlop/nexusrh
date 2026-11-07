/**
 * « Ce que voit X » — panneau latéral d'aperçu des droits d'une personne.
 *
 * L'aperçu est calculé par le SERVEUR (`GET /habilitations/preview/:userId`),
 * avec le même moteur que les contrôles d'accès : l'écran n'en refait jamais
 * le calcul. C'est la seule façon pour qu'un plafond retiré se voie
 * immédiatement ici, et que l'aperçu ne mente pas sur ce que l'API autorisera.
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { api } from '@/lib/api'

export interface PreviewData {
  userId: string
  enforced: boolean
  hasAssignment: boolean
  kind: 'siege' | 'entity' | 'none' | null
  subgroupId: string | null
  permissions: string[]
  allEntities: boolean
  sensitive: boolean
  manageHabilitations: boolean
  maskedFields: string[]
  scope: { allEntities: boolean; includesNoEntity: boolean; entityIds: string[]; entities: Array<{ id: string; name: string | null }> }
}

interface PreviewDrawerProps {
  userId: string
  label?: string
  onClose: () => void
}

export function PreviewDrawer({ userId, label, onClose }: PreviewDrawerProps) {
  const { t } = useTranslation('habilitations')
  const q = useQuery({
    queryKey: ['habilitations', 'preview', userId],
    queryFn: async () => (await api.get(`/habilitations/preview/${userId}`)).data.data as PreviewData,
  })
  const d = q.data

  return (
    <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-border bg-card p-5 shadow-xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('preview.title')}</h2>
          {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
        </div>
        <button onClick={onClose} aria-label={t('actions.close')} className="rounded p-1 hover:bg-accent">
          <X className="h-4 w-4" />
        </button>
      </div>

      {q.isLoading ? <p className="text-sm text-muted-foreground">{t('preview.loading')}</p> : null}

      {d ? (
        <div className="space-y-4 text-sm">
          {!d.hasAssignment ? (
            <p className="rounded-lg bg-muted p-3">{t('preview.noAssignment')}</p>
          ) : null}

          <section>
            <h3 className="font-medium">{t('preview.scope')}</h3>
            <p className="text-muted-foreground">
              {d.scope.allEntities
                ? t('preview.scopeAll')
                : d.kind === 'entity'
                  ? (d.scope.entities[0]?.name ?? t('preview.scopeEntity'))
                  : t('preview.scopeSiege')}
            </p>
          </section>

          <section>
            <h3 className="font-medium">{t('preview.permissions')}</h3>
            {d.permissions.length === 0
              ? <p className="text-muted-foreground">{t('preview.none')}</p>
              : (
                <ul className="mt-1 flex flex-wrap gap-1">
                  {d.permissions.map((p) => (
                    <li key={p} className="rounded bg-muted px-2 py-0.5 text-xs">{p}</li>
                  ))}
                </ul>
              )}
          </section>

          <section>
            <h3 className="font-medium">{t('preview.sensitive')}</h3>
            <p className="text-muted-foreground">
              {d.sensitive ? t('preview.sensitiveYes') : t('preview.masked', { count: d.maskedFields.length })}
            </p>
            {d.maskedFields.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-1">
                {d.maskedFields.map((f) => (
                  <li key={f} className="rounded bg-muted px-2 py-0.5 text-xs">{f}</li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      ) : null}
    </aside>
  )
}

export default PreviewDrawer
