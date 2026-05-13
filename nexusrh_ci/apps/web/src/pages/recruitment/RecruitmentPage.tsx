import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { api, formatFCFA } from '@/lib/api'
import {
  Briefcase, Plus, Users, MapPin, ChevronRight, Eye,
  CheckCircle, XCircle, ArrowRight, Sparkles, Upload, Globe, Lock,
} from 'lucide-react'

interface Department { id: string; name: string }

interface Job {
  id: string; title: string; department_name: string | null
  department_id: string | null
  location: string; contract_type: string; salary_min: string | null
  salary_max: string | null; status: string; applications_count: number
  visibility?: 'external' | 'internal' | 'both'
  target_departments?: string[]
  target_job_levels?: string[]
  target_min_seniority_months?: number | null
  created_at: string
}

interface Application {
  id: string; job_id: string; job_title: string
  first_name: string; last_name: string; email: string; phone: string | null
  stage: string; ai_score: number | null
  ai_recommendation?: string | null
  ai_match_percentage?: number | null
  ai_summary?: string | null
  ai_strengths?: string[]
  ai_gaps?: string[]
  ai_red_flags?: string[]
  ai_model_used?: string | null
  cv_text?: string | null
  source?: string | null
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-700',
  closed: 'bg-red-100 text-red-700',
  draft: 'bg-gray-100 text-gray-600',
  paused: 'bg-yellow-100 text-yellow-700',
}

const VISIBILITY_CONFIG: Record<string, { label: string; color: string; icon: typeof Globe }> = {
  external: { label: 'Externe',       color: 'bg-blue-100 text-blue-700',     icon: Globe },
  internal: { label: 'Interne',       color: 'bg-purple-100 text-purple-700', icon: Lock },
  both:     { label: 'Mixte',         color: 'bg-teal-100 text-teal-700',     icon: Eye  },
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
const JOB_LEVELS = ['cadre', 'agent_maitrise', 'employe', 'ouvrier']
const JOB_LEVEL_LABELS: Record<string, string> = {
  cadre:          'Cadre',
  agent_maitrise: 'Agent de maîtrise',
  employe:        'Employé',
  ouvrier:        'Ouvrier',
}

const REC_COLORS: Record<string, string> = {
  strong_yes: 'bg-green-100 text-green-800',
  yes:        'bg-emerald-100 text-emerald-700',
  maybe:      'bg-yellow-100 text-yellow-800',
  no:         'bg-red-100 text-red-800',
}
const REC_LABELS: Record<string, string> = {
  strong_yes: 'Très favorable',
  yes:        'Favorable',
  maybe:      'À étudier',
  no:         'Défavorable',
}

interface NewJobForm {
  title: string
  department_id: string
  location: string
  contract_type: string
  salary_min: string
  salary_max: string
  description: string
  requirements: string
  status: string
  visibility: 'external' | 'internal' | 'both'
  target_departments: string[]
  target_job_levels: string[]
  target_min_seniority_months: string
}

const EMPTY_FORM: NewJobForm = {
  title: '', department_id: '',
  location: 'Abidjan', contract_type: 'cdi',
  salary_min: '', salary_max: '',
  description: '', requirements: '',
  status: 'open', visibility: 'external',
  target_departments: [], target_job_levels: [],
  target_min_seniority_months: '',
}

export default function RecruitmentPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'jobs' | 'pipeline'>('jobs')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [selectedApp, setSelectedApp] = useState<Application | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [newJob, setNewJob] = useState<NewJobForm>(EMPTY_FORM)

  const { data: jobsData, isLoading } = useQuery<{ data: Job[] }>({
    queryKey: ['recruitment-jobs'],
    queryFn: () => api.get('/recruitment/jobs').then(r => r.data),
  })

  const { data: appsData } = useQuery<{ data: Application[] }>({
    queryKey: ['recruitment-applications', selectedJob?.id],
    queryFn: () => api.get(`/recruitment/applications${selectedJob ? `?job_id=${selectedJob.id}` : ''}`).then(r => r.data),
    enabled: tab === 'pipeline',
  })

  const { data: deptData } = useQuery<{ data: Department[] }>({
    queryKey: ['recruitment-departments'],
    queryFn: () => api.get('/employees/departments').then(r => r.data).catch(() => ({ data: [] })),
  })

  const { data: aiCaps } = useQuery<{ claude: boolean; mistral: boolean }>({
    queryKey: ['recruitment-ai-caps'],
    queryFn: () => api.get('/recruitment/ai/capabilities').then(r => r.data),
  })

  const createJob = useMutation({
    mutationFn: (data: NewJobForm) => api.post('/recruitment/jobs', {
      ...data,
      salary_min: data.salary_min ? parseInt(data.salary_min) : null,
      salary_max: data.salary_max ? parseInt(data.salary_max) : null,
      department_id: data.department_id || null,
      target_departments: data.visibility === 'external' ? [] : data.target_departments,
      target_job_levels:  data.visibility === 'external' ? [] : data.target_job_levels,
      target_min_seniority_months: data.visibility === 'external' || !data.target_min_seniority_months
        ? null : parseInt(data.target_min_seniority_months),
    }),
    onSuccess: () => {
      setShowNewJob(false)
      setNewJob(EMPTY_FORM)
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
  const departments = deptData?.data ?? []

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

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['jobs', 'pipeline'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'jobs' ? 'Offres' : 'Pipeline Kanban'}
          </button>
        ))}
      </div>

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
                  <th className="p-4">Visibilité</th>
                  <th className="p-4">Localisation</th>
                  <th className="p-4">Contrat</th>
                  <th className="p-4">Salaire</th>
                  <th className="p-4 text-center">Candidatures</th>
                  <th className="p-4">Statut</th>
                  <th className="p-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.map(job => {
                  const vis = VISIBILITY_CONFIG[job.visibility ?? 'external']
                  const VisIcon = vis?.icon ?? Globe
                  return (
                  <tr key={job.id} className="hover:bg-muted/30">
                    <td className="p-4">
                      <p className="font-medium">{job.title}</p>
                      {job.department_name && (
                        <p className="text-xs text-muted-foreground">{job.department_name}</p>
                      )}
                    </td>
                    <td className="p-4">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${vis?.color ?? ''}`}>
                        <VisIcon className="h-3 w-3" /> {vis?.label ?? job.visibility}
                      </span>
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
                )})}
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
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
                        onClick={() => setSelectedApp(app)}
                        className={`rounded-lg border bg-card p-3 shadow-sm cursor-pointer hover:border-primary select-none transition-opacity ${draggedId === app.id ? 'opacity-40' : 'opacity-100'}`}
                      >
                        <p className="text-sm font-medium">{app.first_name} {app.last_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{app.email}</p>
                        {app.source === 'internal' && (
                          <span className="mt-1 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                            Interne
                          </span>
                        )}
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
                        <div className="mt-2 flex gap-2 border-t pt-2" onClick={e => e.stopPropagation()}>
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

      {showNewJob && (
        <NewJobModal
          form={newJob}
          setForm={setNewJob}
          departments={departments}
          onClose={() => setShowNewJob(false)}
          onSubmit={() => createJob.mutate(newJob)}
          submitting={createJob.isPending}
        />
      )}

      {selectedApp && (
        <ApplicationDetailModal
          app={selectedApp}
          aiCaps={aiCaps ?? { claude: false, mistral: false }}
          onClose={() => setSelectedApp(null)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['recruitment-applications'] })}
        />
      )}
    </div>
  )
}

// ── Modale création offre ───────────────────────────────────────────────────────
function NewJobModal({
  form, setForm, departments, onClose, onSubmit, submitting,
}: {
  form: NewJobForm
  setForm: (f: NewJobForm | ((p: NewJobForm) => NewJobForm)) => void
  departments: Department[]
  onClose: () => void
  onSubmit: () => void
  submitting: boolean
}) {
  const toggleDept = (id: string) => setForm(p => ({
    ...p,
    target_departments: p.target_departments.includes(id)
      ? p.target_departments.filter(d => d !== id)
      : [...p.target_departments, id],
  }))
  const toggleLevel = (lvl: string) => setForm(p => ({
    ...p,
    target_job_levels: p.target_job_levels.includes(lvl)
      ? p.target_job_levels.filter(l => l !== lvl)
      : [...p.target_job_levels, lvl],
  }))
  const isInternal = form.visibility !== 'external'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold mb-4">Nouvelle offre d'emploi</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Titre du poste *</label>
            <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="Ex: Chauffeur Senior" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Département</label>
            <select value={form.department_id} onChange={e => setForm(p => ({ ...p, department_id: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              <option value="">— Aucun —</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Localisation</label>
              <input value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type de contrat</label>
              <select value={form.contract_type} onChange={e => setForm(p => ({ ...p, contract_type: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
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
              <input type="number" value={form.salary_min} onChange={e => setForm(p => ({ ...p, salary_min: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="150000" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Salaire max (FCFA)</label>
              <input type="number" value={form.salary_max} onChange={e => setForm(p => ({ ...p, salary_max: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="250000" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Prérequis</label>
            <textarea value={form.requirements} onChange={e => setForm(p => ({ ...p, requirements: e.target.value }))}
              rows={2} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
          </div>

          <div className="border-t border-border pt-3">
            <label className="text-xs font-medium text-muted-foreground">Visibilité de l'offre *</label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(['external', 'internal', 'both'] as const).map(v => {
                const cfg = VISIBILITY_CONFIG[v]!
                const Icon = cfg.icon
                return (
                  <button key={v} type="button" onClick={() => setForm(p => ({ ...p, visibility: v }))}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${form.visibility === v ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>
                    <Icon className="h-4 w-4" /> {cfg.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              <strong>Externe</strong> : visible sur la page carrières publique.{' '}
              <strong>Interne</strong> : visible uniquement aux employés ciblés.{' '}
              <strong>Mixte</strong> : les deux.
            </p>
          </div>

          {isInternal && (
            <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3 space-y-3">
              <p className="text-xs font-medium text-purple-700">
                Critères de ciblage interne (tous optionnels, combinables)
              </p>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Départements ciblés</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {departments.length === 0 && (
                    <span className="text-xs text-muted-foreground italic">Aucun département</span>
                  )}
                  {departments.map(d => {
                    const active = form.target_departments.includes(d.id)
                    return (
                      <button key={d.id} type="button" onClick={() => toggleDept(d.id)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${active ? 'border-purple-500 bg-purple-100 text-purple-700' : 'border-border hover:bg-accent'}`}>
                        {d.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Catégories ciblées</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {JOB_LEVELS.map(lvl => {
                    const active = form.target_job_levels.includes(lvl)
                    return (
                      <button key={lvl} type="button" onClick={() => toggleLevel(lvl)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${active ? 'border-purple-500 bg-purple-100 text-purple-700' : 'border-border hover:bg-accent'}`}>
                        {JOB_LEVEL_LABELS[lvl]}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Ancienneté minimum (mois)</label>
                <input type="number" min="0" value={form.target_min_seniority_months}
                  onChange={e => setForm(p => ({ ...p, target_min_seniority_months: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  placeholder="Ex: 24 (pour 2 ans)" />
              </div>

              <p className="text-[11px] text-purple-700/80">
                Si aucun critère n'est sélectionné dans une catégorie, le filtre est désactivé pour cette catégorie (tout le monde matche).
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex gap-2 justify-end">
          <button onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
          <button onClick={onSubmit} disabled={!form.title || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? 'Création...' : 'Créer l\'offre'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modale détail candidat + analyse IA ─────────────────────────────────────────
function ApplicationDetailModal({
  app, aiCaps, onClose, onChanged,
}: {
  app: Application
  aiCaps: { claude: boolean; mistral: boolean }
  onClose: () => void
  onChanged: () => void
}) {
  const [model, setModel] = useState<'claude' | 'mistral'>(
    aiCaps.claude ? 'claude' : aiCaps.mistral ? 'mistral' : 'claude',
  )
  const [analyzing, setAnalyzing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<Application>(app)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const hasAnyModel = aiCaps.claude || aiCaps.mistral

  const triggerUpload = () => fileInputRef.current?.click()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('cv', file)
      const res = await api.post(`/recruitment/applications/${current.id}/upload-cv`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setCurrent(c => ({ ...c, cv_text: res.data.data.cv_text }))
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Erreur upload')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const runAnalysis = async () => {
    setAnalyzing(true)
    setError(null)
    try {
      const res = await api.post(`/recruitment/applications/${current.id}/analyze-cv`, { model })
      const updated = res.data.data as Application
      setCurrent(updated)
      onChanged()
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Erreur analyse IA')
    } finally {
      setAnalyzing(false)
    }
  }

  const strengths = useMemo(() => normalizeJsonArray(current.ai_strengths), [current.ai_strengths])
  const gaps      = useMemo(() => normalizeJsonArray(current.ai_gaps),      [current.ai_gaps])
  const redFlags  = useMemo(() => normalizeJsonArray(current.ai_red_flags), [current.ai_red_flags])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">{current.first_name} {current.last_name}</h3>
            <p className="text-sm text-muted-foreground">{current.email}{current.phone ? ` · ${current.phone}` : ''}</p>
            <p className="text-xs text-primary mt-1">{current.job_title}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-accent">
            <XCircle className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-muted/20 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">CV / texte transmis</span>
            <button onClick={triggerUpload} disabled={uploading}
              className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
              <Upload className="h-3 w-3" /> {uploading ? 'Upload...' : 'Téléverser un CV'}
            </button>
            <input ref={fileInputRef} type="file" hidden accept=".txt,.pdf,.doc,.docx" onChange={handleFileChange} />
          </div>
          <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-y-auto text-muted-foreground">
            {current.cv_text || '(aucun CV fourni — téléversez un fichier ou demandez au candidat de coller son CV dans la lettre de motivation)'}
          </pre>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Analyse IA du CV</span>
          </div>

          {hasAnyModel ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Modèle :</span>
              {(['claude', 'mistral'] as const).map(m => (
                <button key={m} type="button"
                  disabled={!aiCaps[m]}
                  onClick={() => setModel(m)}
                  className={`rounded-md px-3 py-1 text-xs font-medium border transition-colors ${
                    model === m ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'
                  } ${!aiCaps[m] ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  {m === 'claude' ? 'Claude (Anthropic)' : 'Mistral'}
                  {!aiCaps[m] && ' (clé non configurée)'}
                </button>
              ))}
              <button onClick={runAnalysis} disabled={analyzing || !current.cv_text}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                <Sparkles className="h-3.5 w-3.5" />
                {analyzing ? 'Analyse en cours…' : 'Lancer l\'analyse'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Aucune clé IA configurée (ANTHROPIC_API_KEY ou MISTRAL_API_KEY). Contactez votre administrateur.
            </p>
          )}

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>
          )}

          {current.ai_score !== null && current.ai_score !== undefined && (
            <div className="space-y-3 rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Score global</p>
                  <p className="text-2xl font-bold text-primary">{current.ai_score}%</p>
                </div>
                {current.ai_match_percentage !== null && current.ai_match_percentage !== undefined && (
                  <div>
                    <p className="text-xs text-muted-foreground">Adéquation offre</p>
                    <p className="text-2xl font-bold">{current.ai_match_percentage}%</p>
                  </div>
                )}
                {current.ai_recommendation && (
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${REC_COLORS[current.ai_recommendation] ?? 'bg-muted'}`}>
                    {REC_LABELS[current.ai_recommendation] ?? current.ai_recommendation}
                  </span>
                )}
                {current.ai_model_used && (
                  <span className="ml-auto rounded bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                    via {current.ai_model_used}
                  </span>
                )}
              </div>

              {current.ai_summary && (
                <p className="text-sm leading-relaxed">{current.ai_summary}</p>
              )}

              {strengths.length > 0 && (
                <Block title="Points forts" items={strengths} tone="positive" />
              )}
              {gaps.length > 0 && (
                <Block title="Lacunes" items={gaps} tone="neutral" />
              )}
              {redFlags.length > 0 && (
                <Block title="Points d'attention" items={redFlags} tone="warning" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Block({ title, items, tone }: {
  title: string; items: string[]; tone: 'positive' | 'neutral' | 'warning'
}) {
  const colors = {
    positive: 'border-emerald-200 bg-emerald-50/50 text-emerald-800',
    neutral:  'border-blue-200 bg-blue-50/40 text-blue-800',
    warning:  'border-red-200 bg-red-50/40 text-red-800',
  }[tone]
  return (
    <div className={`rounded-md border p-2 ${colors}`}>
      <p className="mb-1 text-xs font-semibold">{title}</p>
      <ul className="space-y-0.5 text-xs">
        {items.map((it, i) => <li key={i}>• {it}</li>)}
      </ul>
    </div>
  )
}

function normalizeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { return normalizeJsonArray(JSON.parse(v)) } catch { return [] }
  }
  return []
}
