import { useTranslation } from 'react-i18next'

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
  if (score >= 75) return { text: 'text-emerald-600', bar: 'bg-emerald-500', ring: '#10b981' }
  if (score >= 50) return { text: 'text-amber-600', bar: 'bg-amber-500', ring: '#f59e0b' }
  return { text: 'text-red-600', bar: 'bg-red-500', ring: '#ef4444' }
}

/** Jauge circulaire du score global (0-100). SVG pur, sans dépendance. */
export function ScoreGauge({ score, label }: { score: number; label: string }) {
  const r = 52
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const tone = scoreTone(pct)
  return (
    <div className="flex flex-col items-center">
      <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label={`${label} ${pct}/100`}>
        <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/30" />
        <circle
          cx="64" cy="64" r={r} fill="none" stroke={tone.ring} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100}
          transform="rotate(-90 64 64)" style={{ transition: 'stroke-dashoffset 700ms ease' }}
        />
        <text x="64" y="60" textAnchor="middle" className={`fill-current ${tone.text}`} style={{ fontSize: 30, fontWeight: 700 }}>{pct}</text>
        <text x="64" y="82" textAnchor="middle" className="fill-current text-muted-foreground" style={{ fontSize: 11 }}>/ 100</text>
      </svg>
      <span className="mt-1 text-sm font-medium text-muted-foreground">{label}</span>
    </div>
  )
}

/**
 * Corps de la restitution d'une simulation d'entretien, partagé par la page
 * interne (salarié) et la page publique (candidat). Rend le score global, les
 * scores par catégorie, les forces/axes et les réponses repères. N'inclut ni
 * le titre ni les actions (bouton recommencer, note d'éphémérité) : chaque page
 * les fournit autour.
 */
export function InterviewRestitution({ feedback }: { feedback: InterviewFeedback }) {
  const { t } = useTranslation('interviewSim')

  if (!feedback.disponible) return <p className="text-amber-600">{feedback.message}</p>

  return (
    <div className="space-y-5">
      {feedback.scoreGlobal !== null && (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
          <ScoreGauge score={feedback.scoreGlobal} label={t('globalScore')} />
          {feedback.scoresParCategorie.length > 0 && (
            <div className="flex-1 space-y-3 self-stretch">
              <h3 className="text-sm font-semibold text-muted-foreground">{t('byCategory')}</h3>
              {feedback.scoresParCategorie.map((s, i) => {
                const tone = scoreTone(s.score)
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{s.category}</span>
                      <span className={`font-semibold ${tone.text}`}>{s.score}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(0, Math.min(100, s.score))}%`, transition: 'width 700ms ease' }} />
                    </div>
                    {s.commentaire && <p className="text-xs text-muted-foreground">{s.commentaire}</p>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
          <h3 className="mb-2 font-medium text-emerald-700">{t('strengths')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{feedback.pointsForts.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
          <h3 className="mb-2 font-medium text-amber-700">{t('improvements')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{feedback.axesProgres.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      </div>

      {feedback.reponsesReperes.length > 0 && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">{t('modelAnswers')}</summary>
          <div className="mt-3 space-y-3">
            {feedback.reponsesReperes.map((r, i) => (
              <div key={i} className="text-sm">
                <p className="font-medium">{r.question}</p>
                <p className="text-muted-foreground">{r.reponseRepere}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
