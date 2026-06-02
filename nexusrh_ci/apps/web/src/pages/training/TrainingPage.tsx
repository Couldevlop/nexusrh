import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatDate, formatFCFA } from '@/lib/api'
import { BookOpen, Plus, Clock, Users, CheckCircle, Award, FileText, Loader2, UserPlus } from 'lucide-react'

interface Training {
  id: string; title: string; description: string | null
  duration: number | null; duration_unit: string; format: string
  category: string | null; is_fdfp_eligible: boolean
  sessions_count: number; enrollments_count: number; is_active: boolean
}

interface Session {
  id: string; training_id: string; training_title: string
  start_date: string; end_date: string | null; location: string | null
  trainer: string | null; status: string; max_places: number
  enrolled_count: number; category: string | null; is_fdfp_eligible: boolean
  format: string; duration: number | null; duration_unit: string
}

interface Enrollment {
  id: string; training_title: string; session_start: string
  first_name: string; last_name: string
  status: string; completed_at: string | null; location: string | null
}

interface EmployeeLite { id: string; first_name: string; last_name: string }

const FORMAT_LABELS: Record<string, string> = {
  presentiel: 'Présentiel', distanciel: 'Distanciel', hybride: 'Hybride',
}

export default function TrainingPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'catalog' | 'sessions' | 'enrollments' | 'fdfp'>('catalog')
  const [fdfpForm, setFdfpForm] = useState({
    training_title: '', training_id: '', session_date: '',
    employees_count: '1', total_cost: '', provider_name: '', fdfp_code: '',
  })
  const [fdfpSuccess, setFdfpSuccess] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [showNewTraining, setShowNewTraining] = useState(false)
  const [newTraining, setNewTraining] = useState({
    title: '', description: '', duration: '', duration_unit: 'hours',
    format: 'presentiel', category: '', is_fdfp_eligible: false,
  })
  const [selectedTraining, setSelectedTraining] = useState<string>('')
  const [newSession, setNewSession] = useState({
    training_id: '', start_date: '', end_date: '', location: '',
    trainer: '', max_places: '20',
  })
  // Employés sélectionnés à la planification d'une session.
  const [sessionEmployees, setSessionEmployees] = useState<string[]>([])
  // Ajout de participants à une session existante (id de session ciblée).
  const [participantsSession, setParticipantsSession] = useState<string | null>(null)
  const [participantsPick, setParticipantsPick] = useState<string[]>([])

  const { data: employeesData } = useQuery<{ data: EmployeeLite[] }>({
    queryKey: ['training-employees'],
    queryFn: () => api.get('/employees?limit=500').then(r => r.data),
    enabled: showNewSession || participantsSession !== null,
  })
  const employees = employeesData?.data ?? []

  const { data: catalogData } = useQuery<{ data: Training[] }>({
    queryKey: ['training-catalog'],
    queryFn: () => api.get('/training/catalog').then(r => r.data),
  })

  const { data: sessionsData } = useQuery<{ data: Session[] }>({
    queryKey: ['training-sessions'],
    queryFn: () => api.get('/training/sessions').then(r => r.data),
    enabled: tab === 'sessions',
  })

  const { data: enrollmentsData } = useQuery<{ data: Enrollment[] }>({
    queryKey: ['training-enrollments'],
    queryFn: () => api.get('/training/enrollments').then(r => r.data),
    enabled: tab === 'enrollments',
  })

  const createTraining = useMutation({
    mutationFn: (data: typeof newTraining) =>
      api.post('/training/catalog', { ...data, duration: data.duration ? parseInt(data.duration) : undefined }),
    onSuccess: () => {
      setShowNewTraining(false)
      setNewTraining({ title: '', description: '', duration: '', duration_unit: 'hours', format: 'presentiel', category: '', is_fdfp_eligible: false })
      queryClient.invalidateQueries({ queryKey: ['training-catalog'] })
    },
  })

  const createSession = useMutation({
    mutationFn: (data: typeof newSession) =>
      api.post('/training/sessions', {
        ...data,
        max_places: parseInt(data.max_places),
        ...(sessionEmployees.length > 0 ? { employee_ids: sessionEmployees } : {}),
      }),
    onSuccess: () => {
      setShowNewSession(false)
      setNewSession({ training_id: '', start_date: '', end_date: '', location: '', trainer: '', max_places: '20' })
      setSessionEmployees([])
      queryClient.invalidateQueries({ queryKey: ['training-sessions'] })
      queryClient.invalidateQueries({ queryKey: ['training-enrollments'] })
    },
  })

  const addParticipants = useMutation({
    mutationFn: () => api.post(`/training/sessions/${participantsSession}/participants`, { employee_ids: participantsPick }),
    onSuccess: () => {
      setParticipantsSession(null)
      setParticipantsPick([])
      queryClient.invalidateQueries({ queryKey: ['training-sessions'] })
      queryClient.invalidateQueries({ queryKey: ['training-enrollments'] })
    },
  })

  const fdfpMut = useMutation({
    mutationFn: () => api.post('/training/fdfp/request', {
      ...fdfpForm,
      employees_count: parseInt(fdfpForm.employees_count),
      total_cost: parseInt(fdfpForm.total_cost),
    }),
    onSuccess: () => {
      setFdfpSuccess(true)
      setFdfpForm({ training_title: '', training_id: '', session_date: '', employees_count: '1', total_cost: '', provider_name: '', fdfp_code: '' })
      setTimeout(() => setFdfpSuccess(false), 5000)
    },
  })

  const catalog = catalogData?.data ?? []
  const sessions = sessionsData?.data ?? []
  const enrollments = enrollmentsData?.data ?? []
  const fdfpEligible = catalog.filter(t => t.is_fdfp_eligible)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Formations & FDFP</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {catalog.length} formation(s) · {catalog.filter(t => t.is_fdfp_eligible).length} éligibles FDFP
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowNewTraining(true)}
            className="flex items-center gap-2 rounded-lg border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary/5">
            <Plus className="h-4 w-4" /> Nouvelle formation
          </button>
          <button onClick={() => setShowNewSession(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> Planifier une session
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {([
          ['catalog', 'Catalogue'],
          ['sessions', 'Sessions'],
          ['enrollments', 'Inscriptions'],
          ['fdfp', `FDFP Remboursement (${fdfpEligible.length})`],
        ] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Catalogue */}
      {tab === 'catalog' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {catalog.map(training => (
            <div key={training.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{training.title}</h3>
                  {training.category && (
                    <p className="text-xs text-muted-foreground mt-0.5">{training.category}</p>
                  )}
                </div>
                {training.is_fdfp_eligible && (
                  <span className="ml-2 shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                    FDFP
                  </span>
                )}
              </div>
              {training.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{training.description}</p>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                {training.duration && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {training.duration} {training.duration_unit === 'hours' ? 'h' : 'j'}
                  </span>
                )}
                <span>{FORMAT_LABELS[training.format] ?? training.format}</span>
                <span className="flex items-center gap-1">
                  <BookOpen className="h-3 w-3" />{training.sessions_count} session(s)
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setNewSession(p => ({ ...p, training_id: training.id })); setShowNewSession(true) }}
                  className="flex-1 rounded-lg border border-primary px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5"
                >
                  + Planifier session
                </button>
              </div>
            </div>
          ))}
          {catalog.length === 0 && (
            <div className="col-span-3 p-8 text-center text-muted-foreground">
              <BookOpen className="mx-auto mb-2 h-8 w-8 opacity-30" />
              Aucune formation dans le catalogue
            </div>
          )}
        </div>
      )}

      {/* Sessions */}
      {tab === 'sessions' && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">Formation</th>
                <th className="p-4">Date</th>
                <th className="p-4">Lieu / Formateur</th>
                <th className="p-4 text-center">Inscriptions</th>
                <th className="p-4">Format</th>
                <th className="p-4">Statut</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map(s => (
                <tr key={s.id} className="hover:bg-muted/30">
                  <td className="p-4">
                    <p className="font-medium">{s.training_title}</p>
                    {s.category && <p className="text-xs text-muted-foreground">{s.category}</p>}
                    {s.is_fdfp_eligible && (
                      <span className="text-xs text-green-600 font-medium">FDFP éligible</span>
                    )}
                  </td>
                  <td className="p-4">
                    <p>{formatDate(s.start_date)}</p>
                    {s.end_date && <p className="text-xs text-muted-foreground">→ {formatDate(s.end_date)}</p>}
                  </td>
                  <td className="p-4">
                    {s.location && <p>{s.location}</p>}
                    {s.trainer && <p className="text-xs text-muted-foreground">{s.trainer}</p>}
                  </td>
                  <td className="p-4 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Users className="h-3 w-3 text-muted-foreground" />
                      <span>{s.enrolled_count}/{s.max_places}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-primary"
                        style={{ width: `${Math.min(100, (s.enrolled_count / s.max_places) * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td className="p-4">{FORMAT_LABELS[s.format] ?? s.format}</td>
                  <td className="p-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.status === 'planned' ? 'bg-blue-100 text-blue-700' :
                      s.status === 'completed' ? 'bg-green-100 text-green-700' :
                      'bg-muted text-muted-foreground'
                    }`}>{s.status}</span>
                  </td>
                  <td className="p-4 text-right">
                    {s.status === 'planned' && (
                      <button
                        onClick={() => { setParticipantsSession(s.id); setParticipantsPick([]) }}
                        className="inline-flex items-center gap-1 rounded-lg border border-primary px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/5">
                        <UserPlus className="h-3.5 w-3.5" /> Participants
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    <BookOpen className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    Aucune session planifiée
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Inscriptions */}
      {tab === 'enrollments' && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th className="p-4">Employé</th>
                <th className="p-4">Formation</th>
                <th className="p-4">Date session</th>
                <th className="p-4">Lieu</th>
                <th className="p-4">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {enrollments.map(e => (
                <tr key={e.id} className="hover:bg-muted/30">
                  <td className="p-4">
                    <p className="font-medium">{e.first_name} {e.last_name}</p>
                  </td>
                  <td className="p-4">{e.training_title}</td>
                  <td className="p-4">{formatDate(e.session_start)}</td>
                  <td className="p-4 text-muted-foreground">{e.location ?? '—'}</td>
                  <td className="p-4">
                    {e.completed_at ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-green-700">
                        <CheckCircle className="h-3 w-3" /> Terminée
                      </span>
                    ) : (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Inscrit
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {enrollments.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-muted-foreground">
                    <Award className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    Aucune inscription
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* FDFP Remboursement */}
      {tab === 'fdfp' && (
        <div className="space-y-6">
          {/* Explication FDFP */}
          <div className="rounded-xl border border-green-200 bg-green-50 p-5">
            <h2 className="font-semibold text-green-800 mb-2 flex items-center gap-2">
              <Award className="h-4 w-4" /> FDFP — Fonds de Développement de la Formation Professionnelle
            </h2>
            <p className="text-sm text-green-700 mb-3">
              En tant qu'entreprise de plus de 10 salariés, vous versez <strong>0,4 % de votre masse salariale</strong> au FDFP.
              Vous pouvez récupérer une partie de cette contribution en finançant des formations agréées FDFP.
            </p>
            <div className="grid grid-cols-3 gap-3 text-xs">
              {[
                { label: 'Formations éligibles catalogue', value: `${fdfpEligible.length} formations` },
                { label: 'Contribution légale', value: '0,4 % masse salariale' },
                { label: 'Délai remboursement', value: '30–60 jours FDFP' },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white rounded-lg p-3 border border-green-200">
                  <p className="text-muted-foreground">{label}</p>
                  <p className="font-semibold text-green-800 mt-1">{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Formations éligibles */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h3 className="font-semibold">Formations agréées FDFP dans votre catalogue</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                  <th className="p-3">Formation</th>
                  <th className="p-3">Catégorie</th>
                  <th className="p-3">Format</th>
                  <th className="p-3 text-center">Durée</th>
                  <th className="p-3 text-center">Sessions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fdfpEligible.map(t => (
                  <tr key={t.id} className="hover:bg-muted/20">
                    <td className="p-3 font-medium">{t.title}</td>
                    <td className="p-3 text-muted-foreground text-xs">{t.category ?? '—'}</td>
                    <td className="p-3 text-xs">{FORMAT_LABELS[t.format] ?? t.format}</td>
                    <td className="p-3 text-center text-xs">
                      {t.duration ? `${t.duration} ${t.duration_unit === 'hours' ? 'h' : 'j'}` : '—'}
                    </td>
                    <td className="p-3 text-center">{t.sessions_count}</td>
                  </tr>
                ))}
                {fdfpEligible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                      Aucune formation marquée FDFP éligible — cochez "Agréé FDFP" lors de la création
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Formulaire demande remboursement */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <FileText className="h-4 w-4" /> Nouvelle demande de remboursement FDFP
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {[
                { field: 'training_title' as const, label: 'Intitulé formation *', type: 'text', placeholder: 'Ex. Leadership & Management' },
                { field: 'provider_name' as const, label: 'Organisme de formation *', type: 'text', placeholder: 'Ex. CFAO Training CI' },
                { field: 'fdfp_code' as const, label: 'Code agrément FDFP', type: 'text', placeholder: 'Ex. FDFP/CI/2024/1234' },
                { field: 'session_date' as const, label: 'Date de la session *', type: 'date', placeholder: '' },
                { field: 'employees_count' as const, label: 'Nombre de salariés formés *', type: 'number', placeholder: '1' },
                { field: 'total_cost' as const, label: 'Coût total formation (FCFA) *', type: 'number', placeholder: '250000' },
              ].map(({ field, label, type, placeholder }) => (
                <div key={field}>
                  <label className="text-sm font-medium mb-1 block">{label}</label>
                  <input type={type} placeholder={placeholder}
                    value={fdfpForm[field]}
                    onChange={e => setFdfpForm(p => ({ ...p, [field]: e.target.value }))}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none" />
                </div>
              ))}
            </div>

            {fdfpForm.total_cost && parseInt(fdfpForm.total_cost) > 0 && (
              <div className="mt-4 rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-700">
                Montant remboursable estimé (40–60%) : {formatFCFA(Math.floor(parseInt(fdfpForm.total_cost) * 0.5))} FCFA
              </div>
            )}

            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={() => fdfpMut.mutate()}
                disabled={fdfpMut.isPending || !fdfpForm.training_title || !fdfpForm.session_date || !fdfpForm.total_cost}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                {fdfpMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                <FileText className="h-4 w-4" />
                Soumettre la demande FDFP
              </button>
              {fdfpSuccess && (
                <span className="flex items-center gap-1.5 text-sm text-green-600">
                  <CheckCircle className="h-4 w-4" /> Demande enregistrée — en attente de traitement FDFP
                </span>
              )}
              {fdfpMut.isError && (
                <span className="text-sm text-destructive">
                  {(fdfpMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Erreur'}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              La demande sera transmise à votre gestionnaire RH pour validation, puis envoyée au FDFP CI.
              Délai de traitement : 30 à 60 jours ouvrables.
            </p>
          </div>
        </div>
      )}

      {/* Modal nouvelle session */}
      {showNewSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNewSession(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">Planifier une session</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Formation *</label>
                <select value={newSession.training_id}
                  onChange={e => setNewSession(p => ({ ...p, training_id: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                  <option value="">— Sélectionner —</option>
                  {catalog.map(t => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Date début *</label>
                  <input type="date" value={newSession.start_date}
                    onChange={e => setNewSession(p => ({ ...p, start_date: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Date fin</label>
                  <input type="date" value={newSession.end_date}
                    onChange={e => setNewSession(p => ({ ...p, end_date: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Lieu</label>
                <input value={newSession.location} onChange={e => setNewSession(p => ({ ...p, location: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                  placeholder="Salle de formation, Abidjan" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Formateur</label>
                  <input value={newSession.trainer} onChange={e => setNewSession(p => ({ ...p, trainer: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Places max</label>
                  <input type="number" value={newSession.max_places}
                    onChange={e => setNewSession(p => ({ ...p, max_places: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Participants ({sessionEmployees.length} sélectionné{sessionEmployees.length > 1 ? 's' : ''})
                </label>
                <EmployeePicker employees={employees} selected={sessionEmployees} onChange={setSessionEmployees} />
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => { setShowNewSession(false); setSessionEmployees([]) }}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => createSession.mutate(newSession)}
                disabled={!newSession.training_id || !newSession.start_date || createSession.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {createSession.isPending ? 'Création...' : 'Créer la session'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewTraining && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-background p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Nouvelle formation</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Titre <span className="text-destructive">*</span></label>
                <input value={newTraining.title} onChange={e => setNewTraining(p => ({ ...p, title: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  placeholder="Ex : Gestion de la paie CI" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <textarea value={newTraining.description} onChange={e => setNewTraining(p => ({ ...p, description: e.target.value }))}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  placeholder="Objectifs, contenu…" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Durée</label>
                  <input type="number" min="1" value={newTraining.duration}
                    onChange={e => setNewTraining(p => ({ ...p, duration: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Unité</label>
                  <select value={newTraining.duration_unit} onChange={e => setNewTraining(p => ({ ...p, duration_unit: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    <option value="hours">Heures</option>
                    <option value="days">Jours</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Format</label>
                  <select value={newTraining.format} onChange={e => setNewTraining(p => ({ ...p, format: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    <option value="presentiel">Présentiel</option>
                    <option value="e-learning">E-learning</option>
                    <option value="hybride">Hybride</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Catégorie</label>
                  <input value={newTraining.category} onChange={e => setNewTraining(p => ({ ...p, category: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none"
                    placeholder="RH, Technique, Management…" />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <input type="checkbox" id="fdfp" checked={newTraining.is_fdfp_eligible}
                  onChange={e => setNewTraining(p => ({ ...p, is_fdfp_eligible: e.target.checked }))}
                  className="h-4 w-4 rounded border-border accent-primary" />
                <label htmlFor="fdfp" className="text-sm text-muted-foreground cursor-pointer">
                  Éligible FDFP (remboursement possible)
                </label>
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNewTraining(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => createTraining.mutate(newTraining)}
                disabled={!newTraining.title.trim() || createTraining.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {createTraining.isPending ? 'Création...' : 'Créer la formation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal ajout de participants à une session existante */}
      {participantsSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setParticipantsSession(null)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-1">Ajouter des participants</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Sélectionnez les employés à inscrire à cette session.
            </p>
            <EmployeePicker employees={employees} selected={participantsPick} onChange={setParticipantsPick} />
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setParticipantsSession(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => addParticipants.mutate()}
                disabled={participantsPick.length === 0 || addParticipants.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {addParticipants.isPending ? 'Ajout...' : `Inscrire (${participantsPick.length})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Sélecteur multi-employés (recherche + cases à cocher) réutilisé par la
// planification de session et l'ajout de participants.
function EmployeePicker({ employees, selected, onChange }: {
  employees: EmployeeLite[]; selected: string[]; onChange: (ids: string[]) => void
}) {
  const [q, setQ] = useState('')
  const filtered = employees.filter(e =>
    `${e.first_name} ${e.last_name}`.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])
  return (
    <div className="mt-1">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Rechercher un employé…"
        className="mb-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
      <div className="max-h-48 overflow-auto rounded-lg border border-border divide-y divide-border">
        {filtered.map(e => (
          <label key={e.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent">
            <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)}
              className="h-4 w-4 rounded border-border accent-primary" />
            {e.first_name} {e.last_name}
          </label>
        ))}
        {filtered.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Aucun employé.</p>}
      </div>
    </div>
  )
}
