/**
 * Parcours d'intégration — vue RH/manager.
 *
 * Onglet « Parcours »  : KPIs + liste des parcours (progression, retards) ;
 *                        clic → kanban d'étapes (drag & drop todo/en cours/fait),
 *                        planification (échéance, responsable), ajout d'étape.
 * Onglet « Modèles »   : modèles paramétrables par séniorité / type de poste,
 *                        éditeur d'étapes, et génération complète par IA.
 */
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Rocket, Plus, Loader2, ChevronLeft, Sparkles, Trash2, CalendarDays,
  FileText, PlayCircle, Link2, AlertTriangle, CheckCircle2, Users, LayoutGrid,
} from 'lucide-react'
import { api, formatDate } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

// ─── Types ───────────────────────────────────────────────────────────────────
interface Resource { type: 'document' | 'video' | 'link'; title: string; url: string }
interface JourneyRow {
  id: string; employee_id: string; first_name: string; last_name: string
  job_title: string | null; hire_date: string | null; department_name: string | null
  template_name: string | null; status: string; started_at: string
  total_steps: string; done_steps: string; late_steps: string
}
interface Step {
  id: string; title: string; description: string | null; phase: string
  owner_role: string; status: 'todo' | 'in_progress' | 'done'
  due_date: string | null; resources: Resource[]; notes: string | null
}
interface JourneyDetail extends Omit<JourneyRow, 'total_steps' | 'done_steps' | 'late_steps'> {
  steps: Step[]
  manager_first_name: string | null; manager_last_name: string | null
  job_level: string | null
}
interface Template {
  id: string; name: string; description: string | null; seniority: string
  job_keywords: string | null; is_active: boolean; is_default: boolean
  steps_count: string
}
interface TemplateStepForm {
  title: string; description: string; phase: string; ownerRole: string
  dueOffsetDays: number; resources: Resource[]
}

// Clés techniques (= valeurs API) ; les libellés sont traduits via t().
const PHASE_KEYS = ['before_start', 'day_one', 'first_week', 'first_month', 'probation_end'] as const
const OWNER_KEYS = ['hr', 'manager', 'employee', 'it', 'buddy'] as const
const SENIORITY_KEYS = ['any', 'junior', 'confirme', 'senior', 'cadre', 'direction'] as const
const KANBAN_COLS: Array<{ key: Step['status']; tone: string }> = [
  { key: 'todo',        tone: 'border-slate-300' },
  { key: 'in_progress', tone: 'border-blue-300' },
  { key: 'done',        tone: 'border-emerald-300' },
]
const phaseLabel = (t: TFunction, k: string) => PHASE_KEYS.includes(k as typeof PHASE_KEYS[number]) ? t(`phases.${k}`) : k
const ownerLabel = (t: TFunction, k: string) => OWNER_KEYS.includes(k as typeof OWNER_KEYS[number]) ? t(`owners.${k}`) : k
const seniorityLabel = (t: TFunction, k: string) => SENIORITY_KEYS.includes(k as typeof SENIORITY_KEYS[number]) ? t(`seniorities.${k}`) : k

function ResourceIcon({ type }: { type: Resource['type'] }) {
  if (type === 'video') return <PlayCircle className="h-3.5 w-3.5" />
  if (type === 'link')  return <Link2 className="h-3.5 w-3.5" />
  return <FileText className="h-3.5 w-3.5" />
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-primary'}`}
          style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground w-9 text-right">{pct}%</span>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function OnboardingPage() {
  const { t } = useTranslation('onboarding')
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canManageTemplates = ['admin', 'hr_manager'].includes(role)
  const canEditSteps = ['admin', 'hr_manager', 'hr_officer', 'manager'].includes(role)
  const [tab, setTab] = useState<'journeys' | 'templates'>('journeys')
  const [openJourneyId, setOpenJourneyId] = useState<string | null>(null)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Rocket className="h-6 w-6 text-primary" /> {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button onClick={() => { setTab('journeys'); setOpenJourneyId(null) }}
            className={`px-4 py-2 text-sm font-medium ${tab === 'journeys' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'}`}>
            <Users className="inline h-4 w-4 mr-1.5" />{t('tabs.journeys')}
          </button>
          <button onClick={() => setTab('templates')}
            className={`px-4 py-2 text-sm font-medium ${tab === 'templates' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'}`}>
            <LayoutGrid className="inline h-4 w-4 mr-1.5" />{t('tabs.templates')}
          </button>
        </div>
      </div>

      {tab === 'journeys' && (
        openJourneyId
          ? <JourneyBoard journeyId={openJourneyId} onBack={() => setOpenJourneyId(null)} canEdit={canEditSteps} role={role} />
          : <JourneysList onOpen={setOpenJourneyId} />
      )}
      {tab === 'templates' && <TemplatesTab canManage={canManageTemplates} />}
    </div>
  )
}

// ─── Liste des parcours ──────────────────────────────────────────────────────
function JourneysList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation('onboarding')
  const { data, isLoading } = useQuery<{ data: JourneyRow[] }>({
    queryKey: ['onboarding-journeys'],
    queryFn: () => api.get('/onboarding/journeys').then((r) => r.data),
  })
  const journeys = data?.data ?? []
  const inProgress = journeys.filter((j) => j.status === 'in_progress')
  const lateTotal = journeys.reduce((acc, j) => acc + parseInt(j.late_steps || '0', 10), 0)

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}</div>

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: t('list.kpi.inProgress'), value: inProgress.length, icon: Rocket, tone: 'text-primary' },
          { label: t('list.kpi.completed'), value: journeys.filter((j) => j.status === 'completed').length, icon: CheckCircle2, tone: 'text-emerald-600' },
          { label: t('list.kpi.late'), value: lateTotal, icon: AlertTriangle, tone: lateTotal > 0 ? 'text-red-600' : 'text-muted-foreground' },
        ].map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
            <Icon className={`h-8 w-8 ${tone}`} />
            <div>
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">{t('list.table.collaborator')}</th>
              <th className="px-4 py-3">{t('list.table.job')}</th>
              <th className="px-4 py-3">{t('list.table.hireDate')}</th>
              <th className="px-4 py-3 w-56">{t('list.table.progress')}</th>
              <th className="px-4 py-3">{t('list.table.late')}</th>
              <th className="px-4 py-3">{t('list.table.status')}</th>
            </tr>
          </thead>
          <tbody>
            {journeys.map((j) => {
              const late = parseInt(j.late_steps || '0', 10)
              return (
                <tr key={j.id} onClick={() => onOpen(j.id)}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer">
                  <td className="px-4 py-3 font-medium">{j.first_name} {j.last_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{j.job_title ?? t('list.noJob')} {j.department_name ? `· ${j.department_name}` : ''}</td>
                  <td className="px-4 py-3 text-muted-foreground">{j.hire_date ? formatDate(j.hire_date) : t('list.noHireDate')}</td>
                  <td className="px-4 py-3"><ProgressBar done={parseInt(j.done_steps, 10)} total={parseInt(j.total_steps, 10)} /></td>
                  <td className="px-4 py-3">
                    {late > 0
                      ? <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"><AlertTriangle className="h-3 w-3" />{late}</span>
                      : <span className="text-xs text-muted-foreground">{t('list.noLate')}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      j.status === 'completed' ? 'bg-emerald-100 text-emerald-700'
                        : j.status === 'cancelled' ? 'bg-slate-100 text-slate-600'
                        : 'bg-blue-100 text-blue-700'}`}>
                      {j.status === 'completed' ? t('journeyStatus.completed') : j.status === 'cancelled' ? t('journeyStatus.cancelled') : t('journeyStatus.in_progress')}
                    </span>
                  </td>
                </tr>
              )
            })}
            {journeys.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                {t('list.empty')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Kanban d'un parcours ────────────────────────────────────────────────────
function JourneyBoard({ journeyId, onBack, canEdit, role }: {
  journeyId: string; onBack: () => void; canEdit: boolean; role: string
}) {
  const { t } = useTranslation('onboarding')
  const qc = useQueryClient()
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [showAddStep, setShowAddStep] = useState(false)
  const [newStep, setNewStep] = useState({ title: '', phase: 'first_week', ownerRole: 'hr', dueDate: '' })
  const canAddStep = ['admin', 'hr_manager', 'hr_officer'].includes(role)

  const { data, isLoading } = useQuery<{ data: JourneyDetail }>({
    queryKey: ['onboarding-journey', journeyId],
    queryFn: () => api.get(`/onboarding/journeys/${journeyId}`).then((r) => r.data),
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['onboarding-journey', journeyId] })
    void qc.invalidateQueries({ queryKey: ['onboarding-journeys'] })
  }
  const moveStep = useMutation({
    mutationFn: ({ stepId, status }: { stepId: string; status: Step['status'] }) =>
      api.patch(`/onboarding/steps/${stepId}`, { status }),
    onSuccess: invalidate,
  })
  const addStep = useMutation({
    mutationFn: () => api.post(`/onboarding/journeys/${journeyId}/steps`, {
      title: newStep.title, phase: newStep.phase, ownerRole: newStep.ownerRole,
      ...(newStep.dueDate ? { dueDate: newStep.dueDate } : {}),
    }),
    onSuccess: () => { setShowAddStep(false); setNewStep({ title: '', phase: 'first_week', ownerRole: 'hr', dueDate: '' }); invalidate() },
  })
  const deleteStep = useMutation({
    mutationFn: (stepId: string) => api.delete(`/onboarding/steps/${stepId}`),
    onSuccess: invalidate,
  })

  const j = data?.data
  const today = new Date().toISOString().slice(0, 10)

  if (isLoading || !j) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}</div>
  const done = j.steps.filter((s) => s.status === 'done').length

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> {t('board.back')}
      </button>

      <div className="rounded-xl border border-border bg-card p-5 flex flex-wrap items-center gap-6">
        <div className="flex-1 min-w-52">
          <h2 className="text-lg font-bold">{j.first_name} {j.last_name}</h2>
          <p className="text-sm text-muted-foreground">
            {j.job_title ?? t('board.noJob')} {j.department_name ? `· ${j.department_name}` : ''}
            {j.hire_date ? t('board.hiredOn', { date: formatDate(j.hire_date) }) : ''}
          </p>
          {(j.manager_first_name || j.manager_last_name) && (
            <p className="text-xs text-muted-foreground mt-0.5">{t('board.manager', { firstName: j.manager_first_name ?? '', lastName: j.manager_last_name ?? '' })}</p>
          )}
        </div>
        <div className="w-64"><ProgressBar done={done} total={j.steps.length} /></div>
        {canAddStep && (
          <button onClick={() => setShowAddStep((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> {t('board.addStep')}
          </button>
        )}
      </div>

      {showAddStep && (
        <form onSubmit={(e) => { e.preventDefault(); if (newStep.title.trim()) addStep.mutate() }}
          className="rounded-xl border border-border bg-card p-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('board.stepForm.title')}</label>
            <input value={newStep.title} onChange={(e) => setNewStep({ ...newStep, title: e.target.value })}
              required className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('board.stepForm.phase')}</label>
            <select value={newStep.phase} onChange={(e) => setNewStep({ ...newStep, phase: e.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              {PHASE_KEYS.map((k) => <option key={k} value={k}>{t(`phases.${k}`)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('board.stepForm.owner')}</label>
            <select value={newStep.ownerRole} onChange={(e) => setNewStep({ ...newStep, ownerRole: e.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
              {OWNER_KEYS.map((k) => <option key={k} value={k}>{t(`owners.${k}`)}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <input type="date" value={newStep.dueDate} onChange={(e) => setNewStep({ ...newStep, dueDate: e.target.value })}
              className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            <button type="submit" disabled={addStep.isPending}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {addStep.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t('board.stepForm.add')}
            </button>
          </div>
        </form>
      )}

      {/* Kanban — drag & drop natif (même pattern que le pipeline recrutement) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {KANBAN_COLS.map((col) => {
          const steps = j.steps.filter((s) => s.status === col.key)
          return (
            <div key={col.key}
              className={`rounded-xl border-2 border-dashed ${col.tone} bg-muted/20 p-3 min-h-64`}
              onDragOver={(e) => canEdit && e.preventDefault()}
              onDrop={() => {
                if (canEdit && draggedId) {
                  moveStep.mutate({ stepId: draggedId, status: col.key })
                  setDraggedId(null)
                }
              }}>
              <p className="text-xs font-bold uppercase text-muted-foreground mb-3 px-1">
                {t(`kanban.${col.key}`)} <span className="font-normal">{t('kanban.columnCount', { count: steps.length })}</span>
              </p>
              <div className="space-y-2">
                {steps.map((s) => {
                  const late = s.status !== 'done' && s.due_date !== null && s.due_date < today
                  return (
                    <div key={s.id}
                      draggable={canEdit}
                      onDragStart={() => setDraggedId(s.id)}
                      className={`rounded-lg border bg-card p-3 shadow-sm ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''} ${late ? 'border-red-300' : 'border-border'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium leading-snug">{s.title}</p>
                        {canEdit && ['admin', 'hr_manager'].includes(role) && (
                          <button onClick={() => deleteStep.mutate(s.id)} title={t('board.stepCard.delete')}
                            className="text-muted-foreground hover:text-red-600 shrink-0">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {s.description && <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{s.description}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{phaseLabel(t, s.phase)}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">{ownerLabel(t, s.owner_role)}</span>
                        {s.due_date && (
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${late ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                            <CalendarDays className="h-3 w-3" />{formatDate(s.due_date)}{late ? t('board.stepCard.late') : ''}
                          </span>
                        )}
                      </div>
                      {(s.resources ?? []).length > 0 && (
                        <div className="mt-2 space-y-1">
                          {s.resources.map((r, i) => (
                            <div key={i} className="flex items-center gap-1.5 text-xs text-primary">
                              <ResourceIcon type={r.type} />
                              {r.url
                                ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="hover:underline truncate">{r.title}</a>
                                : <span className="text-muted-foreground truncate">{r.title}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {steps.length === 0 && <p className="px-1 text-xs text-muted-foreground/60 italic">{t('kanban.dropHint')}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Modèles ─────────────────────────────────────────────────────────────────
const EMPTY_STEP: TemplateStepForm = { title: '', description: '', phase: 'first_week', ownerRole: 'hr', dueOffsetDays: 0, resources: [] }

function TemplatesTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation('onboarding')
  const qc = useQueryClient()
  const [editing, setEditing] = useState<null | { id?: string }>(null)
  const [form, setForm] = useState({ name: '', description: '', seniority: 'any', jobKeywords: '', isDefault: false })
  const [steps, setSteps] = useState<TemplateStepForm[]>([])
  const [error, setError] = useState<string | null>(null)
  // Génération IA
  const [showAi, setShowAi] = useState(false)
  const [aiForm, setAiForm] = useState({ jobTitle: '', seniority: '', department: '' })

  const { data, isLoading } = useQuery<{ data: Template[] }>({
    queryKey: ['onboarding-templates'],
    queryFn: () => api.get('/onboarding/templates').then((r) => r.data),
  })

  const resetForm = () => { setEditing(null); setForm({ name: '', description: '', seniority: 'any', jobKeywords: '', isDefault: false }); setSteps([]); setError(null) }

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, steps }
      return editing?.id
        ? api.patch(`/onboarding/templates/${editing.id}`, body)
        : api.post('/onboarding/templates', body)
    },
    onSuccess: () => { resetForm(); void qc.invalidateQueries({ queryKey: ['onboarding-templates'] }) },
    onError: (err: unknown) =>
      setError((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('templates.editor.errorDefault')),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/onboarding/templates/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['onboarding-templates'] }),
  })
  const generate = useMutation({
    mutationFn: () => api.post('/onboarding/templates/generate', {
      jobTitle: aiForm.jobTitle,
      ...(aiForm.seniority ? { seniority: aiForm.seniority } : {}),
      ...(aiForm.department ? { department: aiForm.department } : {}),
    }).then((r) => r.data as { data: { name: string; description: string; steps: Array<TemplateStepForm & { dueOffsetDays: number }> } }),
    onSuccess: (res) => {
      // L'IA produit un BROUILLON : il est chargé dans l'éditeur pour relecture
      // et validation humaine avant enregistrement.
      setForm({ name: res.data.name, description: res.data.description ?? '', seniority: aiForm.seniority || 'any', jobKeywords: aiForm.jobTitle.toLowerCase(), isDefault: false })
      setSteps(res.data.steps.map((s) => ({ ...EMPTY_STEP, ...s })))
      setEditing({})
      setShowAi(false)
      setError(null)
    },
    onError: (err: unknown) =>
      setError((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? t('templates.ai.errorDefault')),
  })

  const openForEdit = async (id: string) => {
    const res = await api.get(`/onboarding/templates/${id}`)
    const t = res.data.data as Template & { steps: Array<{ title: string; description: string | null; phase: string; owner_role: string; due_offset_days: number; resources: Resource[] }> }
    setForm({ name: t.name, description: t.description ?? '', seniority: t.seniority, jobKeywords: t.job_keywords ?? '', isDefault: t.is_default })
    setSteps(t.steps.map((s) => ({
      title: s.title, description: s.description ?? '', phase: s.phase,
      ownerRole: s.owner_role, dueOffsetDays: s.due_offset_days, resources: s.resources ?? [],
    })))
    setEditing({ id })
  }

  const templates = data?.data ?? []
  const groupedPhases = useMemo(() => [...PHASE_KEYS], [])

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}</div>

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap gap-3">
          <button onClick={() => { resetForm(); setEditing({}) }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> {t('templates.newTemplate')}
          </button>
          <button onClick={() => { setShowAi((v) => !v); setError(null) }}
            className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-100">
            <Sparkles className="h-4 w-4" /> {t('templates.generateAi')}
          </button>
        </div>
      )}

      {showAi && (
        <form onSubmit={(e) => { e.preventDefault(); if (aiForm.jobTitle.trim().length >= 2) generate.mutate() }}
          className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 space-y-3">
          <p className="text-sm font-semibold text-violet-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> {t('templates.ai.heading')}
          </p>
          <p className="text-xs text-violet-800">
            {t('templates.ai.intro')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input placeholder={t('templates.ai.jobTitle')} value={aiForm.jobTitle}
              onChange={(e) => setAiForm({ ...aiForm, jobTitle: e.target.value })} required minLength={2}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            <select value={aiForm.seniority} onChange={(e) => setAiForm({ ...aiForm, seniority: e.target.value })}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm">
              <option value="">{t('templates.ai.seniorityPlaceholder')}</option>
              {SENIORITY_KEYS.filter((k) => k !== 'any').map((k) => <option key={k} value={k}>{t(`seniorities.${k}`)}</option>)}
            </select>
            <input placeholder={t('templates.ai.departmentPlaceholder')} value={aiForm.department}
              onChange={(e) => setAiForm({ ...aiForm, department: e.target.value })}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-xs font-medium text-red-700">{error}</p>}
          <button type="submit" disabled={generate.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
            {generate.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('templates.ai.generating')}</> : <><Sparkles className="h-4 w-4" /> {t('templates.ai.generate')}</>}
          </button>
        </form>
      )}

      {editing && (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate() }}
          className="rounded-xl border border-border bg-card p-5 space-y-4">
          <p className="font-semibold">{editing.id ? t('templates.editor.editTitle') : t('templates.editor.newTitle')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('templates.editor.name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('templates.editor.seniority')}</label>
              <select value={form.seniority} onChange={(e) => setForm({ ...form, seniority: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
                {SENIORITY_KEYS.map((k) => <option key={k} value={k}>{t(`seniorities.${k}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('templates.editor.jobKeywords')}</label>
              <input value={form.jobKeywords} onChange={(e) => setForm({ ...form, jobKeywords: e.target.value })}
                placeholder={t('templates.editor.jobKeywordsPlaceholder')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
                  className="h-4 w-4 rounded border-input accent-primary" />
                {t('templates.editor.isDefault')}
              </label>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-muted-foreground uppercase mb-1.5">{t('templates.editor.description')}</label>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>

          {/* Éditeur d'étapes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{t('templates.editor.stepsCount', { count: steps.length })}</p>
              <button type="button" onClick={() => setSteps([...steps, { ...EMPTY_STEP }])}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <Plus className="h-3.5 w-3.5" /> {t('templates.editor.addStep')}
              </button>
            </div>
            {groupedPhases.map((phase) => {
              const phaseSteps = steps.map((s, i) => [s, i] as const).filter(([s]) => s.phase === phase)
              if (phaseSteps.length === 0) return null
              return (
                <div key={phase} className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-xs font-bold uppercase text-muted-foreground">{phaseLabel(t, phase)}</p>
                  {phaseSteps.map(([s, i]) => (
                    <div key={i} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                      <input value={s.title} placeholder={t('templates.editor.stepTitlePlaceholder')}
                        onChange={(e) => setSteps(steps.map((x, xi) => xi === i ? { ...x, title: e.target.value } : x))}
                        className="sm:col-span-5 rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm" />
                      <select value={s.phase}
                        onChange={(e) => setSteps(steps.map((x, xi) => xi === i ? { ...x, phase: e.target.value } : x))}
                        className="sm:col-span-3 rounded-lg border border-input bg-background px-2 py-1.5 text-xs">
                        {PHASE_KEYS.map((k) => <option key={k} value={k}>{t(`phases.${k}`)}</option>)}
                      </select>
                      <select value={s.ownerRole}
                        onChange={(e) => setSteps(steps.map((x, xi) => xi === i ? { ...x, ownerRole: e.target.value } : x))}
                        className="sm:col-span-2 rounded-lg border border-input bg-background px-2 py-1.5 text-xs">
                        {OWNER_KEYS.map((k) => <option key={k} value={k}>{t(`owners.${k}`)}</option>)}
                      </select>
                      <div className="sm:col-span-2 flex items-center gap-1">
                        <input type="number" value={s.dueOffsetDays} title={t('templates.editor.dueOffsetTitle')}
                          onChange={(e) => setSteps(steps.map((x, xi) => xi === i ? { ...x, dueOffsetDays: parseInt(e.target.value || '0', 10) } : x))}
                          className="w-16 rounded-lg border border-input bg-background px-2 py-1.5 text-xs" />
                        <span className="text-[10px] text-muted-foreground">{t('templates.editor.dueOffsetUnit')}</span>
                        <button type="button" onClick={() => setSteps(steps.filter((_, xi) => xi !== i))}
                          className="ml-auto text-muted-foreground hover:text-red-600">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
            {steps.length === 0 && <p className="text-xs text-muted-foreground italic">{t('templates.editor.noSteps')}</p>}
          </div>

          {error && <p className="text-xs font-medium text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending || !form.name.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t('templates.editor.save')}
            </button>
            <button type="button" onClick={resetForm}
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t('templates.editor.cancel')}</button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">{t('templates.table.template')}</th>
              <th className="px-4 py-3">{t('templates.table.seniority')}</th>
              <th className="px-4 py-3">{t('templates.table.jobKeywords')}</th>
              <th className="px-4 py-3">{t('templates.table.steps')}</th>
              <th className="px-4 py-3">{t('templates.table.status')}</th>
              {canManage && <th className="px-4 py-3"></th>}
            </tr>
          </thead>
          <tbody>
            {templates.map((tpl) => (
              <tr key={tpl.id} className="border-t border-border hover:bg-muted/30">
                <td className="px-4 py-3">
                  <p className="font-medium">{tpl.name} {tpl.is_default && <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">{t('templates.table.default')}</span>}</p>
                  {tpl.description && <p className="text-xs text-muted-foreground line-clamp-1">{tpl.description}</p>}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{seniorityLabel(t, tpl.seniority)}</td>
                <td className="px-4 py-3 text-muted-foreground text-xs">{tpl.job_keywords ?? t('templates.table.noKeywords')}</td>
                <td className="px-4 py-3">{tpl.steps_count}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tpl.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                    {tpl.is_active ? t('templates.table.active') : t('templates.table.inactive')}
                  </span>
                </td>
                {canManage && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => void openForEdit(tpl.id)} className="text-primary hover:underline text-sm mr-3">{t('templates.table.edit')}</button>
                    <button onClick={() => remove.mutate(tpl.id)} className="text-muted-foreground hover:text-red-600" title={t('templates.table.delete')}>
                      <Trash2 className="h-4 w-4 inline" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {templates.length === 0 && (
              <tr><td colSpan={canManage ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">{t('templates.table.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
