import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'

export interface CategoryScore { category: string; score: number; commentaire: string }
export interface InterviewFeedback {
  disponible: boolean
  message: string | null
  scoreGlobal: number | null
  scoresParCategorie: CategoryScore[]
  pointsForts: string[]
  axesProgres: string[]
  reponsesReperes: Array<{ index: number; question: string; reponseRepere: string }>
}

/** Bande de couleur du score : rouge < 50, ambre < 75, vert ≥ 75. */
export function scoreTone(score: number): { text: string; bar: string; ring: string } {
  if (score >= 75) return { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500', ring: '#10b981' }
  if (score >= 50) return { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500', ring: '#f59e0b' }
  return { text: 'text-red-600 dark:text-red-400', bar: 'bg-red-500', ring: '#ef4444' }
}

/** Position sur l'axe 0-100 de la restitution, bornée. */
function onAxis(score: number): number {
  return Math.max(0, Math.min(100, score))
}

/** Intitulé de section : filet à la couleur du tenant + capitale filée. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="h-3 w-[3px] shrink-0 bg-primary" />
      <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{children}</h3>
    </div>
  )
}

/** Ligne de conduite pointillée entre un intitulé et sa note (usage : relevé de notes). */
function Leader() {
  return <span aria-hidden="true" className="relative -top-1 mx-3 min-w-[1.5rem] flex-1 border-b border-dotted border-muted-foreground/40" />
}

/**
 * Jauge du score global (0-100) : un axe gradué plutôt qu'un anneau. La note se
 * lit à sa position exacte sur la règle, entre les repères 50 et 75 qui délimitent
 * les trois bandes d'appréciation. SVG pur (traits non mis à l'échelle), sans dépendance.
 */
export function ScoreGauge({ score, label }: { score: number; label: string }) {
  const pct = onAxis(score)
  const tone = scoreTone(pct)
  // L'aiguille est rentrée d'un demi-trait aux extrêmes pour ne pas être rognée.
  const needle = Math.max(0.5, Math.min(99.5, pct))
  const minorTicks = [10, 20, 30, 40, 60, 70, 80, 90]

  return (
    <div className="w-full">
      <div className="flex items-baseline">
        <SectionLabel>{label}</SectionLabel>
        <Leader />
        <span aria-hidden="true" className="flex items-baseline gap-1">
          <span className={`text-4xl font-semibold leading-none tracking-[-0.04em] tabular-nums sm:text-5xl ${tone.text}`}>{pct}</span>
          <span className="text-[0.7rem] font-medium tabular-nums text-muted-foreground">/100</span>
        </span>
      </div>

      <svg
        role="img"
        aria-label={`${label} ${pct}/100`}
        viewBox="0 0 100 20"
        preserveAspectRatio="none"
        className="mt-3 h-5 w-full"
      >
        {/* Règle */}
        <rect x="0" y="8" width="100" height="4" className="fill-current text-muted" />
        <rect x="0" y="8" width={pct} height="4" fill={tone.ring} />
        {/* Graduations mineures, sous la règle */}
        {minorTicks.map((x) => (
          <line
            key={x} x1={x} y1="13" x2={x} y2="16"
            className="stroke-current text-muted-foreground/35" strokeWidth="1" vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* Repères de bande 50 et 75 : tracés hors de la règle pour rester lisibles sur le remplissage */}
        {[50, 75].map((x) => (
          <g key={x} className="stroke-current text-muted-foreground/70">
            <line x1={x} y1="1" x2={x} y2="7" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <line x1={x} y1="13" x2={x} y2="19" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {/* Aiguille : la note, à sa position exacte */}
        <line x1={needle} y1="0" x2={needle} y2="20" stroke={tone.ring} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>

      <div aria-hidden="true" className="relative mt-1 h-3 text-[0.625rem] tabular-nums text-muted-foreground">
        <span className="absolute left-0">0</span>
        <span className="absolute left-1/2 -translate-x-1/2">50</span>
        <span className="absolute left-3/4 -translate-x-1/2">75</span>
        <span className="absolute right-0">100</span>
      </div>
    </div>
  )
}

/**
 * Corps de la restitution d'une simulation d'entretien, partagé par la page
 * interne (salarié) et la page publique (candidat). Rend le score global, les
 * scores par catégorie, les forces/axes et les réponses repères. N'inclut ni
 * le titre ni les actions (bouton recommencer, note d'éphémérité) : chaque page
 * les fournit autour.
 *
 * Mise en page : une feuille réglée, pas une pile de cartes — les deux appelants
 * encadrent déjà le composant dans une carte. Toutes les notes se lisent sur le
 * même axe 0-100, dont les seuils 50 et 75 traversent la colonne des catégories.
 */
export function InterviewRestitution({ feedback }: { feedback: InterviewFeedback }) {
  const { t } = useTranslation('interviewSim')

  if (!feedback.disponible) {
    return (
      <p className="border-l-2 border-amber-500 pl-3 text-sm text-amber-700 dark:text-amber-400">{feedback.message}</p>
    )
  }

  const reveal = 'animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-500 motion-reduce:animate-none'
  const section = `py-5 first:pt-0 last:pb-0 ${reveal}`
  const hasStrengths = feedback.pointsForts.length > 0
  const hasImprovements = feedback.axesProgres.length > 0

  return (
    <div className="divide-y divide-border">
      {feedback.scoreGlobal !== null && (
        <section className={section}>
          <ScoreGauge score={feedback.scoreGlobal} label={t('globalScore')} />
        </section>
      )}

      {feedback.scoresParCategorie.length > 0 && (
        <section className={section} style={{ animationDelay: '70ms' }}>
          <SectionLabel>{t('byCategory')}</SectionLabel>
          <div className="relative mt-4 space-y-4">
            {/* Les seuils 50 / 75 filent derrière toute la colonne : les notes s'alignent sur une règle commune. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 right-0">
              <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <span className="absolute inset-y-0 left-3/4 w-px bg-border" />
            </div>
            {feedback.scoresParCategorie.map((s, i) => {
              const tone = scoreTone(s.score)
              return (
                <div key={i} className="relative">
                  <div className="flex items-baseline">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground" title={s.category}>{s.category}</span>
                    <Leader />
                    <span className={`text-sm font-semibold tabular-nums ${tone.text}`}>{s.score}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full bg-muted">
                    <div
                      className={`h-full ${tone.bar} transition-[width] duration-700 ease-out motion-reduce:transition-none`}
                      style={{ width: `${onAxis(s.score)}%` }}
                    />
                  </div>
                  {s.commentaire && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.commentaire}</p>}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {(hasStrengths || hasImprovements) && (
        <section className={section} style={{ animationDelay: '140ms' }}>
          <div className={`grid gap-5 ${hasStrengths && hasImprovements ? 'sm:grid-cols-2' : ''}`}>
            {hasStrengths && (
              <div className="border-l-2 border-emerald-500 pl-4">
                <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">{t('strengths')}</h3>
                <ul className="mt-2.5 space-y-2">
                  {feedback.pointsForts.map((p, i) => (
                    <li key={i} className="grid grid-cols-[0.9rem_minmax(0,1fr)] text-sm leading-relaxed">
                      <span aria-hidden="true" className="select-none font-semibold text-emerald-600 dark:text-emerald-400">+</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasImprovements && (
              <div className="border-l-2 border-amber-500 pl-4">
                <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-400">{t('improvements')}</h3>
                <ul className="mt-2.5 space-y-2">
                  {feedback.axesProgres.map((p, i) => (
                    <li key={i} className="grid grid-cols-[0.9rem_minmax(0,1fr)] text-sm leading-relaxed">
                      <span aria-hidden="true" className="select-none font-semibold text-amber-600 dark:text-amber-400">→</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {feedback.reponsesReperes.length > 0 && (
        <details className={`group ${section}`} style={{ animationDelay: '210ms' }}>
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="h-3 w-[3px] shrink-0 bg-primary" />
            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('modelAnswers')}</span>
            <span className="text-[0.65rem] tabular-nums text-muted-foreground">({feedback.reponsesReperes.length})</span>
            <ChevronDown aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <ol className="mt-4 space-y-4">
            {feedback.reponsesReperes.map((r, i) => (
              <li key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)]">
                <span aria-hidden="true" className="pt-px text-[0.65rem] font-medium tabular-nums text-muted-foreground">
                  {String(r.index + 1).padStart(2, '0')}
                </span>
                <div className="border-l border-border pl-3">
                  <p className="text-sm font-medium text-foreground">{r.question}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{r.reponseRepere}</p>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}
