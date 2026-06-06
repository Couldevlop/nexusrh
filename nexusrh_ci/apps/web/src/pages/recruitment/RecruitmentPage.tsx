import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import i18n from '@/i18n'
import { api, formatFCFA } from '@/lib/api'
import {
  EXPERIENCE_OPTIONS, JOB_LEVEL_OPTIONS, WORK_MODE_OPTIONS,
  EDUCATION_OPTIONS, SECTOR_OPTIONS,
} from '@/lib/apec'
import { useAuthStore } from '@/stores/authStore'
import {
  Briefcase, Plus, Users, MapPin, ChevronRight, Eye,
  CheckCircle, XCircle, ArrowRight, Sparkles, Upload, Globe, Lock,
  Wand2, Mail, Linkedin, Loader2, FileText,
  Target, Layers, Zap, TrendingUp, Quote, ShieldCheck,
  Star, Award, Send, ExternalLink, Edit3, Trash2, Pause, Play,
  Link2, Share2, Copy, MoreHorizontal,
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
  ai_focus_text?: string | null
  created_at: string
  // Détail éditable (renvoyé par SELECT rj.* — liste & détail)
  description?: string | null
  requirements?: string | null
  // Structure d'offre APEC
  reference?: string | null
  experience_level?: string | null
  job_level?: string | null
  sector?: string | null
  required_education?: string | null
  benefits?: string | null
  work_mode?: string | null
  start_date?: string | null
  recruitment_process?: string | null
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
  ai_signals_used?: string[]
  ai_demographic_risk_note?: string | null
  ai_model_used?: string | null
  cv_text?: string | null
  cv_mime_type?: string | null
  cv_filename?: string | null
  cv_size_bytes?: number | null
  has_cv?: boolean
  source?: string | null
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-700',
  closed: 'bg-red-100 text-red-700',
  draft: 'bg-gray-100 text-gray-600',
  paused: 'bg-yellow-100 text-yellow-700',
}

// Couleurs/icônes uniquement — les libellés sont résolus via i18n au rendu
// (clé technique = valeur API, libellé traduit).
const VISIBILITY_CONFIG: Record<string, { color: string; icon: typeof Globe }> = {
  external: { color: 'bg-blue-100 text-blue-700',     icon: Globe },
  internal: { color: 'bg-purple-100 text-purple-700', icon: Lock },
  both:     { color: 'bg-teal-100 text-teal-700',     icon: Eye  },
}
const visibilityLabel = (v: string) =>
  i18n.exists(`recruitment:visibility.${v}`) ? i18n.t(`recruitment:visibility.${v}`) : v

const STAGE_COLORS: Record<string, string> = {
  new:        'bg-blue-100 text-blue-700',
  screening:  'bg-purple-100 text-purple-700',
  interview:  'bg-yellow-100 text-yellow-700',
  test:       'bg-orange-100 text-orange-700',
  offer:      'bg-indigo-100 text-indigo-700',
  hired:      'bg-green-100 text-green-700',
  rejected:   'bg-red-100 text-red-700',
}
const stageLabel = (s: string) =>
  i18n.exists(`recruitment:stage.${s}`) ? i18n.t(`recruitment:stage.${s}`) : s

const PIPELINE_STAGES = ['new','screening','interview','test','offer','hired','rejected']
const JOB_LEVELS = ['cadre', 'agent_maitrise', 'employe', 'ouvrier']
const jobLevelLabel = (lvl: string) =>
  i18n.exists(`recruitment:jobLevel.${lvl}`) ? i18n.t(`recruitment:jobLevel.${lvl}`) : lvl

const REC_COLORS: Record<string, string> = {
  strong_yes: 'bg-green-100 text-green-800',
  yes:        'bg-emerald-100 text-emerald-700',
  maybe:      'bg-yellow-100 text-yellow-800',
  no:         'bg-red-100 text-red-800',
}
const recLabel = (r: string) =>
  i18n.exists(`recruitment:recommendation.${r}`) ? i18n.t(`recruitment:recommendation.${r}`) : r

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
  // ── Champs APEC (optionnels) ──
  experience_level: string
  job_level: string
  sector: string
  required_education: string
  work_mode: string
  start_date: string
  benefits: string
  recruitment_process: string
}

const EMPTY_FORM: NewJobForm = {
  title: '', department_id: '',
  location: 'Abidjan', contract_type: 'cdi',
  salary_min: '', salary_max: '',
  description: '', requirements: '',
  status: 'open', visibility: 'external',
  target_departments: [], target_job_levels: [],
  target_min_seniority_months: '',
  experience_level: '', job_level: '', sector: '', required_education: '',
  work_mode: '', start_date: '', benefits: '', recruitment_process: '',
}

export default function RecruitmentPage() {
  const { t } = useTranslation('recruitment')
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'jobs' | 'pipeline' | 'ai-sourcing'>('jobs')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [selectedApp, setSelectedApp] = useState<Application | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [newJob, setNewJob] = useState<NewJobForm>(EMPTY_FORM)
  const [showCriteria, setShowCriteria] = useState(false)
  const [criteriaFocus, setCriteriaFocus] = useState('')
  const [compareTop3, setCompareTop3] = useState(false)
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>([])
  const [compareSelected, setCompareSelected] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  interface DecisionHistoryEntry {
    id: string
    decision: 'hired' | 'rejected'
    decided_at: string
    decided_by: string | null
    prior_ai_score: number | null
    prior_ai_recommendation: string | null
    candidate_anchor: string | null
  }

  const { data: historyData, isLoading: historyLoading } = useQuery<{
    data: DecisionHistoryEntry[]
    counts: { hired: number; rejected: number }
    total: number
  }>({
    queryKey: ['recruitment-decisions-history', selectedJob?.id],
    queryFn: () => api.get(`/recruitment/jobs/${selectedJob!.id}/decisions-history`).then((r) => r.data),
    enabled: showHistory && !!selectedJob?.id,
  })

  useEffect(() => {
    setCriteriaFocus(selectedJob?.ai_focus_text ?? '')
    if (selectedJob?.ai_focus_text) setShowCriteria(true)
    setSelectedAppIds([])
    setCompareSelected(false)
    setShowHistory(false)
  }, [selectedJob?.id, selectedJob?.ai_focus_text])

  const toggleAppSelected = (id: string) => {
    setSelectedAppIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

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

  // ── Mutations CRUD Jobs (style Greenhouse/Lever) ────────────────────────
  const tenantSlug = useAuthStore((s) => s.tenantConfig?.slug ?? '')

  const updateJob = useMutation({
    // Body typé large : EditJobModal convertit les numériques (salaire, ancienneté)
    // en number|null avant envoi (jamais '' vers une colonne int).
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/recruitment/jobs/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recruitment-jobs'] }),
  })
  const deleteJob = useMutation({
    mutationFn: (id: string) => api.delete(`/recruitment/jobs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recruitment-jobs'] }),
  })
  const [editingJob, setEditingJob] = useState<Job | null>(null)
  const [sharingJob, setSharingJob] = useState<Job | null>(null)
  const [jobFilter, setJobFilter] = useState<'all' | 'external' | 'internal' | 'both' | 'closed'>('all')
  const [copyToast, setCopyToast] = useState<string | null>(null)

  const updateStage = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api.patch(`/recruitment/applications/${id}/stage`, { stage }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['recruitment-applications'] })
      // Si le nouveau stage est hired/rejected, l'historique IA évolue
      if (variables.stage === 'hired' || variables.stage === 'rejected') {
        queryClient.invalidateQueries({ queryKey: ['recruitment-decisions-history'] })
      }
    },
  })

  const preselect = useMutation({
    mutationFn: ({ jobId, criteria }: { jobId: string; criteria?: string }) =>
      api.post(`/recruitment/jobs/${jobId}/preselect`, {
        model: 'claude',
        stages: ['new'],
        criteria: criteria ? { focus: criteria } : undefined,
      }).then((r) => r.data as {
        total: number; analyzed: number; skipped: number; failed: number
        autoRejected?: number; toReview?: number
        top: Array<{
          id: string; score: number; recommendation: string
          firstName: string; lastName: string
          screeningDecision?: 'auto_reject' | 'review'; failedRules?: string[]
        }>
        effectiveFocus?: string | null
        learningExamples?: number
        message?: string
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recruitment-applications'] })
      queryClient.invalidateQueries({ queryKey: ['recruitment-jobs'] })
    },
  })

  const jobs = jobsData?.data ?? []
  const applications = appsData?.data ?? []
  const departments = deptData?.data ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('header.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('header.subtitle', { jobs: jobs.length, applications: applications.length })}</p>
        </div>
        <button
          onClick={() => setShowNewJob(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> {t('header.newJob')}
        </button>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['jobs', 'pipeline', 'ai-sourcing'] as const).map(tabKey => (
          <button key={tabKey} onClick={() => setTab(tabKey)}
            className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === tabKey ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {tabKey === 'ai-sourcing' && <Sparkles className="h-3.5 w-3.5" />}
            {tabKey === 'jobs' ? t('tabs.jobs') : tabKey === 'pipeline' ? t('tabs.pipeline') : t('tabs.aiSourcing')}
          </button>
        ))}
      </div>

      {tab === 'jobs' && (() => {
        // ── Filtres style Greenhouse/Lever ────────────────────────────
        const visibleJobs = jobs.filter(j => {
          if (jobFilter === 'all') return true
          if (jobFilter === 'closed') return j.status !== 'open'
          return (j.visibility ?? 'external') === jobFilter && j.status === 'open'
        })
        const counts = {
          all: jobs.length,
          external: jobs.filter(j => (j.visibility ?? 'external') === 'external' && j.status === 'open').length,
          internal: jobs.filter(j => j.visibility === 'internal' && j.status === 'open').length,
          both: jobs.filter(j => j.visibility === 'both' && j.status === 'open').length,
          closed: jobs.filter(j => j.status !== 'open').length,
        }
        const FILTER_LABELS = {
          all: t('filters.all'), external: t('filters.external'), internal: t('filters.internal'),
          both: t('filters.both'), closed: t('filters.closed'),
        }
        return (
          <div className="space-y-3">
            {/* Filtres pills */}
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(FILTER_LABELS) as Array<keyof typeof FILTER_LABELS>).map(k => (
                <button key={k} onClick={() => setJobFilter(k)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    jobFilter === k
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'border border-border bg-card text-muted-foreground hover:bg-accent'
                  }`}>
                  {FILTER_LABELS[k]}
                  <span className={`rounded-full px-1.5 text-[10px] font-bold ${jobFilter === k ? 'bg-white/30' : 'bg-muted'}`}>
                    {counts[k]}
                  </span>
                </button>
              ))}
            </div>

            <div className="rounded-xl border border-border bg-card overflow-hidden">
              {isLoading ? (
                <div className="flex items-center justify-center p-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="p-3">{t('table.position')}</th>
                      <th className="p-3">{t('table.visibility')}</th>
                      <th className="p-3">{t('table.location')}</th>
                      <th className="p-3">{t('table.contract')}</th>
                      <th className="p-3">{t('table.salary')}</th>
                      <th className="p-3 text-center">{t('table.candidates')}</th>
                      <th className="p-3">{t('table.status')}</th>
                      <th className="p-3 text-right">{t('table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visibleJobs.map(job => {
                      const vis = VISIBILITY_CONFIG[job.visibility ?? 'external']
                      const VisIcon = vis?.icon ?? Globe
                      const isPublic = job.visibility !== 'internal' && job.status === 'open'
                      const publicUrl = tenantSlug
                        ? `${window.location.origin}/careers/${tenantSlug}`
                        : ''
                      return (
                        <tr key={job.id} className="hover:bg-muted/20 transition-colors">
                          <td className="p-3">
                            <p className="font-semibold text-slate-900">{job.title}</p>
                            {job.department_name && (
                              <p className="text-xs text-muted-foreground">{job.department_name}</p>
                            )}
                          </td>
                          <td className="p-3">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${vis?.color ?? ''}`}>
                              <VisIcon className="h-3 w-3" /> {visibilityLabel(job.visibility ?? 'external')}
                            </span>
                          </td>
                          <td className="p-3">
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <MapPin className="h-3 w-3" />{job.location}
                            </div>
                          </td>
                          <td className="p-3 uppercase text-xs font-medium text-slate-600">{job.contract_type}</td>
                          <td className="p-3 text-xs">
                            {job.salary_min && job.salary_max
                              ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">
                                  {formatFCFA(parseInt(job.salary_min))} – {formatFCFA(parseInt(job.salary_max))}
                                </span>
                              : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="p-3 text-center">
                            <button onClick={() => { setSelectedJob(job); setTab('pipeline') }}
                              className="inline-flex items-center justify-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary hover:bg-primary/20"
                              title={t('table.viewPipeline')}>
                              <Users className="h-3 w-3" />{job.applications_count}
                            </button>
                          </td>
                          <td className="p-3">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] ?? 'bg-muted'}`}>
                              {job.status === 'open' ? t('jobStatus.open') : job.status === 'closed' ? t('jobStatus.closed') : job.status === 'paused' ? t('jobStatus.paused') : job.status}
                            </span>
                          </td>
                          <td className="p-3">
                            <div className="flex items-center justify-end gap-0.5">
                              {isPublic && (
                                <a href={publicUrl} target="_blank" rel="noopener noreferrer"
                                  className="rounded-md p-1.5 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                                  title={t('table.previewPublic')}>
                                  <Eye className="h-4 w-4" />
                                </a>
                              )}
                              {isPublic && (
                                <button onClick={() => setSharingJob(job)}
                                  className="rounded-md p-1.5 text-slate-500 hover:bg-purple-50 hover:text-purple-600 transition-colors"
                                  title={t('table.shareJob')}>
                                  <Share2 className="h-4 w-4" />
                                </button>
                              )}
                              <button
                                onClick={() => updateJob.mutate({
                                  id: job.id,
                                  body: { status: job.status === 'open' ? 'paused' : 'open' },
                                })}
                                className={`rounded-md p-1.5 transition-colors ${
                                  job.status === 'open'
                                    ? 'text-slate-500 hover:bg-amber-50 hover:text-amber-600'
                                    : 'text-slate-500 hover:bg-emerald-50 hover:text-emerald-600'
                                }`}
                                title={job.status === 'open' ? t('table.pause') : t('table.reopen')}>
                                {job.status === 'open' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                              </button>
                              <button onClick={() => setEditingJob(job)}
                                className="rounded-md p-1.5 text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                                title={t('table.edit')}>
                                <Edit3 className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(t('table.deleteConfirm', { title: job.title }))) {
                                    deleteJob.mutate(job.id)
                                  }
                                }}
                                className="rounded-md p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                                title={t('table.delete')}>
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {visibleJobs.length === 0 && (
                      <tr>
                        <td colSpan={8} className="p-12 text-center text-muted-foreground">
                          <Briefcase className="mx-auto mb-2 h-10 w-10 opacity-30" />
                          <p className="text-sm">
                            {jobFilter === 'all' ? t('table.emptyAll') : t('table.emptyFiltered', { filter: FILTER_LABELS[jobFilter] })}
                          </p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )
      })()}

      {tab === 'pipeline' && (
        <div className="space-y-4">
          {selectedJob && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-sm">
                  <button onClick={() => setSelectedJob(null)} className="text-primary hover:underline">
                    {t('pipeline.allJobs')}
                  </button>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{selectedJob.title}</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setShowCriteria((v) => !v)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title={t('pipeline.criteriaTitle')}
                  >
                    {showCriteria ? t('pipeline.hideCriteria') : t('pipeline.showCriteria')}
                  </button>
                  <button
                    onClick={() => setShowHistory((v) => !v)}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    title={t('pipeline.learningTitle')}
                  >
                    <Zap className="h-3 w-3" /> {showHistory ? t('pipeline.hideLearning') : t('pipeline.showLearning')}
                  </button>
                  <button
                    onClick={() => preselect.mutate({
                      jobId: selectedJob.id,
                      criteria: criteriaFocus.trim() || undefined,
                    })}
                    disabled={preselect.isPending}
                    title={t('pipeline.preselectTitle')}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {preselect.isPending
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('pipeline.preselecting')}</>
                      : <><Sparkles className="h-3.5 w-3.5" /> {t('pipeline.preselect')}</>}
                  </button>
                </div>
              </div>
              {showCriteria && (
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {t('pipeline.recruiterPriorities')}
                  </label>
                  <textarea
                    value={criteriaFocus}
                    onChange={(e) => setCriteriaFocus(e.target.value)}
                    placeholder={t('pipeline.recruiterPlaceholder')}
                    rows={3}
                    maxLength={500}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {t('pipeline.criteriaHelp')}
                    {' '}<span className="font-medium text-primary">{t('pipeline.criteriaSaved')}</span>
                  </p>
                </div>
              )}
              {/* Règles dures de pré-tri — paramétrables par l'admin du tenant */}
              <ScreeningCriteriaPanel jobId={selectedJob.id} />
            </div>
          )}
          {!selectedJob && (
            <p className="text-sm text-muted-foreground">
              {t('pipeline.allApplications')}
            </p>
          )}
          {preselect.data && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="font-medium">
                    {t('pipeline.preselectDone', { count: preselect.data.analyzed })}
                    {(preselect.data.toReview ?? 0) > 0 && <span className="text-emerald-700">{t('pipeline.toReview', { count: preselect.data.toReview })}</span>}
                    {(preselect.data.autoRejected ?? 0) > 0 && <span className="text-red-600">{t('pipeline.autoRejected', { count: preselect.data.autoRejected })}</span>}
                    {preselect.data.skipped > 0 && <span className="text-muted-foreground">{t('pipeline.skipped', { count: preselect.data.skipped })}</span>}
                    {preselect.data.failed > 0 && <span className="text-red-600">{t('pipeline.failed', { count: preselect.data.failed })}</span>}
                  </p>
                  {(preselect.data.autoRejected ?? 0) > 0 && (
                    <p className="mt-1 text-[11px] text-amber-700">
                      {t('pipeline.autoRejectedNote')}
                    </p>
                  )}
                  {preselect.data.learningExamples != null && preselect.data.learningExamples > 0 && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-primary" />
                      {t('pipeline.learningActive', { count: preselect.data.learningExamples })}
                    </p>
                  )}
                </div>
                <button onClick={() => preselect.reset()}
                  className="text-xs text-muted-foreground hover:text-foreground">
                  {t('pipeline.close')}
                </button>
              </div>
              {preselect.data.top.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {preselect.data.top.map((row) => (
                    <li key={row.id} className="text-xs flex items-center gap-2">
                      <span className="font-semibold text-foreground">{row.firstName} {row.lastName}</span>
                      <span className="rounded bg-primary/20 px-1.5 py-0.5 text-primary font-medium">{row.score}/100</span>
                      <span className="text-muted-foreground">{recLabel(row.recommendation)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preselect.data.top.length >= 2 && !compareTop3 && (
                <button
                  onClick={() => setCompareTop3(true)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <Layers className="h-3 w-3" /> {t('pipeline.compareTop', { count: Math.min(3, preselect.data.top.length) })}
                </button>
              )}
              {preselect.data.message && (
                <p className="text-xs text-muted-foreground italic mt-1">{preselect.data.message}</p>
              )}
            </div>
          )}
          {preselect.data && compareTop3 && preselect.data.top.length >= 2 && (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Layers className="h-4 w-4 text-primary" />
                  {t('pipeline.comparisonTop', { count: Math.min(3, preselect.data.top.length) })}
                </h3>
                <button
                  onClick={() => setCompareTop3(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('pipeline.hide')}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {preselect.data.top.slice(0, 3).map((row) => {
                  const app = applications.find((a) => a.id === row.id)
                  if (!app) return null
                  const strengths = normalizeJsonArray(app.ai_strengths).slice(0, 4)
                  const gaps = normalizeJsonArray(app.ai_gaps).slice(0, 3)
                  const redFlags = normalizeJsonArray(app.ai_red_flags)
                  const signalsUsed = normalizeJsonArray(app.ai_signals_used).slice(0, 4)
                  const biasNote = app.ai_demographic_risk_note?.trim() || null
                  const recoColor = {
                    strong_yes: 'bg-green-100 text-green-700',
                    yes: 'bg-blue-100 text-blue-700',
                    maybe: 'bg-yellow-100 text-yellow-700',
                    no: 'bg-red-100 text-red-700',
                  }[row.recommendation] ?? 'bg-gray-100 text-gray-600'
                  return (
                    <div key={row.id} className="rounded-lg border border-border bg-background p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{row.firstName} {row.lastName}</p>
                          <p className="text-xs text-muted-foreground truncate">{app.email}</p>
                        </div>
                        <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary flex-shrink-0">
                          {row.score}/100
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${recoColor}`}>
                          {recLabel(row.recommendation)}
                        </span>
                        {app.ai_match_percentage != null && (
                          <span className="text-[10px] text-muted-foreground">
                            {t('pipeline.match', { value: app.ai_match_percentage })}
                          </span>
                        )}
                      </div>
                      {strengths.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-green-700 mb-0.5">{t('pipeline.strengths')}</p>
                          <ul className="text-xs space-y-0.5">
                            {strengths.map((s, i) => (
                              <li key={i} className="flex gap-1">
                                <CheckCircle className="h-3 w-3 text-green-600 flex-shrink-0 mt-0.5" />
                                <span className="text-muted-foreground">{s}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {gaps.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-orange-700 mb-0.5">{t('pipeline.gaps')}</p>
                          <ul className="text-xs space-y-0.5">
                            {gaps.map((g, i) => (
                              <li key={i} className="flex gap-1">
                                <span className="text-orange-500 flex-shrink-0">·</span>
                                <span className="text-muted-foreground">{g}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {redFlags.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-red-700 mb-0.5">{t('pipeline.alerts')}</p>
                          <ul className="text-xs space-y-0.5">
                            {redFlags.map((r, i) => (
                              <li key={i} className="flex gap-1">
                                <XCircle className="h-3 w-3 text-red-600 flex-shrink-0 mt-0.5" />
                                <span className="text-muted-foreground">{r}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {signalsUsed.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-blue-700 mb-0.5 flex items-center gap-1">
                            <Sparkles className="h-3 w-3" /> {t('pipeline.signalsUsed')}
                          </p>
                          <ul className="text-xs space-y-0.5">
                            {signalsUsed.map((s, i) => (
                              <li key={i} className="flex gap-1">
                                <span className="text-blue-500 flex-shrink-0">›</span>
                                <span className="text-muted-foreground">{s}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {biasNote && (
                        <div className="rounded border border-amber-300 bg-amber-50 p-2">
                          <p className="text-[10px] font-semibold text-amber-800 mb-0.5 flex items-center gap-1">
                            <ShieldCheck className="h-3 w-3" /> {t('pipeline.biasAudit')}
                          </p>
                          <p className="text-[11px] text-amber-900 leading-snug">{biasNote}</p>
                        </div>
                      )}
                      <div className="pt-2 border-t flex gap-1.5">
                        <button
                          onClick={() => setSelectedApp(app)}
                          className="flex-1 inline-flex items-center justify-center gap-1 text-xs text-primary hover:bg-primary/5 rounded py-1"
                        >
                          <Eye className="h-3 w-3" /> {t('pipeline.detail')}
                        </button>
                        <button
                          onClick={() => updateStage.mutate({ id: app.id, stage: 'interview' })}
                          className="flex-1 inline-flex items-center justify-center gap-1 text-xs text-blue-600 hover:bg-blue-50 font-medium rounded py-1"
                        >
                          {t('pipeline.interview')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {preselect.isError && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {t('pipeline.preselectError')}
            </div>
          )}
          {showHistory && selectedJob && (
            <div className="rounded-lg border border-border bg-card p-3 text-sm">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold flex items-center gap-1.5">
                  <Zap className="h-4 w-4 text-primary" />
                  {t('pipeline.learningHistory')}
                  {historyData && (
                    <span className="text-xs font-normal text-muted-foreground ml-2">
                      <Trans
                        i18nKey="pipeline.learningCount"
                        ns="recruitment"
                        count={historyData.total}
                        values={{ count: historyData.total, hired: historyData.counts.hired, rejected: historyData.counts.rejected }}
                        components={{ hired: <span className="text-green-700" />, rejected: <span className="text-red-700" /> }}
                      />
                    </span>
                  )}
                </h3>
                <button
                  onClick={() => setShowHistory(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('pipeline.hide')}
                </button>
              </div>
              {historyLoading && (
                <p className="text-xs text-muted-foreground italic">{t('pipeline.loadingHistory')}</p>
              )}
              {!historyLoading && historyData && historyData.total === 0 && (
                <p className="text-xs text-muted-foreground italic">
                  {t('pipeline.noDecisions')}
                </p>
              )}
              {!historyLoading && historyData && historyData.total > 0 && (
                <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                  {historyData.data.map((entry) => {
                    const isHire = entry.decision === 'hired'
                    return (
                      <li key={entry.id} className="flex items-start gap-2 text-xs border-l-2 pl-2 py-0.5"
                          style={{ borderColor: isHire ? 'rgb(34 197 94)' : 'rgb(239 68 68)' }}>
                        <span className={`font-semibold flex-shrink-0 ${isHire ? 'text-green-700' : 'text-red-700'}`}>
                          {isHire ? t('pipeline.decisionHired') : t('pipeline.decisionRejected')}
                        </span>
                        <span className="text-muted-foreground flex-shrink-0">
                          {new Date(entry.decided_at).toLocaleDateString('fr-FR')}
                        </span>
                        {entry.prior_ai_score != null && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium flex-shrink-0">
                            {t('pipeline.aiScore', { score: entry.prior_ai_score })}
                          </span>
                        )}
                        <span className="text-muted-foreground truncate">{entry.candidate_anchor || '—'}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="text-[10px] text-muted-foreground mt-2 italic">
                {t('pipeline.learningFooter')}
              </p>
            </div>
          )}
          {selectedAppIds.length >= 1 && (
            <div className="sticky top-2 z-10 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 backdrop-blur px-3 py-2 text-sm">
              <span className="font-medium">
                {t('pipeline.selectedCount', { count: selectedAppIds.length })}
                {selectedAppIds.length === 1 && <span className="text-xs text-muted-foreground ml-2">{t('pipeline.selectAtLeastTwo')}</span>}
              </span>
              <div className="flex items-center gap-2">
                {selectedAppIds.length >= 2 && (
                  <button
                    onClick={() => setCompareSelected(true)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <Layers className="h-3.5 w-3.5" /> {t('pipeline.compareCount', { count: selectedAppIds.length })}
                  </button>
                )}
                <button
                  onClick={() => { setSelectedAppIds([]); setCompareSelected(false) }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('pipeline.deselectAll')}
                </button>
              </div>
            </div>
          )}
          {compareSelected && selectedAppIds.length >= 2 && (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Layers className="h-4 w-4 text-primary" />
                  {t('pipeline.freeComparison', { count: selectedAppIds.length })}
                </h3>
                <button
                  onClick={() => setCompareSelected(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('pipeline.hide')}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {selectedAppIds.map((id) => {
                  const app = applications.find((a) => a.id === id)
                  if (!app) return null
                  const isAnalyzed = app.ai_score !== null && app.ai_score !== undefined
                  const strengths = normalizeJsonArray(app.ai_strengths).slice(0, 4)
                  const gaps = normalizeJsonArray(app.ai_gaps).slice(0, 3)
                  const redFlags = normalizeJsonArray(app.ai_red_flags)
                  const signalsUsed = normalizeJsonArray(app.ai_signals_used).slice(0, 4)
                  const biasNote = app.ai_demographic_risk_note?.trim() || null
                  const reco = app.ai_recommendation ?? 'maybe'
                  const recoColor = {
                    strong_yes: 'bg-green-100 text-green-700',
                    yes: 'bg-blue-100 text-blue-700',
                    maybe: 'bg-yellow-100 text-yellow-700',
                    no: 'bg-red-100 text-red-700',
                  }[reco] ?? 'bg-gray-100 text-gray-600'
                  return (
                    <div key={app.id} className="rounded-lg border border-border bg-background p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{app.first_name} {app.last_name}</p>
                          <p className="text-xs text-muted-foreground truncate">{app.email}</p>
                        </div>
                        {isAnalyzed ? (
                          <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary flex-shrink-0">
                            {app.ai_score}/100
                          </span>
                        ) : (
                          <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground flex-shrink-0">
                            {t('pipeline.notAnalyzed')}
                          </span>
                        )}
                      </div>
                      {isAnalyzed && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${recoColor}`}>
                            {recLabel(reco)}
                          </span>
                          {app.ai_match_percentage != null && (
                            <span className="text-[10px] text-muted-foreground">
                              {t('pipeline.match', { value: app.ai_match_percentage })}
                            </span>
                          )}
                        </div>
                      )}
                      {!isAnalyzed && (
                        <p className="text-[11px] text-muted-foreground italic">
                          {t('pipeline.runPreselectToAnalyze')}
                        </p>
                      )}
                      {strengths.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-green-700 mb-0.5">{t('pipeline.strengths')}</p>
                          <ul className="text-xs space-y-0.5">
                            {strengths.map((s, i) => (
                              <li key={i} className="flex gap-1">
                                <CheckCircle className="h-3 w-3 text-green-600 flex-shrink-0 mt-0.5" />
                                <span className="text-muted-foreground">{s}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {gaps.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-orange-700 mb-0.5">{t('pipeline.gaps')}</p>
                          <ul className="text-xs space-y-0.5">
                            {gaps.map((g, i) => (
                              <li key={i} className="flex gap-1">
                                <span className="text-orange-500 flex-shrink-0">·</span>
                                <span className="text-muted-foreground">{g}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {redFlags.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-red-700 mb-0.5">{t('pipeline.alerts')}</p>
                          <ul className="text-xs space-y-0.5">
                            {redFlags.map((r, i) => (
                              <li key={i} className="flex gap-1">
                                <XCircle className="h-3 w-3 text-red-600 flex-shrink-0 mt-0.5" />
                                <span className="text-muted-foreground">{r}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {signalsUsed.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-blue-700 mb-0.5 flex items-center gap-1">
                            <Sparkles className="h-3 w-3" /> {t('pipeline.signalsUsed')}
                          </p>
                          <ul className="text-xs space-y-0.5">
                            {signalsUsed.map((s, i) => (
                              <li key={i} className="flex gap-1">
                                <span className="text-blue-500 flex-shrink-0">›</span>
                                <span className="text-muted-foreground">{s}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {biasNote && (
                        <div className="rounded border border-amber-300 bg-amber-50 p-2">
                          <p className="text-[10px] font-semibold text-amber-800 mb-0.5 flex items-center gap-1">
                            <ShieldCheck className="h-3 w-3" /> {t('pipeline.biasAudit')}
                          </p>
                          <p className="text-[11px] text-amber-900 leading-snug">{biasNote}</p>
                        </div>
                      )}
                      <div className="pt-2 border-t flex gap-1.5">
                        <button
                          onClick={() => setSelectedApp(app)}
                          className="flex-1 inline-flex items-center justify-center gap-1 text-xs text-primary hover:bg-primary/5 rounded py-1"
                        >
                          <Eye className="h-3 w-3" /> {t('pipeline.detail')}
                        </button>
                        <button
                          onClick={() => updateStage.mutate({ id: app.id, stage: 'interview' })}
                          className="flex-1 inline-flex items-center justify-center gap-1 text-xs text-blue-600 hover:bg-blue-50 font-medium rounded py-1"
                        >
                          {t('pipeline.interview')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <div className="flex gap-3 overflow-x-auto pb-4">
            {PIPELINE_STAGES.map(stage => {
              const stageApps = applications.filter(a => a.stage === stage)
              const isOver = dragOverStage === stage
              return (
                <div
                  key={stage}
                  className="flex-shrink-0 w-60"
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverStage(stage) }}
                  onDragLeave={() => setDragOverStage(null)}
                  onDrop={e => {
                    e.preventDefault()
                    // Repli dataTransfer : si le re-render a fait perdre l'état React,
                    // l'id voyage aussi dans l'événement natif.
                    const droppedId = draggedId ?? e.dataTransfer.getData('text/plain')
                    if (droppedId) {
                      updateStage.mutate({ id: droppedId, stage })
                    }
                    setDraggedId(null)
                    setDragOverStage(null)
                  }}
                >
                  <div className={`rounded-t-lg px-3 py-2 flex items-center justify-between ${STAGE_COLORS[stage] ?? ''}`}>
                    <span className="text-xs font-semibold">{stageLabel(stage)}</span>
                    <span className="rounded-full bg-white/50 px-1.5 py-0.5 text-xs font-bold">{stageApps.length}</span>
                  </div>
                  <div className={`rounded-b-lg min-h-[140px] space-y-2 p-2 border border-t-0 transition-colors ${isOver ? 'bg-primary/5 border-primary border-dashed' : 'bg-muted/20 border-border'}`}>
                    {stageApps.map(app => (
                      <div
                        key={app.id}
                        draggable
                        onDragStart={(e) => {
                          // Firefox exige setData pour démarrer un drag HTML5.
                          e.dataTransfer.setData('text/plain', app.id)
                          e.dataTransfer.effectAllowed = 'move'
                          // CRITIQUE : différer le setState. Le re-render synchrone change
                          // la classe (opacity-40) du nœud traîné PENDANT dragstart, ce qui
                          // fait avorter le drag sur Chromium.
                          window.setTimeout(() => setDraggedId(app.id), 0)
                        }}
                        onDragEnd={() => { setDraggedId(null); setDragOverStage(null) }}
                        onClick={() => setSelectedApp(app)}
                        className={`rounded-lg border bg-card p-3 shadow-sm cursor-pointer hover:border-primary select-none transition-opacity ${draggedId === app.id ? 'opacity-40' : 'opacity-100'} ${selectedAppIds.includes(app.id) ? 'ring-2 ring-primary border-primary' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium">{app.first_name} {app.last_name}</p>
                          <input
                            type="checkbox"
                            checked={selectedAppIds.includes(app.id)}
                            onChange={(e) => { e.stopPropagation(); toggleAppSelected(app.id) }}
                            onClick={(e) => e.stopPropagation()}
                            title={t('pipeline.selectForComparison')}
                            aria-label={t('pipeline.selectForComparisonAria', { name: `${app.first_name} ${app.last_name}` })}
                            className="h-3.5 w-3.5 accent-primary cursor-pointer flex-shrink-0 mt-0.5"
                          />
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{app.email}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {app.source === 'internal' && (
                            <span className="inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                              {t('pipeline.internal')}
                            </span>
                          )}
                          {(app.has_cv || app.cv_filename) && (
                            <span
                              className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                              title={t('pipeline.cvReceivedTitle')}
                            >
                              <FileText className="h-2.5 w-2.5" /> CV
                            </span>
                          )}
                        </div>
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
                            <CheckCircle className="h-3 w-3" /> {t('pipeline.recruit')}
                          </button>
                          <span className="text-muted-foreground">·</span>
                          <button onClick={() => updateStage.mutate({ id: app.id, stage: 'rejected' })}
                            className="flex items-center gap-0.5 text-xs text-red-500 hover:text-red-600 font-medium">
                            <XCircle className="h-3 w-3" /> {t('pipeline.reject')}
                          </button>
                        </div>
                      </div>
                    ))}
                    {stageApps.length === 0 && (
                      <div className={`flex items-center justify-center h-20 text-xs rounded-lg border border-dashed ${isOver ? 'border-primary text-primary' : 'border-muted-foreground/30 text-muted-foreground'}`}>
                        {isOver ? t('pipeline.dropHere') : t('pipeline.empty')}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'ai-sourcing' && (
        <SourcingTab
          jobs={jobs}
          aiCaps={aiCaps ?? { claude: false, mistral: false }}
          onTransferred={() => {
            queryClient.invalidateQueries({ queryKey: ['recruitment-applications'] })
            queryClient.invalidateQueries({ queryKey: ['recruitment-jobs'] })
          }}
          onGoToKanban={(jobIdToSelect) => {
            const job = jobs.find(j => j.id === jobIdToSelect) ?? null
            setSelectedJob(job)
            setTab('pipeline')
          }}
        />
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

      {editingJob && (
        <EditJobModal
          job={editingJob}
          departments={departments}
          submitting={updateJob.isPending}
          onClose={() => setEditingJob(null)}
          onSubmit={(patch) => updateJob.mutate(
            { id: editingJob.id, body: patch },
            { onSuccess: () => setEditingJob(null) },
          )}
        />
      )}

      {sharingJob && tenantSlug && (
        <ShareJobModal
          job={sharingJob}
          publicUrl={`${window.location.origin}/careers/${tenantSlug}`}
          onClose={() => setSharingJob(null)}
          onCopied={(msg) => {
            setCopyToast(msg)
            setTimeout(() => setCopyToast(null), 2000)
          }}
        />
      )}

      {copyToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle className="h-4 w-4 text-emerald-400" />
          {copyToast}
        </div>
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
  const { t } = useTranslation('recruitment')
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card w-full max-w-2xl max-h-[min(90vh,720px)] flex flex-col shadow-xl my-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-5 py-3 rounded-t-xl">
          <h3 className="font-semibold">{t('newJobModal.title')}</h3>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-accent" aria-label={t('newJobModal.close')}>
            <XCircle className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.jobTitle')}</label>
            <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('newJobModal.jobTitlePlaceholder')} />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.department')}</label>
            <select value={form.department_id} onChange={e => setForm(p => ({ ...p, department_id: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              <option value="">{t('newJobModal.noDepartment')}</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.location')}</label>
              <input value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.contractType')}</label>
              <select value={form.contract_type} onChange={e => setForm(p => ({ ...p, contract_type: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="cdi">{t('contractType.cdi')}</option>
                <option value="cdd">{t('contractType.cdd')}</option>
                <option value="stage">{t('contractType.stage')}</option>
                <option value="apprentissage">{t('contractType.apprentissage')}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.salaryMin')}</label>
              <input type="number" value={form.salary_min} onChange={e => setForm(p => ({ ...p, salary_min: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="150000" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.salaryMax')}</label>
              <input type="number" value={form.salary_max} onChange={e => setForm(p => ({ ...p, salary_max: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                placeholder="250000" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.description')}</label>
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.requirements')}</label>
            <textarea value={form.requirements} onChange={e => setForm(p => ({ ...p, requirements: e.target.value }))}
              rows={2} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
          </div>

          {/* ── Structure d'offre APEC (tous optionnels) ── */}
          <div className="border-t border-border pt-3 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground">{t('newJobModal.apecStructure')}</p>
            <div className="grid grid-cols-2 gap-3">
              {([
                { key: 'experience_level',   label: t('newJobModal.experience'),    opts: EXPERIENCE_OPTIONS },
                { key: 'job_level',          label: t('newJobModal.jobLevelLabel'), opts: JOB_LEVEL_OPTIONS },
                { key: 'required_education', label: t('newJobModal.education'),      opts: EDUCATION_OPTIONS },
                { key: 'sector',             label: t('newJobModal.sector'),         opts: SECTOR_OPTIONS },
                { key: 'work_mode',          label: t('newJobModal.workMode'),       opts: WORK_MODE_OPTIONS },
              ] as const).map(({ key, label, opts }) => (
                <div key={key}>
                  <label className="text-xs font-medium text-muted-foreground">{label}</label>
                  <select value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                    <option value="">—</option>
                    {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.startDate')}</label>
                <input type="date" value={form.start_date}
                  onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.benefits')}</label>
              <textarea value={form.benefits} onChange={e => setForm(p => ({ ...p, benefits: e.target.value }))}
                rows={2} placeholder={t('newJobModal.benefitsPlaceholder')}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.recruitmentProcess')}</label>
              <textarea value={form.recruitment_process} onChange={e => setForm(p => ({ ...p, recruitment_process: e.target.value }))}
                rows={2} placeholder={t('newJobModal.recruitmentProcessPlaceholder')}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.jobVisibility')}</label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(['external', 'internal', 'both'] as const).map(v => {
                const cfg = VISIBILITY_CONFIG[v]!
                const Icon = cfg.icon
                return (
                  <button key={v} type="button" onClick={() => setForm(p => ({ ...p, visibility: v }))}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${form.visibility === v ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>
                    <Icon className="h-4 w-4" /> {visibilityLabel(v)}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              <strong>{t('newJobModal.visibilityHelpExternal')}</strong>{t('newJobModal.visibilityHelpExternalText')}
              <strong>{t('newJobModal.visibilityHelpInternal')}</strong>{t('newJobModal.visibilityHelpInternalText')}
              <strong>{t('newJobModal.visibilityHelpBoth')}</strong>{t('newJobModal.visibilityHelpBothText')}
            </p>
          </div>

          {isInternal && (
            <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3 space-y-3">
              <p className="text-xs font-medium text-purple-700">
                {t('newJobModal.internalTargeting')}
              </p>

              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.targetDepartments')}</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {departments.length === 0 && (
                    <span className="text-xs text-muted-foreground italic">{t('newJobModal.noDepartmentAvailable')}</span>
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
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.targetCategories')}</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {JOB_LEVELS.map(lvl => {
                    const active = form.target_job_levels.includes(lvl)
                    return (
                      <button key={lvl} type="button" onClick={() => toggleLevel(lvl)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${active ? 'border-purple-500 bg-purple-100 text-purple-700' : 'border-border hover:bg-accent'}`}>
                        {jobLevelLabel(lvl)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.minSeniority')}</label>
                <input type="number" min="0" value={form.target_min_seniority_months}
                  onChange={e => setForm(p => ({ ...p, target_min_seniority_months: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  placeholder={t('newJobModal.minSeniorityPlaceholder')} />
              </div>

              <p className="text-[11px] text-purple-700/80">
                {t('newJobModal.targetingHelp')}
              </p>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 flex gap-2 justify-end border-t border-border bg-card px-5 py-3 rounded-b-xl">
          <button onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('newJobModal.cancel')}</button>
          <button onClick={onSubmit} disabled={!form.title || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? t('newJobModal.creating') : t('newJobModal.create')}
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
  const { t } = useTranslation('recruitment')
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
      setCurrent(c => ({
        ...c,
        cv_text: res.data.data.cv_text,
        cv_mime_type: res.data.data.cv_mime_type,
        cv_filename: res.data.data.cv_filename,
        cv_size_bytes: res.data.data.cv_size_bytes,
      }))
      onChanged()
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? t('appDetail.errorUpload'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Récupère le binaire du CV via API authentifiée puis crée un blob URL pour
  // l'iframe (le iframe ne peut pas envoyer de bearer token directement).
  const [cvBlobUrl, setCvBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    let urlToRevoke: string | null = null
    setCvBlobUrl(null)
    if (current.cv_mime_type) {
      api.get(`/recruitment/applications/${current.id}/cv-file`, { responseType: 'blob' })
        .then((r) => {
          if (!active) return
          const url = URL.createObjectURL(r.data as Blob)
          urlToRevoke = url
          setCvBlobUrl(url)
        })
        .catch(() => { /* pas de blob → fallback texte */ })
    }
    return () => {
      active = false
      if (urlToRevoke) URL.revokeObjectURL(urlToRevoke)
    }
  }, [current.id, current.cv_mime_type])

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
      setError(msg ?? t('appDetail.errorAnalysis'))
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
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">{t('appDetail.cvTransmitted')}</span>
              {current.cv_filename && (
                <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={current.cv_filename}>
                  · {current.cv_filename}
                  {current.cv_size_bytes != null && (
                    <span> {t('appDetail.sizeKo', { size: Math.round(current.cv_size_bytes / 1024) })}</span>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {cvBlobUrl && (
                <a href={cvBlobUrl} download={current.cv_filename ?? 'cv'}
                  className="flex items-center gap-1 text-xs text-primary hover:underline">
                  <Upload className="h-3 w-3 rotate-180" /> {t('appDetail.download')}
                </a>
              )}
              <button onClick={triggerUpload} disabled={uploading}
                className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
                <Upload className="h-3 w-3" /> {uploading ? t('appDetail.uploading') : t('appDetail.uploadCv')}
              </button>
              <input ref={fileInputRef} type="file" hidden accept=".txt,.pdf,.doc,.docx" onChange={handleFileChange} />
            </div>
          </div>
          {cvBlobUrl && current.cv_mime_type === 'application/pdf' ? (
            <iframe
              src={cvBlobUrl}
              title={current.cv_filename ?? 'CV PDF'}
              className="w-full h-96 rounded border border-border bg-white"
              sandbox=""
            />
          ) : cvBlobUrl && current.cv_mime_type?.startsWith('image/') ? (
            <img
              src={cvBlobUrl}
              alt={current.cv_filename ?? 'CV'}
              className="max-h-96 w-auto mx-auto rounded border border-border bg-white"
            />
          ) : current.cv_text ? (
            <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-y-auto text-muted-foreground">
              {current.cv_text}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {t('appDetail.noCv')}
            </p>
          )}
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('appDetail.aiCvAnalysis')}</span>
          </div>

          {hasAnyModel ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('appDetail.model')}</span>
              {(['claude', 'mistral'] as const).map(m => (
                <button key={m} type="button"
                  disabled={!aiCaps[m]}
                  onClick={() => setModel(m)}
                  className={`rounded-md px-3 py-1 text-xs font-medium border transition-colors ${
                    model === m ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'
                  } ${!aiCaps[m] ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  {m === 'claude' ? t('appDetail.claudeAnthropic') : t('appDetail.mistral')}
                  {!aiCaps[m] && t('appDetail.keyNotConfigured')}
                </button>
              ))}
              <button onClick={runAnalysis} disabled={analyzing || !current.cv_text}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                <Sparkles className="h-3.5 w-3.5" />
                {analyzing ? t('appDetail.analyzing') : t('appDetail.runAnalysis')}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {t('appDetail.noAiKey')}
            </p>
          )}

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>
          )}

          {current.ai_score !== null && current.ai_score !== undefined && (
            <div className="space-y-3 rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">{t('appDetail.globalScore')}</p>
                  <p className="text-2xl font-bold text-primary">{current.ai_score}%</p>
                </div>
                {current.ai_match_percentage !== null && current.ai_match_percentage !== undefined && (
                  <div>
                    <p className="text-xs text-muted-foreground">{t('appDetail.offerMatch')}</p>
                    <p className="text-2xl font-bold">{current.ai_match_percentage}%</p>
                  </div>
                )}
                {current.ai_recommendation && (
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${REC_COLORS[current.ai_recommendation] ?? 'bg-muted'}`}>
                    {recLabel(current.ai_recommendation)}
                  </span>
                )}
                {current.ai_model_used && (
                  <span className="ml-auto rounded bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {t('appDetail.via', { model: current.ai_model_used })}
                  </span>
                )}
              </div>

              {current.ai_summary && (
                <p className="text-sm leading-relaxed">{current.ai_summary}</p>
              )}

              {strengths.length > 0 && (
                <Block title={t('appDetail.strengths')} items={strengths} tone="positive" />
              )}
              {gaps.length > 0 && (
                <Block title={t('appDetail.gaps')} items={gaps} tone="neutral" />
              )}
              {redFlags.length > 0 && (
                <Block title={t('appDetail.attentionPoints')} items={redFlags} tone="warning" />
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

// ── Onglet Sourcing IA ──────────────────────────────────────────────────────
// Multi-pays Afrique. L'utilisateur choisit l'offre, les pays cibles et les
// plateformes, puis lance soit une génération simple (Claude) soit une
// comparaison parallèle Claude vs Mistral.

// Mapping pays → drapeau (utilisé pour enrichir le catalogue dynamique
// chargé depuis platform.country_configs). Les pays absents reçoivent 🌍.
const COUNTRY_FLAGS: Record<string, string> = {
  CI: '🇨🇮', SN: '🇸🇳', BJ: '🇧🇯', TG: '🇹🇬', CM: '🇨🇲', BF: '🇧🇫',
  ML: '🇲🇱', NE: '🇳🇪', NG: '🇳🇬', GH: '🇬🇭', GA: '🇬🇦', CG: '🇨🇬',
  CD: '🇨🇩', KE: '🇰🇪', TD: '🇹🇩', FR: '🇫🇷',
  CIV: '🇨🇮', SEN: '🇸🇳', BEN: '🇧🇯', TGO: '🇹🇬', BFA: '🇧🇫', MLI: '🇲🇱',
  NER: '🇳🇪', CMR: '🇨🇲', TCD: '🇹🇩', NGA: '🇳🇬', GHA: '🇬🇭',
}

// Catalogue pays (fallback). Le libellé est résolu via i18n au rendu —
// repli sur le libellé statique si la clé n'existe pas (pays hors liste).
const COUNTRY_STATIC_LABELS: Record<string, string> = {
  CI: 'Côte d\'Ivoire', SN: 'Sénégal', BJ: 'Bénin', TG: 'Togo', CM: 'Cameroun',
  BF: 'Burkina Faso', ML: 'Mali', NG: 'Nigeria', GH: 'Ghana', GA: 'Gabon',
  CG: 'Congo', CD: 'RD Congo', KE: 'Kenya', TD: 'Tchad', FR: 'France',
}
const countryLabel = (code: string, fallback?: string) =>
  i18n.exists(`recruitment:countries.${code}`)
    ? i18n.t(`recruitment:countries.${code}`)
    : (fallback ?? COUNTRY_STATIC_LABELS[code] ?? code)

const COUNTRIES: Array<{ code: string; label: string; flag: string }> = [
  { code: 'CI', label: 'Côte d\'Ivoire', flag: '🇨🇮' },
  { code: 'SN', label: 'Sénégal',        flag: '🇸🇳' },
  { code: 'BJ', label: 'Bénin',          flag: '🇧🇯' },
  { code: 'TG', label: 'Togo',           flag: '🇹🇬' },
  { code: 'CM', label: 'Cameroun',       flag: '🇨🇲' },
  { code: 'BF', label: 'Burkina Faso',   flag: '🇧🇫' },
  { code: 'ML', label: 'Mali',           flag: '🇲🇱' },
  { code: 'NG', label: 'Nigeria',        flag: '🇳🇬' },
  { code: 'GH', label: 'Ghana',          flag: '🇬🇭' },
  { code: 'GA', label: 'Gabon',          flag: '🇬🇦' },
  { code: 'CG', label: 'Congo',          flag: '🇨🇬' },
  { code: 'CD', label: 'RD Congo',       flag: '🇨🇩' },
  { code: 'KE', label: 'Kenya',          flag: '🇰🇪' },
  { code: 'TD', label: 'Tchad',          flag: '🇹🇩' },
  { code: 'FR', label: 'France',         flag: '🇫🇷' },
]

const PLATFORMS_PANAFRICAN = ['LinkedIn', 'Africawork', 'JobnetAfrica', 'Indeed', 'Glassdoor']
const PLATFORMS_LOCAL: Record<string, string[]> = {
  CI: ['Emploi.ci', 'RMO Côte d\'Ivoire', 'Novojob'],
  SN: ['Emploi.sn', 'EmploiDakar', 'Senjob'],
  BJ: ['EmploiBénin'],
  TG: ['Emploi-Togo'],
  CM: ['MinaJobs', 'JobsCameroon'],
  NG: ['Jobberman', 'MyJobMag'],
  TD: ['Tchad-Emploi'],
  BF: ['Emploi.bf'],
  ML: ['MaliEmploi'],
  GH: ['Jobberman Ghana'],
  KE: ['BrighterMonday Kenya'],
  FR: ['Welcome to the Jungle', 'Apec', 'Cadremploi'],
}

interface SourcingProfile {
  firstName: string; lastName: string
  currentPosition: string; currentCompany: string
  location: string; experienceYears: number
  keySkills: string[]; matchScore: number
  availabilityEstimate: 'immediate' | '1month' | '3months' | 'passive'
  suggestedPlatform: string; linkedinSearch: string
  approachStrategy: string
  estimatedSalary: number; estimatedSalaryCurrency: string
}

interface SourcingStrategy {
  summary: string
  bestPlatforms: Array<{ name: string; rationale: string; estimatedPool: number; url: string }>
  searchKeywords: string[]; booleanSearch: string
  estimatedTimeToFill: string
  salaryBenchmark: { min: number; max: number; median: number; currency: string }
  tips: string[]
}

interface SourcingData { strategy: SourcingStrategy; profiles: SourcingProfile[] }

interface SourcingResponse {
  data: SourcingData | null
  meta: {
    provider: 'claude' | 'mistral'
    model: string; latencyMs: number
    estimatedCostEur: number; richnessScore: number; jsonValid: boolean
  }
}

interface CompareSummary {
  latencyMs: number; estimatedCostEur: number
  profilesGenerated: number; jsonValid: boolean
  richnessScore: number; error: string | null
}

interface CompareResponse {
  comparison: {
    winner: 'claude' | 'mistral'
    ratios: { latency: string; cost: string; richness: string } | null
    recommendation: string
    summary: { claude: CompareSummary; mistral: CompareSummary }
  }
  results: { claude: SourcingData | null; mistral: SourcingData | null }
}

const availabilityLabel = (a: string) =>
  i18n.exists(`recruitment:availability.${a}`) ? i18n.t(`recruitment:availability.${a}`) : a
const AVAILABILITY_COLOR: Record<string, string> = {
  immediate: 'bg-green-100 text-green-700',
  '1month':  'bg-emerald-100 text-emerald-700',
  '3months': 'bg-yellow-100 text-yellow-700',
  passive:   'bg-gray-100 text-gray-600',
}

// Profil sourcing tel que retourné par l'API /sourced-profiles (snake_case)
interface SourcedProfileRow {
  id: string; job_id: string
  first_name: string; last_name: string
  current_position: string | null; current_company: string | null
  location: string | null; experience_years: number | null
  key_skills: string[] | string | null
  match_score: number | null
  availability_estimate: string | null
  suggested_platform: string | null
  linkedin_search: string | null
  approach_strategy: string | null
  estimated_salary: number | string | null
  estimated_salary_currency: string | null
  email: string | null; phone: string | null
  source_provider: string | null; source_model: string | null
  countries: string[] | null
  transferred_to_application_id: string | null
  transferred_at: string | null
  created_at: string
}

function rowToProfile(row: SourcedProfileRow): SourcingProfile {
  const skills = Array.isArray(row.key_skills)
    ? row.key_skills
    : typeof row.key_skills === 'string'
      ? (() => { try { return JSON.parse(row.key_skills) as string[] } catch { return [] } })()
      : []
  return {
    firstName:               row.first_name,
    lastName:                row.last_name,
    currentPosition:         row.current_position ?? '',
    currentCompany:          row.current_company ?? '',
    location:                row.location ?? '',
    experienceYears:         row.experience_years ?? 0,
    keySkills:               skills,
    matchScore:              row.match_score ?? 0,
    availabilityEstimate:    (row.availability_estimate as SourcingProfile['availabilityEstimate']) ?? 'passive',
    suggestedPlatform:       row.suggested_platform ?? '',
    linkedinSearch:          row.linkedin_search ?? '',
    approachStrategy:        row.approach_strategy ?? '',
    estimatedSalary:         Number(row.estimated_salary ?? 0),
    estimatedSalaryCurrency: row.estimated_salary_currency ?? 'XOF',
  }
}

// ─── Helpers UI : avatars, badges, gradients déterministes ──────────────────

// Hash déterministe → couleur stable pour un nom donné (pas de couleur
// aléatoire qui change à chaque render).
function nameToGradient(firstName: string, lastName: string): string {
  const palette = [
    'from-orange-400 to-pink-500',
    'from-emerald-400 to-teal-500',
    'from-blue-400 to-indigo-500',
    'from-purple-400 to-fuchsia-500',
    'from-amber-400 to-orange-500',
    'from-rose-400 to-red-500',
    'from-cyan-400 to-blue-500',
    'from-lime-400 to-emerald-500',
    'from-violet-400 to-purple-500',
    'from-sky-400 to-cyan-500',
  ]
  const seed = (firstName + lastName).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return palette[seed % palette.length]!
}

function initials(firstName: string, lastName: string): string {
  const a = (firstName || '').trim().charAt(0).toUpperCase()
  const b = (lastName || '').trim().charAt(0).toUpperCase()
  return (a + b) || '?'
}

// Badge match score sémantique : excellent (90+) / très bon (75+) / bon (60+) / faible
function matchTier(score: number): { label: string; classes: string; ringClasses: string } {
  if (score >= 90) return {
    label: i18n.t('recruitment:matchTier.excellent'), classes: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    ringClasses: 'ring-emerald-400 text-emerald-700',
  }
  if (score >= 75) return {
    label: i18n.t('recruitment:matchTier.veryGood'), classes: 'bg-green-100 text-green-800 border-green-300',
    ringClasses: 'ring-green-400 text-green-700',
  }
  if (score >= 60) return {
    label: i18n.t('recruitment:matchTier.good'), classes: 'bg-amber-100 text-amber-800 border-amber-300',
    ringClasses: 'ring-amber-400 text-amber-700',
  }
  return {
    label: i18n.t('recruitment:matchTier.low'), classes: 'bg-rose-100 text-rose-800 border-rose-300',
    ringClasses: 'ring-rose-400 text-rose-700',
  }
}

// Composant avatar circulaire avec initiales sur gradient.
function Avatar({ firstName, lastName, size = 'md' }: {
  firstName: string; lastName: string; size?: 'sm' | 'md' | 'lg'
}) {
  const sizeClasses = {
    sm: 'h-10 w-10 text-sm',
    md: 'h-12 w-12 text-base',
    lg: 'h-16 w-16 text-lg',
  }[size]
  return (
    <div className={`${sizeClasses} flex-shrink-0 rounded-full bg-gradient-to-br ${nameToGradient(firstName, lastName)}
      text-white font-semibold flex items-center justify-center shadow-md ring-2 ring-white`}>
      {initials(firstName, lastName)}
    </div>
  )
}

// Cercle de score (ring SVG) — composant visuellement fort.
function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const tier = matchTier(score)
  const stroke = 4
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c - (Math.min(Math.max(score, 0), 100) / 100) * c
  const color = score >= 90 ? '#10b981' : score >= 75 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg className="-rotate-90" width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" strokeWidth={stroke}
          fill="none" className="text-muted/30" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke}
          fill="none" strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          className="transition-[stroke-dashoffset] duration-700" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`text-sm font-bold ${tier.ringClasses.split(' ').filter(c => c.startsWith('text-')).join(' ')}`}>
          {score}
        </span>
      </div>
    </div>
  )
}

function SourcingTab({ jobs, aiCaps, onTransferred, onGoToKanban }: {
  jobs: Job[]
  aiCaps: { claude: boolean; mistral: boolean }
  onTransferred: () => void
  onGoToKanban: (jobId: string) => void
}) {
  const { t } = useTranslation('recruitment')
  // Pays par défaut = celui du tenant (CIV→CI, etc.). Si tenant mono-pays,
  // on force ce pays et on masque le sélecteur (UI plus simple et adaptée).
  const tenantConfig = useAuthStore((s) => s.tenantConfig)
  const tenantHasSubsidiaries = tenantConfig?.hasSubsidiaries === true
  const tenantDefaultCountry = useMemo(() => {
    const raw = (tenantConfig?.defaultCountryCode ?? 'CIV').toUpperCase()
    // Map ISO-3 vers ISO-2 commun pour le sourcing (CIV → CI, SEN → SN, etc.)
    const ISO3_TO_ISO2: Record<string, string> = {
      CIV: 'CI', SEN: 'SN', BEN: 'BJ', TGO: 'TG', BFA: 'BF', MLI: 'ML',
      NER: 'NE', CMR: 'CM', TCD: 'TD', NGA: 'NG', GHA: 'GH', FRA: 'FR',
    }
    return ISO3_TO_ISO2[raw] ?? raw.slice(0, 2)
  }, [tenantConfig?.defaultCountryCode])

  const [jobId, setJobId] = useState('')
  const [countries, setCountries] = useState<string[]>([tenantDefaultCountry])
  const [maxProfiles, setMaxProfiles] = useState(8)
  const [mode, setMode] = useState<'single' | 'compare'>('single')
  const [model, setModel] = useState<'claude' | 'mistral'>(
    aiCaps.claude ? 'claude' : aiCaps.mistral ? 'mistral' : 'claude',
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [single, setSingle] = useState<SourcingResponse | null>(null)
  const [compare, setCompare] = useState<CompareResponse | null>(null)
  const [contactProfile, setContactProfile] = useState<SourcingProfile | null>(null)
  const [transferringId, setTransferringId] = useState<string | null>(null)
  const [transferringAll, setTransferringAll] = useState(false)
  const [transferMsg, setTransferMsg] = useState<string | null>(null)

  // Profils en cache (seedés ou générés) : chargés automatiquement à la sélection
  const sourcedQuery = useQuery<{ data: SourcedProfileRow[] }>({
    queryKey: ['sourced-profiles', jobId],
    queryFn: () => api.get(`/recruitment/jobs/${jobId}/sourced-profiles`).then(r => r.data),
    enabled: !!jobId,
  })
  const sourcedRows = sourcedQuery.data?.data ?? []
  const pendingCount = sourcedRows.filter(r => !r.transferred_to_application_id).length

  // Catalogue dynamique des pays (depuis platform.country_configs) avec fallback
  // hardcodé si l'API n'est pas disponible (zéro régression UX).
  const countriesQuery = useQuery<{ data: Array<{ country_code: string; country_name: string; currency: string }> }>({
    queryKey: ['platform-country-configs'],
    queryFn: () => api.get('/platform/country-configs').then(r => r.data).catch(() => ({ data: [] })),
    staleTime: 5 * 60_000,
  })
  const countryCatalog = useMemo(() => {
    const fromApi = countriesQuery.data?.data ?? []
    if (fromApi.length > 0) {
      return fromApi.map(c => ({
        code:  c.country_code,
        label: c.country_name,
        flag:  COUNTRY_FLAGS[c.country_code] ?? '🌍',
      }))
    }
    return COUNTRIES // fallback hardcodé
  }, [countriesQuery.data])

  // Plateformes dynamiques (depuis platform.sourcing_platforms), filtrées par pays
  const platformsQuery = useQuery<{ data: Array<{ code: string; name: string; country_code: string | null; is_panafrican: boolean }> }>({
    queryKey: ['platform-sourcing-platforms'],
    queryFn: () => api.get('/platform/sourcing/platforms').then(r => r.data).catch(() => ({ data: [] })),
    staleTime: 5 * 60_000,
  })

  const suggestedPlatforms = useMemo(() => {
    const fromApi = platformsQuery.data?.data ?? []
    if (fromApi.length > 0) {
      const pana = fromApi.filter(p => p.is_panafrican).map(p => p.name)
      const local = fromApi.filter(p => !p.is_panafrican && p.country_code && countries.includes(p.country_code)).map(p => p.name)
      return Array.from(new Set([...pana, ...local]))
    }
    // Fallback hardcodé
    const locals = countries.flatMap(c => PLATFORMS_LOCAL[c] ?? [])
    return [...PLATFORMS_PANAFRICAN, ...locals]
  }, [platformsQuery.data, countries])

  const [platforms, setPlatforms] = useState<string[]>(['LinkedIn', 'Africawork'])
  const togglePlatform = (p: string) => setPlatforms(prev =>
    prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p],
  )
  const toggleCountry = (c: string) => setCountries(prev =>
    prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c],
  )

  const transferOne = async (profileRowId: string) => {
    if (!jobId) return
    setTransferringId(profileRowId)
    setTransferMsg(null)
    try {
      await api.post(`/recruitment/jobs/${jobId}/sourced-profiles/${profileRowId}/transfer`)
      await sourcedQuery.refetch()
      onTransferred()
      setTransferMsg(t('sourcing.transferOk'))
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setTransferMsg(msg ?? t('sourcing.transferError'))
    } finally {
      setTransferringId(null)
    }
  }

  const transferAll = async () => {
    if (!jobId || pendingCount === 0) return
    setTransferringAll(true)
    setTransferMsg(null)
    try {
      const res = await api.post(`/recruitment/jobs/${jobId}/sourced-profiles/transfer-all`)
      await sourcedQuery.refetch()
      onTransferred()
      const n = res.data?.data?.transferred ?? 0
      setTransferMsg(t('sourcing.transferAllOk', { count: n }))
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setTransferMsg(msg ?? t('sourcing.transferAllError'))
    } finally {
      setTransferringAll(false)
    }
  }

  const run = async () => {
    if (!jobId) { setError(t('sourcing.selectOffer')); return }
    if (countries.length === 0) { setError(t('sourcing.selectCountry')); return }
    if (platforms.length === 0) { setError(t('sourcing.selectPlatform')); return }

    setLoading(true)
    setError(null)
    setSingle(null)
    setCompare(null)

    try {
      if (mode === 'compare') {
        const res = await api.post(`/recruitment/jobs/${jobId}/source/compare`, {
          countries, platforms, max_profiles: Math.min(maxProfiles, 10),
        })
        setCompare(res.data)
      } else {
        const res = await api.post(`/recruitment/jobs/${jobId}/source`, {
          model, countries, platforms, max_profiles: maxProfiles,
        })
        setSingle(res.data)
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? t('sourcing.sourcingError'))
    } finally {
      setLoading(false)
    }
  }

  const hasAnyModel = aiCaps.claude || aiCaps.mistral
  const canCompare  = aiCaps.claude && aiCaps.mistral
  const selectedJobObj = jobs.find(j => j.id === jobId)
  const openJobs = jobs.filter(j => j.status === 'open')

  return (
    <div className="space-y-6">
      {/* ── Hero header ────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-indigo-200/60 bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 p-6 shadow-sm">
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-gradient-to-br from-purple-300/30 to-pink-300/30 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-purple-500/30">
            <Wand2 className="h-7 w-7 text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-slate-900">
              {tenantHasSubsidiaries ? t('sourcing.titleMulti') : t('sourcing.title')}
            </h2>
            <p className="mt-1 text-sm text-slate-600 max-w-2xl">
              {tenantHasSubsidiaries ? t('sourcing.introMulti') : t('sourcing.introMono')}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {tenantHasSubsidiaries ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 font-medium text-indigo-700 border border-indigo-200">
                  <Globe className="h-3.5 w-3.5" /> {t('sourcing.countriesAvailable', { count: countryCatalog.length })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 font-medium text-indigo-700 border border-indigo-200">
                  {COUNTRY_FLAGS[tenantDefaultCountry] ?? '🌍'} {countryCatalog.find(c => c.code === tenantDefaultCountry)?.label ?? tenantDefaultCountry}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 font-medium text-purple-700 border border-purple-200">
                <Layers className="h-3.5 w-3.5" /> {t('sourcing.platformsBadge', { count: platformsQuery.data?.data?.length ?? suggestedPlatforms.length })}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 font-medium text-pink-700 border border-pink-200">
                <Sparkles className="h-3.5 w-3.5" />
                {hasAnyModel ? (canCompare ? 'Claude + Mistral' : (aiCaps.claude ? 'Claude' : 'Mistral')) : t('sourcing.noAiModel')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!hasAnyModel && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 flex-shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-semibold text-rose-900">{t('sourcing.noAiModelTitle')}</p>
            <p className="text-xs text-rose-700 mt-0.5">
              {t('sourcing.noAiModelText')}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* ── Panneau de configuration (gauche) ──────────────────────── */}
        <div className="lg:col-span-4 space-y-4">
          {/* Card 1 : Offre */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100">
                <Briefcase className="h-4 w-4 text-indigo-700" />
              </div>
              <label className="text-sm font-semibold">{t('sourcing.offerToSource')}</label>
            </div>
            <select value={jobId} onChange={e => setJobId(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none">
              <option value="">{t('sourcing.chooseOffer')}</option>
              {openJobs.map(j => (
                <option key={j.id} value={j.id}>{j.title} · {j.location}</option>
              ))}
            </select>
            {selectedJobObj && (
              <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
                <MapPin className="h-3 w-3" />{selectedJobObj.location}
                <span className="text-muted-foreground/50">·</span>
                <span className="uppercase">{selectedJobObj.contract_type}</span>
              </div>
            )}
          </div>

          {/* Card 2 : Pays cibles — visible si tenant multi-pays uniquement */}
          {tenantHasSubsidiaries ? (
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100">
                    <Globe className="h-4 w-4 text-purple-700" />
                  </div>
                  <label className="text-sm font-semibold">{t('sourcing.targetCountries')}</label>
                </div>
                <span className="text-xs font-semibold text-purple-700">{t('sourcing.activeCount', { count: countries.length })}</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {countryCatalog.map(c => {
                  const active = countries.includes(c.code)
                  return (
                    <button key={c.code} type="button" onClick={() => toggleCountry(c.code)}
                      title={c.label}
                      className={`group relative flex flex-col items-center gap-0.5 rounded-lg border-2 px-1 py-2 transition-all
                        ${active
                          ? 'border-purple-400 bg-gradient-to-br from-purple-50 to-pink-50 shadow-sm scale-105'
                          : 'border-border bg-card hover:border-purple-300 hover:bg-purple-50/30'}`}>
                      <span className="text-xl leading-none">{c.flag}</span>
                      <span className={`text-[10px] font-medium ${active ? 'text-purple-900' : 'text-muted-foreground'}`}>{c.code}</span>
                      {active && (
                        <CheckCircle className="absolute -top-1.5 -right-1.5 h-3.5 w-3.5 text-purple-600 bg-white rounded-full" />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            // Mono-pays : indicateur compact non-éditable
            <div className="rounded-xl border border-border bg-muted/30 p-3 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100">
                  <Globe className="h-4 w-4 text-purple-700" />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">{t('sourcing.targetedSourcing')}</p>
                  <p className="text-sm font-semibold">
                    {COUNTRY_FLAGS[tenantDefaultCountry] ?? '🌍'} {countryCatalog.find(c => c.code === tenantDefaultCountry)?.label ?? tenantDefaultCountry}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Card 3 : Plateformes */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100">
                  <Layers className="h-4 w-4 text-blue-700" />
                </div>
                <label className="text-sm font-semibold">{t('sourcing.platforms')}</label>
              </div>
              <span className="text-xs font-semibold text-blue-700">{t('sourcing.checkedCount', { count: platforms.length })}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {suggestedPlatforms.map(p => {
                const active = platforms.includes(p)
                return (
                  <button key={p} type="button" onClick={() => togglePlatform(p)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors
                      ${active
                        ? 'border-blue-400 bg-blue-50 text-blue-800'
                        : 'border-border bg-card text-muted-foreground hover:border-blue-300 hover:bg-blue-50/50'}`}>
                    {active && <CheckCircle className="h-3 w-3" />}
                    {p}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Card 4 : Nombre profils */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100">
                  <Users className="h-4 w-4 text-amber-700" />
                </div>
                <label className="text-sm font-semibold">{t('sourcing.profileCount')}</label>
              </div>
              <span className="rounded-md bg-gradient-to-r from-amber-500 to-orange-500 px-2 py-0.5 text-xs font-bold text-white shadow-sm">
                {maxProfiles}
              </span>
            </div>
            <input type="range" min="3" max="20" value={maxProfiles}
              onChange={e => setMaxProfiles(Number(e.target.value))}
              className="mt-2 w-full accent-amber-500" />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>3</span><span>10</span><span>20</span>
            </div>
          </div>

          {/* Card 5 : Mode + Modèle */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-pink-100">
                <Zap className="h-4 w-4 text-pink-700" />
              </div>
              <label className="text-sm font-semibold">{t('sourcing.generationMode')}</label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setMode('single')}
                className={`rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-all
                  ${mode === 'single'
                    ? 'border-pink-400 bg-gradient-to-br from-pink-50 to-rose-50 text-pink-900 shadow-sm'
                    : 'border-border hover:border-pink-300'}`}>
                <Sparkles className="h-4 w-4 mx-auto mb-1" />
                {t('sourcing.single')}
              </button>
              <button type="button" onClick={() => setMode('compare')}
                disabled={!canCompare}
                title={!canCompare ? t('sourcing.compareRequiresMistral') : ''}
                className={`rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-all
                  ${mode === 'compare'
                    ? 'border-pink-400 bg-gradient-to-br from-pink-50 to-rose-50 text-pink-900 shadow-sm'
                    : 'border-border hover:border-pink-300'}
                  ${!canCompare ? 'opacity-40 cursor-not-allowed' : ''}`}>
                <TrendingUp className="h-4 w-4 mx-auto mb-1" />
                {t('sourcing.compare')}
              </button>
            </div>

            {mode === 'single' && hasAnyModel && (
              <div className="mt-3">
                <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider">{t('sourcing.aiModel')}</label>
                <div className="mt-1 flex gap-2">
                  {(['claude', 'mistral'] as const).map(m => (
                    <button key={m} type="button" disabled={!aiCaps[m]}
                      onClick={() => setModel(m)}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors
                        ${model === m ? 'border-pink-400 bg-pink-50 text-pink-700' : 'border-border hover:bg-accent'}
                        ${!aiCaps[m] ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      {m === 'claude' ? 'Claude' : 'Mistral'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* CTA principal */}
          <button onClick={run} disabled={loading || !jobId || !hasAnyModel}
            className="group relative w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/30 transition-all hover:shadow-xl hover:shadow-purple-500/40 hover:-translate-y-0.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-lg">
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin" /> {mode === 'compare' ? t('sourcing.comparing') : t('sourcing.generating')}</>
              : <><Wand2 className="h-4 w-4 group-hover:rotate-12 transition-transform" /> {mode === 'compare' ? t('sourcing.launchCompare') : t('sourcing.generateProfiles')}</>}
          </button>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 flex items-start gap-2">
              <XCircle className="h-4 w-4 flex-shrink-0 text-rose-600 mt-0.5" />
              <p className="text-xs text-rose-700">{error}</p>
            </div>
          )}
        </div>

        {/* ── Résultats (droite) ──────────────────────────────────────── */}
        <div className="lg:col-span-8 space-y-4">
          {/* Bannière profils sourcés en cache */}
          {jobId && sourcedRows.length > 0 && (
            <div className="relative overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-green-50 to-teal-50 p-5 shadow-sm">
              <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-300/20 blur-2xl" />
              <div className="relative flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-md">
                    <Award className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-emerald-900">
                      {t('sourcing.profilesSourced', { count: sourcedRows.length })}
                    </h3>
                    <p className="text-xs text-emerald-700/90 mt-0.5">
                      {pendingCount > 0
                        ? <Trans i18nKey="sourcing.pendingTransfer" t={t} values={{ pending: pendingCount, done: sourcedRows.length - pendingCount }} components={{ strong: <strong /> }} />
                        : t('sourcing.allTransferred')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {pendingCount > 0 && (
                    <button onClick={transferAll} disabled={transferringAll}
                      className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-2 text-xs font-semibold text-white shadow-md hover:shadow-lg transition-all hover:-translate-y-0.5 disabled:opacity-50">
                      {transferringAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      {t('sourcing.transferAll', { count: pendingCount })}
                    </button>
                  )}
                  <button onClick={() => onGoToKanban(jobId)}
                    className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white/90 px-3.5 py-2 text-xs font-semibold text-emerald-700 hover:bg-white">
                    {t('sourcing.viewKanban')} <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {transferMsg && (
                <div className="relative mt-3 flex items-center gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-emerald-800">
                  <CheckCircle className="h-4 w-4 text-emerald-600" />
                  {transferMsg}
                </div>
              )}
            </div>
          )}

          {jobId && sourcedQuery.isLoading && (
            <div className="grid gap-3 sm:grid-cols-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="rounded-xl border border-border bg-card p-4 animate-pulse">
                  <div className="flex gap-3">
                    <div className="h-12 w-12 rounded-full bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-muted rounded w-3/4" />
                      <div className="h-2 bg-muted rounded w-1/2" />
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="h-2 bg-muted rounded" />
                    <div className="h-2 bg-muted rounded w-5/6" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Grid de profils sourcés (en cache) */}
          {sourcedRows.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {sourcedRows.map(row => (
                <ProfileCard
                  key={row.id}
                  profile={rowToProfile(row)}
                  onContact={() => setContactProfile(rowToProfile(row))}
                  transferable={{
                    state: row.transferred_to_application_id
                      ? 'transferred'
                      : transferringId === row.id ? 'transferring' : 'pending',
                    onTransfer: () => transferOne(row.id),
                  }}
                />
              ))}
            </div>
          )}

          {/* Empty states */}
          {!single && !compare && !loading && sourcedRows.length === 0 && jobId && !sourcedQuery.isLoading && (
            <EmptyState
              icon={Target}
              title={t('sourcing.noProfilesTitle')}
              hint={t('sourcing.noProfilesHint')}
              tone="info"
            />
          )}

          {!jobId && (
            <EmptyState
              icon={Briefcase}
              title={t('sourcing.noOfferTitle')}
              hint={t('sourcing.noOfferHint')}
              tone="indigo"
            />
          )}

          {/* Résultats de la dernière génération */}
          {single?.data && (
            <SourcingStrategyCard strategy={single.data.strategy} meta={single.meta} />
          )}
          {single?.data && single.data.profiles.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {single.data.profiles.map((p, i) => (
                <ProfileCard key={`gen-${i}`} profile={p} onContact={() => setContactProfile(p)} />
              ))}
            </div>
          )}

          {compare && (
            <CompareReport compare={compare} onContact={setContactProfile} />
          )}
        </div>
      </div>

      {contactProfile && (
        <ContactDialog profile={contactProfile} onClose={() => setContactProfile(null)} />
      )}
    </div>
  )
}

// ─── Empty state stylisé ────────────────────────────────────────────────────
function EmptyState({ icon: Icon, title, hint, tone = 'info' }: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  hint: string
  tone?: 'info' | 'indigo' | 'emerald'
}) {
  const styles = {
    info:    { ring: 'from-slate-200 to-slate-300', icon: 'text-slate-500',   bg: 'bg-slate-50/50',    border: 'border-slate-200' },
    indigo:  { ring: 'from-indigo-200 to-purple-300', icon: 'text-indigo-600', bg: 'bg-indigo-50/40',   border: 'border-indigo-200' },
    emerald: { ring: 'from-emerald-200 to-teal-300', icon: 'text-emerald-600', bg: 'bg-emerald-50/40', border: 'border-emerald-200' },
  }[tone]
  return (
    <div className={`rounded-2xl border-2 border-dashed ${styles.border} ${styles.bg} p-10 text-center`}>
      <div className={`mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br ${styles.ring}`}>
        <Icon className={`h-8 w-8 ${styles.icon}`} />
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">{hint}</p>
    </div>
  )
}

// ─── Stratégie de sourcing ──────────────────────────────────────────────────
function SourcingStrategyCard({ strategy, meta }: {
  strategy: SourcingStrategy
  meta: SourcingResponse['meta']
}) {
  const { t } = useTranslation('recruitment')
  return (
    <div className="overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-white via-indigo-50/30 to-purple-50/30 shadow-sm">
      {/* Header gradient */}
      <div className="flex items-start justify-between gap-3 bg-gradient-to-r from-indigo-100/70 to-purple-100/70 px-5 py-3 border-b border-indigo-200">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-indigo-900">{t('strategy.title')}</h3>
            <p className="text-[11px] text-indigo-700/70">{t('strategy.generatedBy', { provider: meta.provider === 'claude' ? t('strategy.claudeAnthropic') : t('strategy.mistral') })}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[10px] font-semibold text-indigo-700 border border-indigo-200">
            <Star className="h-3 w-3" /> {meta.richnessScore}/100
          </span>
          <span className="rounded-md bg-white px-2 py-1 text-[10px] font-mono text-indigo-700 border border-indigo-200">
            ⏱ {meta.latencyMs}ms
          </span>
          <span className="rounded-md bg-white px-2 py-1 text-[10px] font-mono text-indigo-700 border border-indigo-200">
            💰 {meta.estimatedCostEur.toFixed(4)} €
          </span>
        </div>
      </div>

      <div className="p-5 space-y-4">
        <p className="text-sm text-slate-700 leading-relaxed">{strategy.summary}</p>

        {strategy.bestPlatforms.length > 0 && (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 mb-2 flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5" /> {t('strategy.recommendedPlatforms')}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {strategy.bestPlatforms.map((p, i) => (
                <div key={i} className="rounded-lg border border-indigo-100 bg-white px-3 py-2 hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800">{p.name}</span>
                    <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                      ~{p.estimatedPool}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">{p.rationale}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {strategy.booleanSearch && (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 mb-2 flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5" /> {t('strategy.booleanSearch')}
            </p>
            <code className="block rounded-lg bg-slate-900 px-3 py-2 text-xs text-emerald-300 font-mono border border-slate-700 overflow-x-auto">
              {strategy.booleanSearch}
            </code>
          </div>
        )}

        {strategy.salaryBenchmark.median > 0 && (
          <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-emerald-700" />
              <span className="text-xs font-bold text-emerald-900">{t('strategy.salaryBenchmark')}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-emerald-700 font-mono">
                {strategy.salaryBenchmark.median.toLocaleString('fr-FR')}
              </span>
              <span className="text-xs text-emerald-700/70">{t('strategy.median', { currency: strategy.salaryBenchmark.currency })}</span>
            </div>
            <div className="text-[11px] text-emerald-700/80 mt-0.5">
              {t('strategy.range', { min: strategy.salaryBenchmark.min.toLocaleString('fr-FR'), max: strategy.salaryBenchmark.max.toLocaleString('fr-FR'), currency: strategy.salaryBenchmark.currency })}
            </div>
          </div>
        )}

        {strategy.tips.length > 0 && (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 mb-2 flex items-center gap-1.5">
              <Quote className="h-3.5 w-3.5" /> {t('strategy.tips')}
            </p>
            <ul className="space-y-1.5">
              {strategy.tips.map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
                  <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-indigo-500" />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── ProfileCard refondue ───────────────────────────────────────────────────
function ProfileCard({ profile, onContact, transferable }: {
  profile: SourcingProfile
  onContact: () => void
  transferable?: {
    state: 'pending' | 'transferring' | 'transferred'
    onTransfer: () => void
  }
}) {
  const { t } = useTranslation('recruitment')
  const tier = matchTier(profile.matchScore)
  const isTransferred = transferable?.state === 'transferred'

  return (
    <div className={`group relative overflow-hidden rounded-2xl border bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg
      ${isTransferred
        ? 'border-emerald-300 bg-gradient-to-br from-emerald-50/40 to-teal-50/30 shadow-emerald-100'
        : 'border-border hover:border-indigo-300'}`}>
      {/* Bandeau "Dans le pipeline" si transféré */}
      {isTransferred && (
        <div className="absolute top-0 right-0 z-10 rounded-bl-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow-md">
          <CheckCircle className="inline h-3 w-3 mr-0.5" /> {t('profileCard.inPipeline')}
        </div>
      )}

      <div className="p-4">
        {/* Header : Avatar + identité + score */}
        <div className="flex items-start gap-3">
          <Avatar firstName={profile.firstName} lastName={profile.lastName} size="md" />

          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-bold text-slate-900 truncate">
              {profile.firstName} {profile.lastName}
            </h4>
            <p className="text-xs text-slate-600 truncate">
              {profile.currentPosition}
            </p>
            {profile.currentCompany && (
              <p className="text-[11px] text-slate-500 truncate">
                @ {profile.currentCompany}
              </p>
            )}
          </div>

          <ScoreRing score={profile.matchScore} size={48} />
        </div>

        {/* Méta : disponibilité + localisation + expérience */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${AVAILABILITY_COLOR[profile.availabilityEstimate] ?? 'bg-muted'}`}>
            {availabilityLabel(profile.availabilityEstimate)}
          </span>
          <span className="inline-flex items-center gap-1 text-slate-600">
            <MapPin className="h-3 w-3" /> {profile.location}
          </span>
          {profile.experienceYears > 0 && (
            <span className="inline-flex items-center gap-1 text-slate-600">
              <Briefcase className="h-3 w-3" /> {t('profileCard.years', { count: profile.experienceYears })}
            </span>
          )}
        </div>

        {/* Skills */}
        {profile.keySkills.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {profile.keySkills.slice(0, 6).map((s, i) => (
              <span key={i} className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 border border-indigo-100">
                {s}
              </span>
            ))}
            {profile.keySkills.length > 6 && (
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                +{profile.keySkills.length - 6}
              </span>
            )}
          </div>
        )}

        {/* Approche : citation stylisée */}
        {profile.approachStrategy && (
          <div className="mt-3 rounded-lg bg-gradient-to-r from-indigo-50/50 to-purple-50/50 border border-indigo-100 p-2.5">
            <div className="flex items-start gap-1.5">
              <Quote className="h-3 w-3 mt-0.5 flex-shrink-0 text-indigo-400" />
              <p className="text-[11px] text-slate-700 italic leading-relaxed line-clamp-3">
                {profile.approachStrategy}
              </p>
            </div>
          </div>
        )}

        {/* Footer : plateforme + salaire + actions */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
          {profile.suggestedPlatform && (
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
              <Layers className="h-2.5 w-2.5" /> {profile.suggestedPlatform}
            </span>
          )}
          {profile.estimatedSalary > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
              {profile.estimatedSalary.toLocaleString('fr-FR')} {profile.estimatedSalaryCurrency}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={onContact}
              className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 transition-colors">
              <Mail className="h-3 w-3" /> {t('profileCard.message')}
            </button>
            {transferable && !isTransferred && (
              <button onClick={transferable.onTransfer}
                disabled={transferable.state === 'transferring'}
                className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:hover:translate-y-0">
                {transferable.state === 'transferring'
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Send className="h-3 w-3" />}
                {t('profileCard.transfer')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Rapport comparatif Claude vs Mistral ───────────────────────────────────
function CompareReport({ compare, onContact }: {
  compare: CompareResponse
  onContact: (p: SourcingProfile) => void
}) {
  const { t } = useTranslation('recruitment')
  const [view, setView] = useState<'claude' | 'mistral'>(compare.comparison.winner)
  const winnerLabel = compare.comparison.winner === 'claude' ? t('compareReport.winnerClaude') : t('compareReport.winnerMistral')
  const result = view === 'claude' ? compare.results.claude : compare.results.mistral
  const summary = view === 'claude' ? compare.comparison.summary.claude : compare.comparison.summary.mistral

  return (
    <div className="space-y-4">
      {/* Hero comparatif */}
      <div className="relative overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 shadow-sm">
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-orange-300/20 blur-3xl" />
        <div className="relative p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-md">
                <TrendingUp className="h-6 w-6 text-white" />
              </div>
              <div>
                <h3 className="text-base font-bold text-amber-900">{t('compareReport.title')}</h3>
                <p className="text-xs text-amber-700">{t('compareReport.subtitle')}</p>
              </div>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1.5 text-sm font-bold text-white shadow-md">
              <Award className="h-4 w-4" />
              {t('compareReport.winner', { winner: winnerLabel })}
            </div>
          </div>

          <p className="text-sm text-amber-900 leading-relaxed rounded-xl bg-white/60 border border-amber-200 p-3">
            {compare.comparison.recommendation}
          </p>

          {/* Métriques côte à côte */}
          <div className="grid grid-cols-2 gap-3">
            {(['claude', 'mistral'] as const).map(m => {
              const s = compare.comparison.summary[m]
              const isWinner = compare.comparison.winner === m
              return (
                <div key={m}
                  className={`relative rounded-xl border-2 bg-white p-3 transition-all ${
                    isWinner
                      ? 'border-amber-400 shadow-md shadow-amber-200/50 ring-2 ring-amber-100'
                      : 'border-slate-200'
                  }`}>
                  {isWinner && (
                    <div className="absolute -top-2 right-3 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-2 py-0.5 text-[10px] font-bold text-white">
                      {t('compareReport.winnerBadge')}
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold uppercase tracking-wide text-slate-800">{m}</span>
                    {s.jsonValid
                      ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          <CheckCircle className="h-2.5 w-2.5" /> OK
                        </span>
                      : <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                          <XCircle className="h-2.5 w-2.5" /> KO
                        </span>}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('compareReport.latency')}</div>
                      <div className="font-bold text-slate-800 font-mono">{s.latencyMs}ms</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('compareReport.cost')}</div>
                      <div className="font-bold text-slate-800 font-mono">{s.estimatedCostEur.toFixed(4)}€</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('compareReport.profiles')}</div>
                      <div className="font-bold text-slate-800 font-mono">{s.profilesGenerated}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('compareReport.richness')}</div>
                      <div className="font-bold text-slate-800 font-mono">{s.richnessScore}/100</div>
                    </div>
                  </div>
                  {s.error && (
                    <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-[10px] text-rose-700 italic line-clamp-2">
                      {s.error.slice(0, 120)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Ratios visuels */}
          {compare.comparison.ratios && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="flex items-center gap-2 rounded-lg bg-white border border-amber-200 px-3 py-2 text-xs text-amber-900">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100">⏱</span>
                {compare.comparison.ratios.latency}
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-white border border-amber-200 px-3 py-2 text-xs text-amber-900">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100">💰</span>
                {compare.comparison.ratios.cost}
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-white border border-amber-200 px-3 py-2 text-xs text-amber-900">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100">⭐</span>
                {compare.comparison.ratios.richness}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toggle vue résultats */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{t('compareReport.viewResultsOf')}</span>
        <div className="inline-flex gap-1 rounded-lg border border-border bg-card p-1">
          {(['claude', 'mistral'] as const).map(m => (
            <button key={m} onClick={() => setView(m)}
              disabled={!compare.results[m]}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors
                ${view === m
                  ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'}
                ${!compare.results[m] ? 'opacity-40 cursor-not-allowed' : ''}`}>
              {m === 'claude' ? 'Claude' : 'Mistral'}
            </button>
          ))}
        </div>
      </div>

      {result && (
        <>
          <SourcingStrategyCard strategy={result.strategy} meta={{
            provider: view, model: view,
            latencyMs: summary.latencyMs,
            estimatedCostEur: summary.estimatedCostEur,
            richnessScore: summary.richnessScore,
            jsonValid: summary.jsonValid,
          }} />
          {result.profiles.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {result.profiles.map((p, i) => (
                <ProfileCard key={i} profile={p} onContact={() => onContact(p)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Dialog de contact — design pro ─────────────────────────────────────────
function ContactDialog({ profile, onClose }: {
  profile: SourcingProfile
  onClose: () => void
}) {
  const { t } = useTranslation('recruitment')
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null)

  const subject = t('contactDialog.subjectTemplate', {
    position: profile.currentPosition || t('contactDialog.positionFallback'),
  })
  const body = t('contactDialog.bodyTemplate', {
    firstName: profile.firstName,
    company: profile.currentCompany || t('contactDialog.companyFallback'),
    position: profile.currentPosition || t('contactDialog.positionBodyFallback'),
    location: profile.location,
  })

  const copy = (text: string, type: 'subject' | 'body') => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(type)
      setTimeout(() => setCopied(null), 2000)
    }).catch(() => {})
  }

  const linkedinUrl = profile.linkedinSearch
    ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(profile.linkedinSearch)}`
    : `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${profile.firstName} ${profile.lastName} ${profile.currentCompany}`)}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in" onClick={onClose}>
      <div className="overflow-hidden rounded-2xl border border-border bg-card w-full max-w-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header avec avatar + identité */}
        <div className="relative overflow-hidden bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 px-6 py-5 border-b border-border">
          <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-purple-300/20 blur-3xl" />
          <div className="relative flex items-start justify-between">
            <div className="flex items-center gap-4">
              <Avatar firstName={profile.firstName} lastName={profile.lastName} size="lg" />
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  {profile.firstName} {profile.lastName}
                </h3>
                <p className="text-sm text-slate-700">{profile.currentPosition}</p>
                {profile.currentCompany && (
                  <p className="text-xs text-slate-500">@ {profile.currentCompany} · {profile.location}</p>
                )}
              </div>
            </div>
            <button onClick={onClose}
              className="rounded-full p-1.5 hover:bg-white/60 transition-colors"
              aria-label={t('contactDialog.close')}>
              <XCircle className="h-5 w-5 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Body : champs */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t('contactDialog.subject')}</label>
              <button onClick={() => copy(subject, 'subject')}
                className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1">
                {copied === 'subject' ? <><CheckCircle className="h-3 w-3" /> {t('contactDialog.copied')}</> : t('contactDialog.copy')}
              </button>
            </div>
            <input readOnly value={subject}
              onClick={e => (e.target as HTMLInputElement).select()}
              className="w-full rounded-lg border border-input bg-slate-50 px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-200 outline-none" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{t('contactDialog.approachMessage')}</label>
              <button onClick={() => copy(body, 'body')}
                className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1">
                {copied === 'body' ? <><CheckCircle className="h-3 w-3" /> {t('contactDialog.copied')}</> : t('contactDialog.copy')}
              </button>
            </div>
            <textarea readOnly value={body} rows={8}
              onClick={e => (e.target as HTMLTextAreaElement).select()}
              className="w-full rounded-lg border border-input bg-slate-50 px-3 py-2.5 text-sm font-mono leading-relaxed focus:ring-2 focus:ring-indigo-200 outline-none resize-none" />
          </div>

          {profile.linkedinSearch && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1">
                <Linkedin className="h-4 w-4 text-blue-700" />
                <span className="text-xs font-semibold text-blue-900">{t('contactDialog.linkedinSuggested')}</span>
              </div>
              <code className="text-[11px] text-blue-800 font-mono break-all">{profile.linkedinSearch}</code>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-slate-50 px-6 py-3">
          <button onClick={() => copy(body, 'body')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-xs font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all">
            <Mail className="h-3.5 w-3.5" />
            {t('contactDialog.copyMessage')}
          </button>
          <a href={linkedinUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-4 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50 transition-colors">
            <Linkedin className="h-3.5 w-3.5" />
            {t('contactDialog.searchLinkedin')}
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
          <button onClick={onClose} className="ml-auto text-xs font-medium text-slate-500 hover:text-slate-700">
            {t('contactDialog.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modale d'édition d'une offre ───────────────────────────────────────────
function EditJobModal({ job, departments, submitting, onClose, onSubmit }: {
  job: Job
  departments: Department[]
  submitting: boolean
  onClose: () => void
  onSubmit: (patch: Record<string, unknown>) => void
}) {
  const { t } = useTranslation('recruitment')
  const [form, setForm] = useState({
    title: job.title,
    department_id: job.department_id ?? '',
    location: job.location,
    contract_type: job.contract_type,
    salary_min: job.salary_min ?? '',
    salary_max: job.salary_max ?? '',
    status: job.status,
    visibility: (job.visibility ?? 'external') as 'external' | 'internal' | 'both',
    description: job.description ?? '',
    requirements: job.requirements ?? '',
    // Structure APEC
    experience_level: job.experience_level ?? '',
    job_level: job.job_level ?? '',
    sector: job.sector ?? '',
    required_education: job.required_education ?? '',
    work_mode: job.work_mode ?? '',
    start_date: job.start_date ? job.start_date.slice(0, 10) : '',
    benefits: job.benefits ?? '',
    recruitment_process: job.recruitment_process ?? '',
    // Ciblage interne
    target_departments: job.target_departments ?? [],
    target_job_levels: job.target_job_levels ?? [],
    target_min_seniority_months: job.target_min_seniority_months != null ? String(job.target_min_seniority_months) : '',
  })
  const isInternal = form.visibility !== 'external'
  const toggleDept = (id: string) => setForm(p => ({
    ...p, target_departments: p.target_departments.includes(id)
      ? p.target_departments.filter(d => d !== id) : [...p.target_departments, id],
  }))
  const toggleLevel = (lvl: string) => setForm(p => ({
    ...p, target_job_levels: p.target_job_levels.includes(lvl)
      ? p.target_job_levels.filter(l => l !== lvl) : [...p.target_job_levels, lvl],
  }))

  const submit = () => onSubmit({
    title: form.title,
    department_id: form.department_id || null,
    location: form.location,
    contract_type: form.contract_type,
    status: form.status,
    visibility: form.visibility,
    salary_min: form.salary_min ? parseInt(String(form.salary_min)) : null,
    salary_max: form.salary_max ? parseInt(String(form.salary_max)) : null,
    description: form.description || null,
    requirements: form.requirements || null,
    experience_level: form.experience_level || null,
    job_level: form.job_level || null,
    sector: form.sector || null,
    required_education: form.required_education || null,
    work_mode: form.work_mode || null,
    start_date: form.start_date || null,
    benefits: form.benefits || null,
    recruitment_process: form.recruitment_process || null,
    // Ciblage interne réinitialisé si l'offre redevient purement externe.
    target_departments: isInternal ? form.target_departments : [],
    target_job_levels: isInternal ? form.target_job_levels : [],
    target_min_seniority_months: isInternal && form.target_min_seniority_months
      ? parseInt(String(form.target_min_seniority_months)) : null,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="rounded-xl border border-border bg-card w-full max-w-2xl max-h-[min(90vh,720px)] flex flex-col shadow-xl my-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-5 py-3 rounded-t-xl">
          <div>
            <h3 className="font-semibold">{t('editJobModal.title')}</h3>
            {job.reference && <p className="text-[11px] text-muted-foreground">{t('editJobModal.reference', { reference: job.reference })}</p>}
          </div>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-accent"><XCircle className="h-5 w-5 text-muted-foreground" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.jobTitle')}</label>
            <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.department')}</label>
            <select value={form.department_id} onChange={e => setForm(p => ({ ...p, department_id: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              <option value="">{t('newJobModal.noDepartment')}</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.location')}</label>
              <input value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.contractType')}</label>
              <select value={form.contract_type} onChange={e => setForm(p => ({ ...p, contract_type: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="cdi">{t('contractType.cdi')}</option>
                <option value="cdd">{t('contractType.cdd')}</option>
                <option value="stage">{t('contractType.stage')}</option>
                <option value="apprentissage">{t('contractType.apprentissage')}</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('editJobModal.status')}</label>
              <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                <option value="open">{t('jobStatus.open')}</option>
                <option value="paused">{t('jobStatus.paused')}</option>
                <option value="closed">{t('jobStatus.closed')}</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.salaryMin')}</label>
              <input type="number" value={form.salary_min} onChange={e => setForm(p => ({ ...p, salary_min: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.salaryMax')}</label>
              <input type="number" value={form.salary_max} onChange={e => setForm(p => ({ ...p, salary_max: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.description')}</label>
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.requirements')}</label>
            <textarea value={form.requirements} onChange={e => setForm(p => ({ ...p, requirements: e.target.value }))}
              rows={2} className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
          </div>

          {/* ── Structure d'offre APEC ── */}
          <div className="border-t border-border pt-3 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground">{t('newJobModal.apecStructure')}</p>
            <div className="grid grid-cols-2 gap-3">
              {([
                { key: 'experience_level',   label: t('newJobModal.experience'),    opts: EXPERIENCE_OPTIONS },
                { key: 'job_level',          label: t('newJobModal.jobLevelLabel'), opts: JOB_LEVEL_OPTIONS },
                { key: 'required_education', label: t('newJobModal.education'),      opts: EDUCATION_OPTIONS },
                { key: 'sector',             label: t('newJobModal.sector'),         opts: SECTOR_OPTIONS },
                { key: 'work_mode',          label: t('newJobModal.workMode'),       opts: WORK_MODE_OPTIONS },
              ] as const).map(({ key, label, opts }) => (
                <div key={key}>
                  <label className="text-xs font-medium text-muted-foreground">{label}</label>
                  <select value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                    <option value="">—</option>
                    {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.startDate')}</label>
                <input type="date" value={form.start_date}
                  onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.benefits')}</label>
              <textarea value={form.benefits} onChange={e => setForm(p => ({ ...p, benefits: e.target.value }))}
                rows={2} placeholder={t('newJobModal.benefitsPlaceholder')}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.recruitmentProcess')}</label>
              <textarea value={form.recruitment_process} onChange={e => setForm(p => ({ ...p, recruitment_process: e.target.value }))}
                rows={2} placeholder={t('newJobModal.recruitmentProcessPlaceholder')}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none" />
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.jobVisibility')}</label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(['external', 'internal', 'both'] as const).map(v => {
                const cfg = VISIBILITY_CONFIG[v]!
                const Icon = cfg.icon
                return (
                  <button key={v} type="button" onClick={() => setForm(p => ({ ...p, visibility: v }))}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${form.visibility === v ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>
                    <Icon className="h-4 w-4" /> {visibilityLabel(v)}
                  </button>
                )
              })}
            </div>
          </div>

          {isInternal && (
            <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3 space-y-3">
              <p className="text-xs font-medium text-purple-700">{t('newJobModal.internalTargeting')}</p>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.targetDepartments')}</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {departments.length === 0 && <span className="text-xs text-muted-foreground italic">{t('newJobModal.noDepartmentAvailable')}</span>}
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
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.targetCategories')}</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {JOB_LEVELS.map(lvl => {
                    const active = form.target_job_levels.includes(lvl)
                    return (
                      <button key={lvl} type="button" onClick={() => toggleLevel(lvl)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${active ? 'border-purple-500 bg-purple-100 text-purple-700' : 'border-border hover:bg-accent'}`}>
                        {jobLevelLabel(lvl)}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newJobModal.minSeniority')}</label>
                <input type="number" min="0" value={form.target_min_seniority_months}
                  onChange={e => setForm(p => ({ ...p, target_min_seniority_months: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  placeholder={t('newJobModal.minSeniorityPlaceholder')} />
              </div>
            </div>
          )}
        </div>
        <div className="sticky bottom-0 z-10 flex gap-2 justify-end border-t border-border bg-card px-5 py-3 rounded-b-xl">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('newJobModal.cancel')}</button>
          <button onClick={submit} disabled={!form.title || submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? t('editJobModal.saving') : t('editJobModal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modale de partage (style Greenhouse) ───────────────────────────────────
function ShareJobModal({ job, publicUrl, onClose, onCopied }: {
  job: Job
  publicUrl: string
  onClose: () => void
  onCopied: (msg: string) => void
}) {
  const { t } = useTranslation('recruitment')
  const fullUrl = publicUrl  // Page carrières du tenant (l'offre est listée dedans)
  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => onCopied(label)).catch(() => {})
  }
  const sharePayload = encodeURIComponent(t('shareModal.shareText', { title: job.title, url: fullUrl }))
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="rounded-2xl border border-border bg-card w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white px-5 py-4 flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider opacity-80">{t('shareModal.shareJob')}</p>
            <h3 className="text-base font-bold leading-tight mt-0.5">{job.title}</h3>
          </div>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-white/20">
            <XCircle className="h-5 w-5 text-white" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{t('shareModal.publicLink')}</label>
            <div className="mt-1 flex gap-2">
              <input readOnly value={fullUrl}
                onClick={e => (e.target as HTMLInputElement).select()}
                className="flex-1 rounded-lg border border-input bg-slate-50 px-3 py-2 text-xs font-mono" />
              <button onClick={() => copy(fullUrl, t('shareModal.linkCopied'))}
                className="inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700">
                <Copy className="h-3.5 w-3.5" /> {t('shareModal.copy')}
              </button>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{t('shareModal.shareOn')}</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(fullUrl)}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-blue-50 hover:border-blue-300">
                <Linkedin className="h-4 w-4 text-blue-600" /> LinkedIn
              </a>
              <a href={`https://wa.me/?text=${sharePayload}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-emerald-50 hover:border-emerald-300">
                <Send className="h-4 w-4 text-emerald-600" /> WhatsApp
              </a>
              <a href={`https://twitter.com/intent/tweet?text=${sharePayload}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-sky-50 hover:border-sky-300">
                <Share2 className="h-4 w-4 text-sky-500" /> Twitter / X
              </a>
              <a href={`mailto:?subject=${encodeURIComponent(t('shareModal.emailSubject', { title: job.title }))}&body=${sharePayload}`}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-amber-50 hover:border-amber-300">
                <Mail className="h-4 w-4 text-amber-600" /> Email
              </a>
            </div>
          </div>

          <a href={fullUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg">
            <ExternalLink className="h-4 w-4" /> {t('shareModal.previewPublic')}
          </a>
        </div>
      </div>
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

// ── Critères de pré-tri (règles dures) — paramétrables par l'admin du tenant ──
// 100% configurable par offre (rien en dur). Charge GET, sauvegarde PUT.
// Les règles s'appliquent au lancement de la pré-sélection (auto-rejet si
// knockout / score sous seuil). Une donnée candidate inconnue ne rejette jamais.
// value = code stocké côté API ; libellé résolu via i18n (clé technique = code,
// avec normalisation des codes contenant un "+" vers une clé valide).
const DIPLOMA_OPTION_VALUES: Array<{ value: string; tKey: string }> = [
  { value: '',         tKey: 'none' },
  { value: 'cep',      tKey: 'cep' },
  { value: 'bepc',     tKey: 'bepc' },
  { value: 'cap',      tKey: 'cap' },
  { value: 'bac',      tKey: 'bac' },
  { value: 'bac+2',    tKey: 'bac2' },
  { value: 'bac+3',    tKey: 'bac3' },
  { value: 'bac+4',    tKey: 'bac4' },
  { value: 'bac+5',    tKey: 'bac5' },
  { value: 'doctorat', tKey: 'doctorat' },
]

interface ScreeningCriteriaForm {
  minExperienceYears: string
  requiredSkills: string
  allowedLocations: string
  requiredLanguages: string
  maxExpectedSalary: string
  minDiploma: string
  autoRejectBelowScore: string
  knockoutEnabled: boolean
}

function ScreeningCriteriaPanel({ jobId }: { jobId: string }) {
  const { t } = useTranslation('recruitment')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<ScreeningCriteriaForm | null>(null)
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery<{ data: { criteria: Record<string, unknown> } }>({
    queryKey: ['screening-criteria', jobId],
    queryFn: () => api.get(`/recruitment/jobs/${jobId}/screening-criteria`).then(r => r.data),
    enabled: open,
  })

  // Hydrate le formulaire une fois les critères chargés (listes → texte séparé par virgules)
  const c = data?.data.criteria
  if (open && c && form === null) {
    const arr = (v: unknown) => Array.isArray(v) ? (v as string[]).join(', ') : ''
    const num = (v: unknown) => (typeof v === 'number' ? String(v) : '')
    setForm({
      minExperienceYears:   num(c.minExperienceYears),
      requiredSkills:       arr(c.requiredSkills),
      allowedLocations:     arr(c.allowedLocations),
      requiredLanguages:    arr(c.requiredLanguages),
      maxExpectedSalary:    num(c.maxExpectedSalary),
      minDiploma:           typeof c.minDiploma === 'string' ? c.minDiploma : '',
      autoRejectBelowScore: num(c.autoRejectBelowScore),
      knockoutEnabled:      c.knockoutEnabled !== false,
    })
  }

  const save = useMutation({
    mutationFn: (f: ScreeningCriteriaForm) => {
      const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
      const intOrNull = (s: string) => {
        const n = parseInt(s, 10)
        return Number.isFinite(n) ? n : null
      }
      const criteria = {
        minExperienceYears:   intOrNull(f.minExperienceYears),
        requiredSkills:       list(f.requiredSkills),
        allowedLocations:     list(f.allowedLocations),
        requiredLanguages:    list(f.requiredLanguages),
        maxExpectedSalary:    intOrNull(f.maxExpectedSalary),
        minDiploma:           f.minDiploma || null,
        autoRejectBelowScore: intOrNull(f.autoRejectBelowScore),
        knockoutEnabled:      f.knockoutEnabled,
      }
      return api.put(`/recruitment/jobs/${jobId}/screening-criteria`, { criteria })
    },
    onSuccess: () => {
      setSaved(true)
      queryClient.invalidateQueries({ queryKey: ['screening-criteria', jobId] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const set = (patch: Partial<ScreeningCriteriaForm>) =>
    setForm(prev => prev ? { ...prev, ...patch } : prev)

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        {(open ? t('screening.hide') : t('screening.configure')) + t('screening.toggleSuffix')}
      </button>

      {open && (
        <div className="mt-3">
          {isLoading || !form ? (
            <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                <Trans i18nKey="screening.intro" t={t} components={{ strong: <strong /> }} />
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">{t('screening.minExperience')}</span>
                  <input
                    type="number" min={0} max={50} value={form.minExperienceYears}
                    onChange={e => set({ minExperienceYears: e.target.value })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">{t('screening.minDiploma')}</span>
                  <select
                    value={form.minDiploma}
                    onChange={e => set({ minDiploma: e.target.value })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  >
                    {DIPLOMA_OPTION_VALUES.map(o => <option key={o.value} value={o.value}>{t(`screening.diploma.${o.tKey}`)}</option>)}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium">{t('screening.requiredSkills')}</span>
                <input
                  value={form.requiredSkills}
                  onChange={e => set({ requiredSkills: e.target.value })}
                  placeholder={t('screening.requiredSkillsPlaceholder')}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">{t('screening.allowedLocations')}</span>
                  <input
                    value={form.allowedLocations}
                    onChange={e => set({ allowedLocations: e.target.value })}
                    placeholder={t('screening.allowedLocationsPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">{t('screening.requiredLanguages')}</span>
                  <input
                    value={form.requiredLanguages}
                    onChange={e => set({ requiredLanguages: e.target.value })}
                    placeholder={t('screening.requiredLanguagesPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">{t('screening.maxSalary')}</span>
                  <input
                    type="number" min={0} value={form.maxExpectedSalary}
                    onChange={e => set({ maxExpectedSalary: e.target.value })}
                    placeholder={t('screening.maxSalaryPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">{t('screening.autoRejectBelow')}</span>
                  <input
                    type="number" min={0} max={100} value={form.autoRejectBelowScore}
                    onChange={e => set({ autoRejectBelowScore: e.target.value })}
                    placeholder={t('screening.autoRejectBelowPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox" checked={form.knockoutEnabled}
                  onChange={e => set({ knockoutEnabled: e.target.checked })}
                  className="h-4 w-4 rounded border-border"
                />
                <span>{t('screening.knockoutEnabled')}</span>
              </label>

              <div className="flex items-center justify-end gap-2 pt-1">
                {saved && <span className="text-xs text-emerald-600">{t('screening.saved')}</span>}
                {save.isError && <span className="text-xs text-red-600">{t('screening.saveError')}</span>}
                <button
                  onClick={() => form && save.mutate(form)}
                  disabled={save.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  {t('screening.saveCriteria')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
