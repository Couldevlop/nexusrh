import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import {
  Briefcase, Plus, Users, MapPin, ChevronRight,
  CheckCircle, XCircle, ArrowRight,
} from 'lucide-react'

interface Job {
  id: string; title: string; department_name: string | null
  location: string; contract_type: string; salary_min: string | null
  salary_max: string | null; status: string; applications_count: number
  created_at: string
}

interface Application {
  id: string; job_id: string; job_title: string
  first_name: string; last_name: string; email: string; phone: string | null
  stage: string; ai_score: number | null; created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-700',
  closed: 'bg-red-100 text-red-700',
  draft: 'bg-gray-100 text-gray-600',
  paused: 'bg-yellow-100 text-yellow-700',
}

const STAGE_CONFIG: Record<string, { label: string; color: string }> = {
  new:        { label: 'Nouveau',     color: 'bg-blue-100 text-blue-700' },
  screening:  { label: 'Présélection', color: 'bg-purple-100 text-purple-700' },
  interview:  { label: 'Entretien',   color: 'bg-yellow-100 text-yellow-700' },
  test:       { label: 'Test',        color: 'bg-orange-100 text-orange-700' },
  offer:      { label: 'Offre',       color: 'bg-indigo-100 text-indigo-700' },
  hired:      { label: 'Recruté',     color: 'bg-green-100 text-green-700' },
  rejected:   { label: 'Rejeté',      color: 'bg-red-100 text-red-700' },
}

const PIPELINE_STAGES = ['new','screening','interview','test','offer','hired','rejected']

export default function RecruitmentPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'jobs' | 'pipeline'>('jobs')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [newJob, setNewJob] = useState({
    title: '', location: 'Abidjan', contract_type: 'cdi',
    salary_min: '', salary_max: '', description: '', requirements: '', status: 'open',
  })

  const { data: jobsData, isLoading } = useQuery<{ data: Job[] }>({
    queryKey: ['recruitment-jobs'],
    queryFn: () => api.get('/recruitment/jobs').then(r => r.data),
  })

  const { data: appsData } = useQuery<{ data: Application[] }>({
    queryKey: ['recruitment-applications', selectedJob?.id],
    queryFn: () => api.get(`/recruitment/applications${selectedJob ? `?job_id=${selectedJob.id}` : ''}`).then(r => r.data),
    enabled: tab === 'pipeline',
  })

  const createJob = useMutation({
    mutationFn: (data: typeof newJob) => api.post('/recruitment/jobs', data),
    onSuccess: () => {
      setShowNewJob(false)
      setNewJob({ title: '', location: 'Abidjan', contract_type: 'cdi', salary_min: '', salary_max: '', description: '', requirements: '', status: 'open' })
      queryClient.invalidateQueries({ queryKey: ['recruitment-jobs'] })
    },
  })

  const updateStage = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api.patch(`/recruitment/applications/${id}/stage`, { stage }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recruitment-applications'] }),
  })

  const jobs = jobsData?.data ?? []
  const applications = appsData?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Recrutement</h1>
          <p className="text-sm text-muted-foreground mt-1">{jobs.length} offre(s) · {applications.length} candidature(s)</p>
        </div>
        <button
          onClick={() => setShowNewJob(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Nouvelle offre
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['jobs', 'pipeline'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'jobs' ? 'Offres' : 'Pipeline Kanban'}
          </button>
        ))}
      </div>

      {/* Liste des offres */}
      {tab === 'jobs' && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                  <th className="p-4">Poste</th>
                  <th className="p-4">Localisation</th>
                  <th className="p-4">Contrat</th>
                  <th className="p-4">Salaire</th>
                  <th className="p-4 text-center">Candidatures</th>
                  <th className="p-4">Statut</th>
                  <th className="p-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.map(job => (
                  <tr key={job.id} className="hover:bg-muted/30">
                    <td className="p-4">
                      <p className="font-medium">{job.title}</p>
                      {job.department_name && (
                        <p className="text-xs text-muted-foreground">{job.department_name}</p>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <MapPin className="h-3 w-3" />{job.location}
                      </div>
                    </td>
                    <td className="p-4 uppercase text-xs font-medium">{job.contract_type}</td>
                    <td className="p-4">
                      {job.salary_min && job.salary_max
                        ? `${formatFCFA(parseInt(job.salary_min))} – ${formatFCFA(parseInt(job.salary_max))}`
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="p-4 text-center">
                      <span className="inline-flex items-center justify-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <Users className="h-3 w-3" />{job.applications_count}
                      </span>
                    </td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] ?? 'bg-muted'}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="p-4">
                      <button onClick={() => { setSelectedJob(job); setTab('pipeline') }}
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        Voir pipeline <ChevronRight className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground">
                      <Briefcase className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      Aucune offre de recrutement
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Pipeline Kanban */}
      {tab === 'pipeline' && (
        <div className="space-y-4">
          {selectedJob && (
            <div className="flex items-center gap-2 text-sm">
              <button onClick={() => setSelectedJob(null)} className="text-primary hover:underline">
                Toutes les offres
              </button>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{selectedJob.title}</span>
            </div>
          )}
          {!selectedJob && (
            <p className="text-sm text-muted-foreground">
              Toutes les candidatures — sélectionnez une offre pour filtrer
            </p>
          )}
          <div className="flex gap-3 overflow-x-auto pb-4">
            {PIPELINE_STAGES.map(stage => {
              const stageApps = applications.filter(a => a.stage === stage)
              const isOver = dragOverStage === stage
              return (
                <div
                  key={stage}
                  className="flex-shrink-0 w-60"
                  onDragOver={e => { e.preventDefault(); setDragOverStage(stage) }}
                  onDragLeave={() => setDragOverStage(null)}
                  onDrop={e => {
                    e.preventDefault()
                    if (draggedId && draggedId !== stage) {
                      updateStage.mutate({ id: draggedId, stage })
                    }
                    setDraggedId(null)
                    setDragOverStage(null)
                  }}
                >
                  <div className={`rounded-t-lg px-3 py-2 flex items-center justify-between ${STAGE_CONFIG[stage]?.color ?? ''}`}>
                    <span className="text-xs font-semibold">{STAGE_CONFIG[stage]?.label}</span>
                    <span className="rounded-full bg-white/50 px-1.5 py-0.5 text-xs font-bold">{stageApps.length}</span>
                  </div>
                  <div className={`rounded-b-lg min-h-[140px] space-y-2 p-2 border border-t-0 transition-colors ${isOver ? 'bg-primary/5 border-primary border-dashed' : 'bg-muted/20 border-border'}`}>
                    {stageApps.map(app => (
                      <div
                        key={app.id}
                        draggable
                        onDragStart={() => setDraggedId(app.id)}
                        onDragEnd={() => { setDraggedId(null); setDragOverStage(null) }}
                        className={`rounded-lg border bg-card p-3 shadow-sm cursor-grab active:cursor-grabbing select-none transition-opacity ${draggedId === app.id ? 'opacity-40' : 'opacity-100'}`}
                      >
                        <p className="text-sm font-medium">{app.first_name} {app.last_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{app.email}</p>
                        {app.job_title && !selectedJob && (
                          <p className="text-xs text-primary mt-1 truncate">{app.job_title}</p>
                        )}
                        {app.ai_score !== null && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                              <div className="h-1.5 rounded-full bg-primary" style={{ width: `${app.ai_score}%` }} />
                            </div>
                            <span className="text-xs font-medium text-muted-foreground">{app.ai_score}%</span>
                          </div>
                        )}
                        <div className="mt-2 flex gap-2 border-t pt-2">
                          <button onClick={() => updateStage.mutate({ id: app.id, stage: 'hired' })}
                            className="flex items-center gap-0.5 text-xs text-green-600 hover:text-green-700 font-medium">
                            <CheckCircle className="h-3 w-3" /> Recruter
                          </button>
                          <span className="text-muted-foreground">·</span>
                          <button onClick={() => updateStage.mutate({ id: app.id, stage: 'rejected' })}
                            className="flex items-center gap-0.5 text-xs text-red-500 hover:text-red-600 font-medium">
                            <XCircle className="h-3 w-3" /> Rejeter
                          </button>
                        </div>
                      </div>
                    ))}
                    {stageApps.length === 0 && (
                      <div className={`flex items-center justify-center h-20 text-xs rounded-lg border border-dashed ${isOver ? 'border-primary text-primary' : 'border-muted-foreground/30 text-muted-foreground'}`}>
                        {isOver ? 'Déposer ici' : 'Vide'}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal nouvelle offre */}
      {showNewJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNewJob(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">Nouvelle offre d'emploi</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Titre du poste *</label>
                <input value={newJob.title} onChange={e => setNewJob(p => ({ ...p, title: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Ex: Chauffeur Senior" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Localisation</label>
                  <input value={newJob.location} onChange={e => setNewJob(p => ({ ...p, location: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Type de contrat</label>
                  <select value={newJob.contract_type} onChange={e => setNewJob(p => ({ ...p, contract_type: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                    <option value="cdi">CDI</option>
                    <option value="cdd">CDD</option>
                    <option value="stage">Stage</option>
                    <option value="apprentissage">Apprentissage</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Salaire min (FCFA)</label>
                  <input type="number" value={newJob.salary_min} onChange={e => setNewJob(p => ({ ...p, salary_min: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="150000" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Salaire max (FCFA)</label>
                  <input type="number" value={newJob.salary_max} onChange={e => setNewJob(p => ({ ...p, salary_max: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="250000" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <textarea value={newJob.description} onChange={e => setNewJob(p => ({ ...p, description: e.target.value }))}
                  rows={3} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Prérequis</label>
                <textarea value={newJob.requirements} onChange={e => setNewJob(p => ({ ...p, requirements: e.target.value }))}
                  rows={2} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none" />
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNewJob(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => createJob.mutate(newJob)} disabled={!newJob.title || createJob.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {createJob.isPending ? 'Création...' : 'Créer l\'offre'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
