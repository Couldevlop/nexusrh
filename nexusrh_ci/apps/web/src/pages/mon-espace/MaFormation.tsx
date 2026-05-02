import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatDate } from '@/lib/api'
import { BookOpen, Clock, MapPin, CheckCircle, Plus } from 'lucide-react'

interface Training {
  id: string; title: string; description: string | null
  duration: number | null; duration_unit: string; format: string
  category: string | null; is_fdfp_eligible: boolean
  sessions_count: number
}

interface Session {
  id: string; training_id: string; training_title: string
  start_date: string; end_date: string | null; location: string | null
  trainer: string | null; max_places: number; enrolled_count: number
  category: string | null; format: string; duration: number | null; duration_unit: string
}

interface Enrollment {
  id: string; training_title: string; session_start: string
  session_end: string | null; location: string | null; trainer: string | null
  category: string | null; status: string; completed_at: string | null
  duration: number | null; duration_unit: string; format: string
}

const FORMAT_LABELS: Record<string, string> = {
  presentiel: 'Présentiel', distanciel: 'Distanciel', hybride: 'Hybride',
}

export default function MaFormation() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'catalog' | 'enrolled'>('enrolled')
  const [enrollingSession, setEnrollingSession] = useState<string | null>(null)

  const { data: catalogData } = useQuery<{ data: Training[] }>({
    queryKey: ['training-catalog-emp'],
    queryFn: () => api.get('/training/catalog').then(r => r.data),
    enabled: tab === 'catalog',
  })

  const { data: sessionsData } = useQuery<{ data: Session[] }>({
    queryKey: ['training-sessions-emp'],
    queryFn: () => api.get('/training/sessions?status=planned').then(r => r.data),
    enabled: tab === 'catalog',
  })

  const { data: enrollmentsData } = useQuery<{ data: Enrollment[] }>({
    queryKey: ['training-my-enrollments'],
    queryFn: () => api.get('/training/my-enrollments').then(r => r.data),
  })

  const enrollMut = useMutation({
    mutationFn: (session_id: string) => api.post('/training/enroll', { session_id }),
    onSuccess: () => {
      setEnrollingSession(null)
      queryClient.invalidateQueries({ queryKey: ['training-my-enrollments'] })
      queryClient.invalidateQueries({ queryKey: ['training-sessions-emp'] })
    },
  })

  const catalog = catalogData?.data ?? []
  const sessions = sessionsData?.data ?? []
  const enrollments = enrollmentsData?.data ?? []
  const upcoming = enrollments.filter(e => !e.completed_at)
  const past = enrollments.filter(e => e.completed_at)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ma Formation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {upcoming.length} inscription(s) à venir · {past.length} terminée(s)
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['enrolled', 'catalog'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'enrolled' ? 'Mes inscriptions' : 'Catalogue & Sessions'}
          </button>
        ))}
      </div>

      {/* Mes inscriptions */}
      {tab === 'enrolled' && (
        <div className="space-y-4">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">À venir</h2>
              <div className="grid gap-3">
                {upcoming.map(e => (
                  <div key={e.id} className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium">{e.training_title}</h3>
                        {e.category && <p className="text-xs text-muted-foreground">{e.category}</p>}
                      </div>
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Inscrit</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />{formatDate(e.session_start)}
                        {e.session_end && <> → {formatDate(e.session_end)}</>}
                      </span>
                      {e.location && (
                        <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{e.location}</span>
                      )}
                      <span>{FORMAT_LABELS[e.format] ?? e.format}</span>
                      {e.duration && <span>{e.duration} {e.duration_unit === 'hours' ? 'h' : 'j'}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {past.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Terminées</h2>
              <div className="grid gap-3">
                {past.map(e => (
                  <div key={e.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium">{e.training_title}</h3>
                        <p className="text-xs text-muted-foreground">{formatDate(e.session_start)}</p>
                      </div>
                      <span className="flex items-center gap-1 text-xs font-medium text-green-700">
                        <CheckCircle className="h-3.5 w-3.5" /> Terminée
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {enrollments.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              <BookOpen className="mx-auto mb-2 h-8 w-8 opacity-30" />
              <p className="mb-3">Aucune inscription pour le moment.</p>
              <button onClick={() => setTab('catalog')}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                Voir le catalogue
              </button>
            </div>
          )}
        </div>
      )}

      {/* Catalogue */}
      {tab === 'catalog' && (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            {sessions.length} session(s) disponible(s) · Cliquez pour vous inscrire
          </p>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              <BookOpen className="mx-auto mb-2 h-8 w-8 opacity-30" />
              Aucune session planifiée pour le moment.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {sessions.map(s => {
                const isFull = s.enrolled_count >= s.max_places
                const isEnrolled = enrollments.some(e => e.training_title === s.training_title && !e.completed_at)
                return (
                  <div key={s.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium">{s.training_title}</h3>
                        {s.category && <p className="text-xs text-muted-foreground">{s.category}</p>}
                      </div>
                      {isFull && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">Complet</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />{formatDate(s.start_date)}
                      </span>
                      {s.location && (
                        <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{s.location}</span>
                      )}
                      {s.duration && <span>{s.duration} {s.duration_unit === 'hours' ? 'h' : 'j'}</span>}
                      <span>{FORMAT_LABELS[s.format] ?? s.format}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs">
                        <div className="h-1.5 w-24 rounded-full bg-muted">
                          <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(s.enrolled_count / s.max_places) * 100}%` }} />
                        </div>
                        <span className="text-muted-foreground">{s.enrolled_count}/{s.max_places} places</span>
                      </div>
                      {isEnrolled ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                          <CheckCircle className="h-3.5 w-3.5" /> Inscrit
                        </span>
                      ) : (
                        <button
                          onClick={() => setEnrollingSession(s.id)}
                          disabled={isFull}
                          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
                          <Plus className="h-3 w-3" /> S'inscrire
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Confirmation inscription */}
      {enrollingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setEnrollingSession(null)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-2">Confirmer l'inscription</h3>
            <p className="text-sm text-muted-foreground mb-5">
              Voulez-vous vous inscrire à cette session de formation ?
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEnrollingSession(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => enrollMut.mutate(enrollingSession)} disabled={enrollMut.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {enrollMut.isPending ? 'Inscription...' : 'Confirmer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
