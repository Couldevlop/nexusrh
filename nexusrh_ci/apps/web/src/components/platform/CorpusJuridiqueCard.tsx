import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { BookText, RefreshCw, Search, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface Stats { pg_count: number; es_count: number }
interface SeedResult { success: boolean; persisted: number; indexed: number; desactives: number }

/**
 * Rechargement du corpus juridique — réservé au super_admin.
 *
 * Le corpus (Code du Travail, conventions, textes annexes) vit dans un fichier
 * de données, mais la source servie aux utilisateurs est PostgreSQL. Tant que
 * ce rechargement n'est pas lancé, une correction du fichier n'atteint personne :
 * l'upsert n'efface jamais, et le seed automatique ne se déclenche que sur table
 * vide — ce qu'elle n'est jamais en production. D'où ce bouton, qui évite de
 * devoir appeler la route à la main après chaque correction.
 */
export default function CorpusJuridiqueCard() {
  const { t } = useTranslation('platform')
  const qc = useQueryClient()
  const [confirme, setConfirme] = useState(false)
  const [resultat, setResultat] = useState<SeedResult | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  const { data: stats } = useQuery<Stats>({
    queryKey: ['referentiel-stats'],
    queryFn: () => api.get('/referentiels/stats').then(r => r.data),
  })

  const echec = (e: unknown): void => {
    const r = (e as { response?: { status?: number; data?: { error?: string } } })?.response
    setErreur(r?.status === 429
      ? t('corpus.tropSouvent', 'Trop de rechargements récents : réessayez dans quelques minutes.')
      : r?.data?.error ?? t('corpus.echec', 'Le rechargement a échoué. Rien n’a été modifié.'))
  }

  const recharger = useMutation<SeedResult>({
    mutationFn: () => api.post('/referentiels/seed').then(r => r.data),
    onMutate: () => { setErreur(null); setResultat(null) },
    onSuccess: d => {
      setResultat(d); setConfirme(false)
      qc.invalidateQueries({ queryKey: ['referentiel-stats'] })
    },
    onError: e => { setConfirme(false); echec(e) },
  })

  const reindexer = useMutation<{ indexed: number }>({
    mutationFn: () => api.post('/referentiels/reindex').then(r => r.data),
    onMutate: () => { setErreur(null); setResultat(null) },
    onSuccess: d => {
      setResultat({ success: true, persisted: 0, indexed: d.indexed, desactives: 0 })
      qc.invalidateQueries({ queryKey: ['referentiel-stats'] })
    },
    onError: echec,
  })

  const enCours = recharger.isPending || reindexer.isPending

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <BookText className="h-4 w-4 text-primary" />
        {t('corpus.titre', 'Corpus juridique')}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t('corpus.explication', 'Articles du Code du Travail, conventions collectives et textes annexes servis dans l’écran Référentiel juridique. Après une correction du corpus, ce rechargement est nécessaire pour que les utilisateurs la voient : les articles retirés sont désactivés, les autres réécrits.')}
      </p>

      <div className="mb-4 flex flex-wrap gap-6 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('corpus.enBase', 'Articles en base')}
          </div>
          <div className="text-xl font-bold tabular-nums">{stats?.pg_count ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('corpus.indexes', 'Indexés pour la recherche')}
          </div>
          <div className="text-xl font-bold tabular-nums">
            {stats === undefined ? '—' : stats.es_count < 0 ? t('corpus.indisponible', 'indisponible') : stats.es_count}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!confirme ? (
          <button
            type="button"
            disabled={enCours}
            onClick={() => { setConfirme(true); setErreur(null); setResultat(null) }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${recharger.isPending ? 'animate-spin' : ''}`} />
            {t('corpus.recharger', 'Recharger le corpus')}
          </button>
        ) : (
          <>
            <span className="text-sm text-amber-700">
              {t('corpus.demandeConfirmation', 'Les articles absents du corpus seront désactivés. Confirmer ?')}
            </span>
            <button
              type="button"
              disabled={enCours}
              onClick={() => recharger.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${recharger.isPending ? 'animate-spin' : ''}`} />
              {t('corpus.confirmer', 'Confirmer le rechargement')}
            </button>
            <button
              type="button"
              disabled={enCours}
              onClick={() => setConfirme(false)}
              className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
            >
              {t('corpus.annuler', 'Annuler')}
            </button>
          </>
        )}

        <button
          type="button"
          disabled={enCours}
          onClick={() => reindexer.mutate()}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
        >
          <Search className={`h-4 w-4 ${reindexer.isPending ? 'animate-spin' : ''}`} />
          {t('corpus.reindexer', 'Réindexer la recherche seule')}
        </button>
      </div>

      {resultat !== null && (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t('corpus.resultat', '{{persisted}} articles écrits, {{indexed}} indexés, {{desactives}} désactivés.', {
            persisted: resultat.persisted, indexed: resultat.indexed, desactives: resultat.desactives,
          })}
        </p>
      )}
      {erreur !== null && (
        <p className="mt-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="h-4 w-4 shrink-0" />{erreur}
        </p>
      )}
    </div>
  )
}
