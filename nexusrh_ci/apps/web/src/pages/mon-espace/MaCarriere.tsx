import { useQuery } from '@tanstack/react-query'
import { api, formatDate } from '@/lib/api'
import { Star, Briefcase, Calendar, Award, TrendingUp } from 'lucide-react'

interface Evaluation {
  id: string; type: string; year: number; status: string
  global_score: string | null; performance_score: string | null
  skills_score: string | null
  evaluator_first_name: string | null; evaluator_last_name: string | null
  created_at: string; completed_at: string | null
  notes: string | null
}

interface Skill {
  skill_name: string; category: string | null
  level: number; target_level: number | null
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  draft:       { label: 'Planifié',   color: 'bg-gray-100 text-gray-600' },
  in_progress: { label: 'En cours',   color: 'bg-yellow-100 text-yellow-700' },
  completed:   { label: 'Finalisé',   color: 'bg-green-100 text-green-700' },
}

const TYPE_LABEL: Record<string, string> = {
  annual:     'Entretien annuel',
  mid_year:   'Point mi-année',
  trial_end:  'Fin de période d\'essai',
  departure:  'Entretien de départ',
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  if (!value) return null
  const pct = Math.round((value / 5) * 100)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value}/5</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function MaCarriere() {
  const { data: evalsData, isLoading: loadingEvals } = useQuery<{ data: Evaluation[] }>({
    queryKey: ['my-evaluations'],
    queryFn: () => api.get('/careers/my-evaluations').then(r => r.data),
  })

  const { data: skillsData } = useQuery<{ data: Skill[] }>({
    queryKey: ['my-skills'],
    queryFn: () => api.get('/careers/my-skills').then(r => r.data),
  })

  const evaluations = evalsData?.data ?? []
  const skills = skillsData?.data ?? []

  const upcoming = evaluations.filter(e => e.status !== 'completed')
  const history  = evaluations.filter(e => e.status === 'completed')

  const skillsByCategory = skills.reduce<Record<string, Skill[]>>((acc, s) => {
    const cat = s.category ?? 'Général'
    acc[cat] = acc[cat] ?? []
    acc[cat].push(s)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ma Carrière</h1>
        <p className="text-sm text-muted-foreground mt-1">Entretiens, compétences et évolution professionnelle</p>
      </div>

      {/* Entretiens à venir */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-primary" />
          Entretiens à venir
        </h2>
        {loadingEvals ? (
          <div className="flex justify-center py-4">
            <div className="h-5 w-5 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun entretien planifié</p>
        ) : (
          <div className="space-y-3">
            {upcoming.map(ev => (
              <div key={ev.id} className="flex items-center justify-between rounded-lg border border-border p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Briefcase className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">{TYPE_LABEL[ev.type] ?? ev.type}</p>
                    <p className="text-xs text-muted-foreground">
                      {ev.evaluator_first_name
                        ? `Évaluateur : ${ev.evaluator_first_name} ${ev.evaluator_last_name}`
                        : 'Évaluateur non assigné'} · {ev.year}
                    </p>
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_LABEL[ev.status]?.color ?? 'bg-muted'}`}>
                  {STATUS_LABEL[ev.status]?.label ?? ev.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Historique entretiens */}
      {history.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Star className="h-4 w-4 text-yellow-500" />
            Historique des entretiens
          </h2>
          <div className="space-y-4">
            {history.map(ev => (
              <div key={ev.id} className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">{TYPE_LABEL[ev.type] ?? ev.type} — {ev.year}</p>
                    {ev.completed_at && (
                      <p className="text-xs text-muted-foreground">Finalisé le {formatDate(ev.completed_at)}</p>
                    )}
                  </div>
                  {ev.global_score && (
                    <div className="flex items-center gap-1">
                      {[1,2,3,4,5].map(i => (
                        <Star key={i} className={`h-4 w-4 ${i <= Math.round(parseFloat(ev.global_score!)) ? 'fill-yellow-400 text-yellow-400' : 'text-muted'}`} />
                      ))}
                      <span className="ml-1 text-sm font-bold">{parseFloat(ev.global_score).toFixed(1)}/5</span>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <ScoreBar label="Performance" value={ev.performance_score ? parseFloat(ev.performance_score) : null} />
                  <ScoreBar label="Compétences" value={ev.skills_score ? parseFloat(ev.skills_score) : null} />
                </div>
                {ev.notes && (
                  <p className="text-xs text-muted-foreground border-t border-border pt-2">{ev.notes}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compétences */}
      {skills.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Award className="h-4 w-4 text-purple-500" />
            Mes compétences
          </h2>
          <div className="space-y-5">
            {Object.entries(skillsByCategory).map(([cat, catSkills]) => (
              <div key={cat}>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">{cat}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {catSkills.map(sk => (
                    <div key={sk.skill_name} className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="font-medium">{sk.skill_name}</span>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Niveau {sk.level}/5</span>
                          {sk.target_level && sk.target_level > sk.level && (
                            <span className="flex items-center gap-0.5 text-primary">
                              <TrendingUp className="h-3 w-3" />
                              Cible {sk.target_level}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="relative h-2 rounded-full bg-muted overflow-hidden">
                        <div className="absolute h-full rounded-full bg-primary" style={{ width: `${(sk.level / 5) * 100}%` }} />
                        {sk.target_level && (
                          <div className="absolute top-0 h-full w-0.5 bg-primary/40"
                            style={{ left: `${(sk.target_level / 5) * 100}%` }} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {skills.length === 0 && history.length === 0 && !loadingEvals && (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
          <Briefcase className="mx-auto mb-3 h-10 w-10 opacity-30" />
          <p className="font-medium">Aucun entretien ni compétence enregistrés</p>
          <p className="text-sm mt-1">Vos entretiens et compétences apparaîtront ici</p>
        </div>
      )}
    </div>
  )
}
