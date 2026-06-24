import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AxiosError } from 'axios'
import { api, formatDate } from '@/lib/api'
import { BookOpen, Clock, MapPin, CheckCircle, Info, Loader2, Download } from 'lucide-react'

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

export default function MaFormation() {
  const { t } = useTranslation('monEspace')
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'catalog' | 'enrolled'>('enrolled')
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const formatLabel = (f: string) => t(`training.formats.${f}`, { defaultValue: f })
  const unitLabel = (u: string) => (u === 'hours' ? t('training.unitHours') : t('training.unitDays'))

  // Auto-inscription self-service : on n'envoie QUE le session_id ; l'API dérive
  // l'employee_id du token (OWASP A01 — jamais de confiance dans un id du body).
  const enrollMut = useMutation({
    mutationFn: (sessionId: string) =>
      api.post('/training/enroll', { session_id: sessionId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-my-enrollments'] })
      queryClient.invalidateQueries({ queryKey: ['training-sessions-emp'] })
      setFeedback({ type: 'success', text: t('training.enrollSuccess') })
    },
    onError: (err: unknown) => {
      const apiErr = err instanceof AxiosError
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined
      setFeedback({ type: 'error', text: apiErr ?? t('training.enrollError') })
    },
  })

  // FRM-006 — désinscription self-service
  const unenrollMut = useMutation({
    mutationFn: (enrollmentId: string) => api.delete(`/training/enroll/${enrollmentId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-my-enrollments'] })
      queryClient.invalidateQueries({ queryKey: ['training-sessions-emp'] })
      setFeedback({ type: 'success', text: t('training.unenrollSuccess', { defaultValue: 'Désinscription enregistrée.' }) })
    },
    onError: (err: unknown) => {
      const apiErr = err instanceof AxiosError
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined
      setFeedback({ type: 'error', text: apiErr ?? t('training.unenrollError', { defaultValue: 'Désinscription impossible.' }) })
    },
  })

  // FRM-007 — téléchargement de l'attestation PDF (formation terminée)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const downloadAttestation = async (enrollmentId: string) => {
    setDownloadingId(enrollmentId)
    try {
      const res = await api.get(`/training/enrollments/${enrollmentId}/attestation`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `attestation_${enrollmentId.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      const apiErr = err instanceof AxiosError
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined
      setFeedback({ type: 'error', text: apiErr ?? t('training.attestationError', { defaultValue: 'Attestation indisponible.' }) })
    } finally {
      setDownloadingId(null)
    }
  }

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

  const catalog = catalogData?.data ?? []
  const sessions = sessionsData?.data ?? []
  const enrollments = enrollmentsData?.data ?? []
  const upcoming = enrollments.filter(e => !e.completed_at)
  const past = enrollments.filter(e => e.completed_at)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('training.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('training.subtitle', { upcoming: upcoming.length, past: past.length })}
        </p>
      </div>

      {feedback && (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
            feedback.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <span>{feedback.text}</span>
          <button onClick={() => setFeedback(null)} className="text-xs opacity-70 hover:opacity-100">
            {t('common.cancel')}
          </button>
        </div>
      )}

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['enrolled', 'catalog'] as const).map(tabKey => (
          <button key={tabKey} onClick={() => setTab(tabKey)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === tabKey ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {tabKey === 'enrolled' ? t('training.tabEnrolled') : t('training.tabCatalog')}
          </button>
        ))}
      </div>

      {/* Mes inscriptions */}
      {tab === 'enrolled' && (
        <div className="space-y-4">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t('training.upcoming')}</h2>
              <div className="grid gap-3">
                {upcoming.map(e => (
                  <div key={e.id} className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium">{e.training_title}</h3>
                        {e.category && <p className="text-xs text-muted-foreground">{e.category}</p>}
                      </div>
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">{t('training.enrolled')}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />{formatDate(e.session_start)}
                        {e.session_end && <> → {formatDate(e.session_end)}</>}
                      </span>
                      {e.location && (
                        <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{e.location}</span>
                      )}
                      <span>{formatLabel(e.format)}</span>
                      {e.duration && <span>{e.duration} {unitLabel(e.duration_unit)}</span>}
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={() => unenrollMut.mutate(e.id)}
                        disabled={unenrollMut.isPending}
                        className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        {unenrollMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : t('training.unenroll', { defaultValue: 'Annuler' })}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {past.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t('training.completed')}</h2>
              <div className="grid gap-3">
                {past.map(e => (
                  <div key={e.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium">{e.training_title}</h3>
                        <p className="text-xs text-muted-foreground">{formatDate(e.session_start)}</p>
                      </div>
                      <span className="flex items-center gap-1 text-xs font-medium text-green-700">
                        <CheckCircle className="h-3.5 w-3.5" /> {t('training.completedTag')}
                      </span>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={() => downloadAttestation(e.id)}
                        disabled={downloadingId === e.id}
                        className="flex items-center gap-1 rounded-lg border border-primary/30 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/5 disabled:opacity-50"
                      >
                        {downloadingId === e.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Download className="h-3 w-3" />}
                        {t('training.downloadAttestation', { defaultValue: 'Télécharger attestation' })}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {enrollments.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              <BookOpen className="mx-auto mb-2 h-8 w-8 opacity-30" />
              <p className="mb-3">{t('training.noEnrollments')}</p>
              <button onClick={() => setTab('catalog')}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                {t('training.viewCatalog')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Catalogue */}
      {tab === 'catalog' && (
        <div className="space-y-6">
          <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('training.catalogInfo')}</span>
          </div>
          <p className="text-sm text-muted-foreground">{t('training.sessionsPlanned', { count: sessions.length })}</p>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              <BookOpen className="mx-auto mb-2 h-8 w-8 opacity-30" />
              {t('training.noSessions')}
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
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{t('training.full')}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />{formatDate(s.start_date)}
                      </span>
                      {s.location && (
                        <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{s.location}</span>
                      )}
                      {s.duration && <span>{s.duration} {unitLabel(s.duration_unit)}</span>}
                      <span>{formatLabel(s.format)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs">
                        <div className="h-1.5 w-24 rounded-full bg-muted">
                          <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(s.enrolled_count / s.max_places) * 100}%` }} />
                        </div>
                        <span className="text-muted-foreground">{t('training.placesCount', { enrolled: s.enrolled_count, max: s.max_places })}</span>
                      </div>
                      {isEnrolled ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                          <CheckCircle className="h-3.5 w-3.5" /> {t('training.enrolled')}
                        </span>
                      ) : !isFull ? (
                        <button
                          onClick={() => { setFeedback(null); enrollMut.mutate(s.id) }}
                          disabled={enrollMut.isPending}
                          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                        >
                          {enrollMut.isPending && enrollMut.variables === s.id && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          )}
                          {t('training.enroll')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
