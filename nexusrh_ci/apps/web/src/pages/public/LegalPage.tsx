/**
 * Pages légales publiques : mentions légales, confidentialité, conditions
 * d'utilisation, cookies. Un seul composant, quatre documents.
 *
 * Le paramètre d'URL est validé contre une liste fermée : un document inconnu
 * renvoie à l'accueil plutôt que d'afficher des clés de traduction brutes.
 * Aucun appel API — ces pages sont du contenu statique.
 */
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useParams } from 'react-router-dom'

/** Liste fermée : identifiant d'URL → sections publiées, dans l'ordre. */
const DOCS = {
  'mentions-legales':   { key: 'notice',  sections: ['s1', 's2', 's3', 's4', 's5', 's6'] },
  'confidentialite':    { key: 'privacy', sections: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] },
  'conditions':         { key: 'terms',   sections: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] },
  'cookies':            { key: 'cookies', sections: ['s1', 's2', 's3', 's4'] },
} as const

export type LegalSlug = keyof typeof DOCS
export const LEGAL_SLUGS = Object.keys(DOCS) as LegalSlug[]

export default function LegalPage() {
  const { t } = useTranslation('legal')
  const { doc } = useParams<{ doc: string }>()

  const entry = doc && doc in DOCS ? DOCS[doc as LegalSlug] : null
  if (!entry) return <Navigate to="/" replace />

  const base = `docs.${entry.key}`

  return (
    <div className="min-h-screen bg-[#0B1014] text-[#E6EDF3]">
      <div className="border-b border-white/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <Link to="/" className="flex items-center gap-3 text-sm font-medium text-[#93A4B1] transition-colors hover:text-white">
            <span aria-hidden>←</span> {t('backHome')}
          </Link>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#93A4B1]">NexusRH CI</span>
        </div>
      </div>

      <article className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight">{t(`${base}.title`)}</h1>
        <p className="mt-4 text-base leading-relaxed text-[#93A4B1]">{t(`${base}.lead`)}</p>
        <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.16em] text-[#93A4B1]">
          {t('updated')} — {t('updatedValue')}
        </p>

        <div className="mt-12 space-y-10">
          {entry.sections.map((s, i) => (
            <section key={s}>
              <h2 className="flex items-baseline gap-3 text-lg font-semibold tracking-tight">
                <span className="font-mono text-xs text-[#22D3EE]">{String(i + 1).padStart(2, '0')}</span>
                {t(`${base}.${s}.h`)}
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-[#B7C4CE]">{t(`${base}.${s}.p`)}</p>
            </section>
          ))}
        </div>

        <p className="mt-14 border-t border-white/10 pt-6 text-xs leading-relaxed text-[#7C8B98]">
          {t('disclaimer')}
        </p>
      </article>
    </div>
  )
}
