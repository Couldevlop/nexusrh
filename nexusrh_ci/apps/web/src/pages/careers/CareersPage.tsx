import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import {
  Star, Target, Users, Plus, Grid3X3, TrendingUp, Award, BookOpen,
  Briefcase, Sparkles, ChevronRight, GraduationCap, Loader2,
} from 'lucide-react'

interface Evaluation {
  id: string; employee_id: string; first_name: string; last_name: string
  job_title: string | null; type: string; year: number
  global_score: string | null; performance_score: string | null
  skills_score: string | null; evaluator_first_name: string | null
  evaluator_last_name: string | null; status: string; created_at: string
}

interface NineBoxEntry {
  id: string; first_name: string; last_name: string; job_title: string | null
  department: string | null; performance: string | null; potential: string | null
  retention_score: string | null
}

// Couleurs uniquement ; libellés résolus via i18n (evaluationStatus.<value>).
const STATUS_COLOR: Record<string, string> = {
  draft:       'bg-gray-100 text-gray-600',
  in_progress: 'bg-yellow-100 text-yellow-700',
  completed:   'bg-green-100 text-green-700',
}

function ScoreStars({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground text-xs">—</span>
  return (
    <div className="flex gap-0.5">
      {[1,2,3,4,5].map(i => (
        <Star key={i} className={`h-3.5 w-3.5 ${i <= Math.round(score) ? 'fill-yellow-400 text-yellow-400' : 'text-muted'}`} />
      ))}
      <span className="ml-1 text-xs text-muted-foreground">{score}</span>
    </div>
  )
}

function NineBoxCell({ label, color, entries }: { label: string; color: string; entries: NineBoxEntry[] }) {
  return (
    <div className={`rounded-lg border p-3 min-h-[100px] ${color}`}>
      <p className="text-xs font-medium mb-2 opacity-70">{label}</p>
      <div className="space-y-1">
        {entries.map(e => (
          <div key={e.id} className="rounded bg-white/50 px-2 py-1">
            <p className="text-xs font-medium">{e.first_name} {e.last_name}</p>
            {e.department && <p className="text-xs opacity-60">{e.department}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Dispatcher par rôle ─────────────────────────────────────────────────────
// OWASP A01 : chaque utilisateur voit UNIQUEMENT ses données.
// employee  → MyCareerView (ses entretiens, ses compétences, recommandations)
// manager   → vue admin filtrée API-side (RBAC routes /evaluations restreint)
// hr/admin  → vue admin complète (tous employés du tenant)
// readonly  → vue admin lecture seule
export default function CareersPage() {
  const role = useAuthStore((s) => s.user?.role)
  if (role === 'employee') return <MyCareerView />
  return <HRView />
}

// ─── Vue employé : Mon parcours ──────────────────────────────────────────────
function MyCareerView() {
  const user = useAuthStore((s) => s.user)
  const { t } = useTranslation('careers')
  const { data: evals } = useQuery<{ data: Array<{
    id: string; type: string; year: number; status: string
    global_score: string | null; performance_score: string | null; skills_score: string | null
    notes: string | null; manager_comments: string | null
    created_at: string; completed_at: string | null
    evaluator_first_name: string | null; evaluator_last_name: string | null
  }> }>({
    queryKey: ['my-evaluations'],
    queryFn: () => api.get('/careers/my-evaluations').then(r => r.data),
  })
  const { data: skills } = useQuery<{ data: Array<{
    level: number; target_level: number | null
    skill_name: string; category: string | null
  }> }>({
    queryKey: ['my-skills'],
    queryFn: () => api.get('/careers/my-skills').then(r => r.data),
  })

  const myEvals = evals?.data ?? []
  const mySkills = skills?.data ?? []
  const lastEval = myEvals[0]
  const gap = mySkills.filter(s => s.target_level !== null && s.level < (s.target_level ?? 0))
  const mastered = mySkills.filter(s => s.target_level !== null && s.level >= (s.target_level ?? 0))

  const defaultCategory = t('my.defaultCategory')
  const skillsByCategory = mySkills.reduce<Record<string, typeof mySkills>>((acc, s) => {
    const cat = s.category ?? defaultCategory
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(s)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-primary/10 to-secondary/10 p-6 shadow-sm">
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-secondary shadow-lg shadow-primary/30">
            <Award className="h-7 w-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t('my.heroTitle', { name: `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() })}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {t('my.heroSubtitle')}
            </p>
          </div>
        </div>
      </div>

      {/* KPI Cards personnels */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard icon={Star} label={t('my.kpis.evaluations')} value={myEvals.length} hint={t('my.kpis.lastPrefix', { value: lastEval ? `${lastEval.year}` : '—' })} color="amber" />
        <KpiCard icon={TrendingUp} label={t('my.kpis.globalScore')} value={lastEval?.global_score ? `${lastEval.global_score}/5` : '—'} hint={lastEval?.status === 'completed' ? t('evaluationStatus.completed') : t('evaluationStatus.in_progress')} color="emerald" />
        <KpiCard icon={Target} label={t('my.kpis.skills')} value={mySkills.length} hint={t('my.kpis.skillsMastered', { count: mastered.length })} color="indigo" />
        <KpiCard icon={GraduationCap} label={t('my.kpis.toDevelop')} value={gap.length} hint={t('my.kpis.skillsGap')} color="rose" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Dernier entretien */}
        <div className="lg:col-span-2 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Star className="h-4 w-4 text-amber-500" />
            <h2 className="font-semibold">{t('my.lastEvaluation')}</h2>
          </div>
          {lastEval ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="rounded bg-slate-100 px-2 py-0.5 uppercase font-medium">{t(`evaluationType.${lastEval.type}`, { defaultValue: lastEval.type })}</span>
                <span className="font-mono text-slate-600">{lastEval.year}</span>
                <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_COLOR[lastEval.status] ?? 'bg-muted'}`}>
                  {t(`evaluationStatus.${lastEval.status}`, { defaultValue: lastEval.status })}
                </span>
                {lastEval.evaluator_first_name && (
                  <span className="text-slate-500">{t('my.byEvaluator', { name: `${lastEval.evaluator_first_name} ${lastEval.evaluator_last_name}` })}</span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <ScoreBlock label={t('my.scoreBlocks.global')}      value={lastEval.global_score} />
                <ScoreBlock label={t('my.scoreBlocks.performance')} value={lastEval.performance_score} />
                <ScoreBlock label={t('my.scoreBlocks.skills')}      value={lastEval.skills_score} />
              </div>
              {lastEval.manager_comments && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 mb-1">{t('my.managerComments')}</p>
                  {lastEval.manager_comments}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6 text-sm text-slate-500">
              <Star className="mx-auto mb-2 h-8 w-8 opacity-30" />
              {t('my.noEvaluation')}
            </div>
          )}
        </div>

        {/* Mobilité interne */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Briefcase className="h-4 w-4 text-indigo-500" />
            <h2 className="font-semibold">{t('my.internalMobility')}</h2>
          </div>
          <a href="/mon-espace/offres-internes"
            className="block rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 hover:bg-indigo-50 transition-colors">
            <p className="text-sm font-medium text-indigo-900">{t('my.internalOffers.title')}</p>
            <p className="text-xs text-indigo-700/70 mt-0.5">{t('my.internalOffers.subtitle')}</p>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-indigo-700">
              {t('my.internalOffers.cta')} <ChevronRight className="h-3 w-3" />
            </span>
          </a>
          <a href="/mon-espace/formation"
            className="mt-2 block rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 hover:bg-emerald-50 transition-colors">
            <p className="text-sm font-medium text-emerald-900">{t('my.trainingCatalog.title')}</p>
            <p className="text-xs text-emerald-700/70 mt-0.5">{t('my.trainingCatalog.subtitle')}</p>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
              {t('my.trainingCatalog.cta')} <ChevronRight className="h-3 w-3" />
            </span>
          </a>
        </div>
      </div>

      {/* Compétences par catégorie + skill gap */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-indigo-500" />
            <h2 className="font-semibold">{t('my.mySkills')}</h2>
          </div>
          {gap.length > 0 && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
              {t('my.skillsToDevelop', { count: gap.length })}
            </span>
          )}
        </div>
        {mySkills.length === 0 ? (
          <div className="text-center py-6 text-sm text-slate-500">
            <Target className="mx-auto mb-2 h-8 w-8 opacity-30" />
            {t('my.noSkills')}
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(skillsByCategory).map(([cat, list]) => (
              <div key={cat}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">{cat}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {list.map((s, i) => {
                    const target = s.target_level ?? 0
                    const hasGap = target > 0 && s.level < target
                    return (
                      <div key={i} className={`rounded-lg border p-3 ${hasGap ? 'border-rose-200 bg-rose-50/30' : 'border-emerald-200 bg-emerald-50/30'}`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-sm font-medium text-slate-800">{s.skill_name}</p>
                          {hasGap && <span className="text-[10px] font-semibold text-rose-700">−{target - s.level}</span>}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {[1,2,3,4,5].map(lvl => (
                            <div key={lvl}
                              className={`h-1.5 flex-1 rounded-full ${lvl <= s.level ? (hasGap ? 'bg-rose-400' : 'bg-emerald-500') : 'bg-slate-200'}`} />
                          ))}
                        </div>
                        <div className="mt-1 flex justify-between text-[10px] text-slate-500">
                          <span>{t('my.skillLevel', { level: s.level })}</span>
                          {target > 0 && <span>{t('my.skillTarget', { target })}</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Historique entretiens */}
      {myEvals.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="font-semibold">{t('my.evaluationsHistory')}</h2>
          </div>
          <ul className="divide-y divide-border">
            {myEvals.slice(1).map(e => (
              <li key={e.id} className="py-2 flex items-center gap-3 text-sm">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] uppercase font-medium">{t(`evaluationType.${e.type}`, { defaultValue: e.type })}</span>
                <span className="font-mono text-slate-600">{e.year}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLOR[e.status] ?? 'bg-muted'}`}>
                  {t(`evaluationStatus.${e.status}`, { defaultValue: e.status })}
                </span>
                <span className="ml-auto font-semibold text-slate-700">
                  {e.global_score ? `${e.global_score}/5` : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function KpiCard({ icon: Icon, label, value, hint, color }: {
  icon: typeof Star; label: string; value: number | string; hint: string
  color: 'amber' | 'emerald' | 'indigo' | 'rose'
}) {
  const styles = {
    amber:   { bg: 'bg-amber-100',   txt: 'text-amber-700' },
    emerald: { bg: 'bg-emerald-100', txt: 'text-emerald-700' },
    indigo:  { bg: 'bg-indigo-100',  txt: 'text-indigo-700' },
    rose:    { bg: 'bg-rose-100',    txt: 'text-rose-700' },
  }[color]
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${styles.bg} ${styles.txt}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>
    </div>
  )
}

// Card collaborateur (vue manager) — avatar coloré + dernier entretien
function TeamMemberCard({ member }: { member: {
  employee_id: string; first_name: string; last_name: string; job_title: string | null
  lastEval: Evaluation | null; evalCount: number
} }) {
  const { t } = useTranslation('careers')
  const gradients = [
    'from-orange-400 to-pink-500', 'from-emerald-400 to-teal-500',
    'from-blue-400 to-indigo-500', 'from-purple-400 to-fuchsia-500',
    'from-amber-400 to-orange-500', 'from-rose-400 to-red-500',
    'from-cyan-400 to-blue-500', 'from-lime-400 to-emerald-500',
  ]
  const seed = (member.first_name + member.last_name).split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const gradient = gradients[seed % gradients.length]
  const initials = ((member.first_name?.[0] ?? '') + (member.last_name?.[0] ?? '')).toUpperCase()
  const score = member.lastEval?.global_score ? parseFloat(member.lastEval.global_score) : null
  const scoreColor = score === null ? 'text-slate-400'
    : score >= 4 ? 'text-emerald-600'
    : score >= 3 ? 'text-amber-600'
    : 'text-rose-600'
  const statusColor = member.lastEval ? STATUS_COLOR[member.lastEval.status] : null

  return (
    <div className="group rounded-xl border border-border bg-card p-3 hover:border-indigo-300 hover:shadow-md transition-all">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${gradient} text-white text-sm font-bold shadow-sm ring-2 ring-white`}>
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900 truncate">
            {member.first_name} {member.last_name}
          </p>
          {member.job_title && (
            <p className="text-xs text-muted-foreground truncate">{member.job_title}</p>
          )}
        </div>
        {score !== null && (
          <div className="flex-shrink-0 text-right">
            <p className={`text-lg font-bold ${scoreColor}`}>{score}<span className="text-xs text-slate-400">/5</span></p>
          </div>
        )}
      </div>
      {member.lastEval && statusColor && (
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className={`rounded-full px-2 py-0.5 font-medium ${statusColor}`}>
            {t(`evaluationStatus.${member.lastEval.status}`, { defaultValue: member.lastEval.status })}
          </span>
          <span className="text-muted-foreground">
            {member.lastEval.year} · {t('team.evaluationCount', { count: member.evalCount })}
          </span>
        </div>
      )}
      {!member.lastEval && (
        <p className="mt-2 text-[11px] text-slate-400 italic">{t('team.noEvaluation')}</p>
      )}
    </div>
  )
}

function ScoreBlock({ label, value }: { label: string; value: string | null }) {
  const num = value ? parseFloat(value) : null
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-center">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      {num !== null ? (
        <>
          <p className="text-xl font-bold text-slate-900">{num}<span className="text-xs text-slate-400">/5</span></p>
          <ScoreStars score={num} />
        </>
      ) : <p className="text-sm text-slate-400 mt-2">—</p>}
    </div>
  )
}

// ─── Vue admin/RH/manager : entretiens + 9-box (existant inchangé) ───────────
function HRView() {
  const queryClient = useQueryClient()
  const { t } = useTranslation('careers')
  const { t: tCommon } = useTranslation('common')
  // Détecte le rôle pour adapter hero/onglets. L'API filtre déjà les data
  // (manager → ses subordonnés ; admin/RH → tout le tenant).
  const role = useAuthStore((s) => s.user?.role)
  const isManager = role === 'manager'
  const canSeeNineBox = role === 'admin' || role === 'hr_manager'
  const [tab, setTab] = useState<'evaluations' | 'ninebox'>('evaluations')
  const [year, setYear] = useState(new Date().getFullYear())
  const [showNewEval, setShowNewEval] = useState(false)
  const [newEval, setNewEval] = useState({ employee_id: '', type: 'annual', year: String(new Date().getFullYear()) })

  const { data: evalsData, isLoading } = useQuery<{ data: Evaluation[] }>({
    queryKey: ['evaluations', year],
    queryFn: () => api.get(`/careers/evaluations?year=${year}`).then(r => r.data),
  })

  const { data: nineBoxData } = useQuery<{ data: NineBoxEntry[] }>({
    queryKey: ['nine-box', year],
    queryFn: () => api.get(`/careers/nine-box?year=${year}`).then(r => r.data),
    enabled: tab === 'ninebox',
  })

  const { data: empsData } = useQuery<{ data: Array<{ id: string; first_name: string; last_name: string; job_title: string }> }>({
    queryKey: ['employees-list'],
    queryFn: () => api.get('/employees').then(r => r.data),
    enabled: showNewEval,
  })

  const createEval = useMutation({
    mutationFn: (data: typeof newEval) => api.post('/careers/evaluations', data),
    onSuccess: () => {
      setShowNewEval(false)
      queryClient.invalidateQueries({ queryKey: ['evaluations'] })
    },
  })

  const updateEval = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.patch(`/careers/evaluations/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['evaluations'] }),
  })

  const evaluations = evalsData?.data ?? []
  const nineBox = nineBoxData?.data ?? []
  const employees = empsData?.data ?? []

  // Calcul 9-box (performance × potentiel)
  function getBox(perf: number | null, potential: number | null): string {
    const p = perf ?? 0; const pot = potential ?? 0
    if (p >= 4 && pot >= 4) return 'star'
    if (p >= 4 && pot >= 2.5) return 'high_perf'
    if (p >= 4) return 'expert'
    if (p >= 2.5 && pot >= 4) return 'high_pot'
    if (p >= 2.5 && pot >= 2.5) return 'core'
    if (p >= 2.5) return 'solid'
    if (pot >= 4) return 'enigma'
    if (pot >= 2.5) return 'inconsistent'
    return 'risk'
  }

  const BOX_CONFIG = {
    star:        { label: t('nineBox.boxes.star'), color: 'bg-yellow-50 border-yellow-200' },
    high_perf:   { label: t('nineBox.boxes.high_perf'), color: 'bg-green-50 border-green-200' },
    expert:      { label: t('nineBox.boxes.expert'), color: 'bg-blue-50 border-blue-200' },
    high_pot:    { label: t('nineBox.boxes.high_pot'), color: 'bg-purple-50 border-purple-200' },
    core:        { label: t('nineBox.boxes.core'), color: 'bg-teal-50 border-teal-200' },
    solid:       { label: t('nineBox.boxes.solid'), color: 'bg-cyan-50 border-cyan-200' },
    enigma:      { label: t('nineBox.boxes.enigma'), color: 'bg-orange-50 border-orange-200' },
    inconsistent: { label: t('nineBox.boxes.inconsistent'), color: 'bg-amber-50 border-amber-200' },
    risk:        { label: t('nineBox.boxes.risk'), color: 'bg-red-50 border-red-200' },
  }

  // KPIs équipe pour manager (computed sur les évaluations filtrées API)
  const completedCount = evaluations.filter(e => e.status === 'completed').length
  const draftCount = evaluations.filter(e => e.status === 'draft' || e.status === 'in_progress').length
  const teamSize = new Set(evaluations.map(e => e.employee_id)).size
  // Pour l'affichage du tab 9-box : caché si rôle non autorisé (évite 403 visible)
  const availableTabs = canSeeNineBox ? (['evaluations', 'ninebox'] as const) : (['evaluations'] as const)

  // Stats supplémentaires admin/RH
  const completionRate = evaluations.length > 0
    ? Math.round((completedCount / evaluations.length) * 100) : 0
  const avgScore = (() => {
    const scores = evaluations.map(e => parseFloat(e.global_score ?? '0')).filter(s => s > 0)
    return scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—'
  })()

  // Synthèse par collaborateur (pour la card "Mon équipe" du manager)
  const teamMembers = (() => {
    const map = new Map<string, {
      employee_id: string; first_name: string; last_name: string; job_title: string | null
      lastEval: Evaluation | null; evalCount: number
    }>()
    for (const e of evaluations) {
      const existing = map.get(e.employee_id)
      if (!existing) {
        map.set(e.employee_id, {
          employee_id: e.employee_id, first_name: e.first_name, last_name: e.last_name,
          job_title: e.job_title, lastEval: e, evalCount: 1,
        })
      } else {
        existing.evalCount++
        if (!existing.lastEval || new Date(e.created_at) > new Date(existing.lastEval.created_at)) {
          existing.lastEval = e
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
  })()

  return (
    <div className="p-6 space-y-5">
      {/* Hero gradient adaptatif par rôle */}
      <div className={`relative overflow-hidden rounded-2xl border p-6 shadow-sm ${
        isManager
          ? 'border-indigo-200/60 bg-gradient-to-br from-indigo-50 via-blue-50 to-cyan-50'
          : 'border-primary/20 bg-gradient-to-br from-primary/5 via-primary/10 to-secondary/10'
      }`}>
        <div className={`absolute -right-12 -top-12 h-48 w-48 rounded-full blur-3xl ${
          isManager ? 'bg-blue-300/30' : 'bg-primary/20'
        }`} />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4">
            <div className={`flex h-14 w-14 items-center justify-center rounded-2xl shadow-lg ${
              isManager
                ? 'bg-gradient-to-br from-indigo-500 to-blue-600 shadow-blue-500/30'
                : 'bg-gradient-to-br from-primary to-secondary shadow-primary/30'
            }`}>
              {isManager ? <Users className="h-7 w-7 text-white" /> : <Award className="h-7 w-7 text-white" />}
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                {isManager ? t('hr.heroTitleManager') : t('hr.heroTitleAdmin')}
              </h1>
              <p className="mt-1 text-sm text-slate-600 max-w-xl">
                {isManager ? t('hr.heroSubtitleManager') : t('hr.heroSubtitleAdmin')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <select value={year} onChange={e => setYear(parseInt(e.target.value))}
              className="rounded-lg border border-white bg-white/90 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm outline-none">
              {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => setShowNewEval(true)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all ${
                isManager
                  ? 'bg-gradient-to-r from-indigo-600 to-blue-600'
                  : 'bg-gradient-to-r from-primary to-secondary'
              }`}>
              <Plus className="h-4 w-4" /> {t('hr.newEvaluation')}
            </button>
          </div>
        </div>
      </div>

      {/* KPI cards adaptés au rôle */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {isManager ? (
          <>
            <KpiCard icon={Users}      label={t('kpiCards.directTeam')}    value={teamSize}        hint={t('kpiCards.members')} color="indigo" />
            <KpiCard icon={Star}       label={t('kpiCards.evaluationsLed')} value={completedCount} hint={`${year}`}      color="emerald" />
            <KpiCard icon={Target}     label={t('kpiCards.toFinalize')}    value={draftCount}      hint={t('kpiCards.draftsOrInProgress')} color="amber" />
            <KpiCard icon={TrendingUp} label={t('kpiCards.averageScore')}  value={`${avgScore}/5`} hint={t('kpiCards.teamPerformance')} color="rose" />
          </>
        ) : (
          <>
            <KpiCard icon={Star}       label={t('kpiCards.totalEvaluations')} value={evaluations.length} hint={`${year}`}     color="amber" />
            <KpiCard icon={TrendingUp} label={t('kpiCards.averageScore')}     value={`${avgScore}/5`}    hint={t('kpiCards.tenantGlobal')} color="emerald" />
            <KpiCard icon={Target}     label={t('kpiCards.completionRate')}   value={`${completionRate}%`} hint={t('kpiCards.finalizedCount', { count: completedCount })} color="indigo" />
            <KpiCard icon={Sparkles}   label={t('kpiCards.drafts')}           value={draftCount}        hint={t('kpiCards.toProcess')}      color="rose" />
          </>
        )}
      </div>

      {/* Section "Mon équipe" : cards membres avec dernier entretien */}
      {isManager && teamMembers.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-500" />
              <h2 className="font-semibold">{t('team.membersTitle')}</h2>
            </div>
            <span className="text-xs text-muted-foreground">{t('team.membersCount', { count: teamMembers.length })}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {teamMembers.map(m => (
              <TeamMemberCard key={m.employee_id} member={m} />
            ))}
          </div>
        </div>
      )}

      {/* Tabs (9-box masqué pour les rôles non admin/hr_manager) */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {availableTabs.map(tabKey => (
          <button key={tabKey} onClick={() => setTab(tabKey)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === tabKey ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {tabKey === 'evaluations' ? <span className="flex items-center gap-1.5"><Star className="h-3.5 w-3.5" />{t('tabs.evaluations')}</span>
              : <span className="flex items-center gap-1.5"><Grid3X3 className="h-3.5 w-3.5" />{t('tabs.nineBox')}</span>}
          </button>
        ))}
      </div>

      {/* Entretiens */}
      {tab === 'evaluations' && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                  <th className="p-4">{t('table.employee')}</th>
                  <th className="p-4">{t('table.type')}</th>
                  <th className="p-4">{t('table.evaluator')}</th>
                  <th className="p-4">{t('table.globalScore')}</th>
                  <th className="p-4">{t('table.performance')}</th>
                  <th className="p-4">{t('table.skills')}</th>
                  <th className="p-4">{t('table.status')}</th>
                  <th className="p-4">{t('table.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {evaluations.map(ev => (
                  <tr key={ev.id} className="hover:bg-muted/30">
                    <td className="p-4">
                      <p className="font-medium">{ev.first_name} {ev.last_name}</p>
                      {ev.job_title && <p className="text-xs text-muted-foreground">{ev.job_title}</p>}
                    </td>
                    <td className="p-4 capitalize">{t(`evaluationType.${ev.type}`, { defaultValue: ev.type })}</td>
                    <td className="p-4 text-muted-foreground">
                      {ev.evaluator_first_name
                        ? `${ev.evaluator_first_name} ${ev.evaluator_last_name}`
                        : '—'}
                    </td>
                    <td className="p-4"><ScoreStars score={ev.global_score !== null ? parseFloat(ev.global_score) : null} /></td>
                    <td className="p-4"><ScoreStars score={ev.performance_score !== null ? parseFloat(ev.performance_score) : null} /></td>
                    <td className="p-4"><ScoreStars score={ev.skills_score !== null ? parseFloat(ev.skills_score) : null} /></td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[ev.status] ?? 'bg-muted'}`}>
                        {t(`evaluationStatus.${ev.status}`, { defaultValue: ev.status })}
                      </span>
                    </td>
                    <td className="p-4">
                      {ev.status === 'draft' && (
                        <button
                          onClick={() => updateEval.mutate({ id: ev.id, data: { status: 'in_progress' } })}
                          className="text-xs text-primary hover:underline">
                          {t('table.start')}
                        </button>
                      )}
                      {ev.status === 'in_progress' && (
                        <button
                          onClick={() => updateEval.mutate({ id: ev.id, data: { status: 'completed' } })}
                          className="text-xs text-green-600 hover:underline">
                          {t('table.finalize')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {evaluations.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
                      <Target className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      {t('table.noEvaluations', { year })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Matrice 9-box */}
      {tab === 'ninebox' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Grid3X3 className="h-4 w-4" />
            <span>{t('nineBox.intro', { count: nineBox.length, year })}</span>
          </div>
          {nineBox.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center text-muted-foreground">
              <Users className="mx-auto mb-2 h-8 w-8 opacity-30" />
              {t('nineBox.empty', { year })}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {Object.entries(BOX_CONFIG).map(([key, cfg]) => {
                const entries = nineBox.filter(e =>
                  getBox(
                    e.performance !== null ? parseFloat(e.performance) : null,
                    e.potential !== null ? parseFloat(e.potential) : null
                  ) === key
                )
                return <NineBoxCell key={key} label={cfg.label} color={cfg.color} entries={entries} />
              })}
            </div>
          )}
        </div>
      )}

      {/* Modal nouvel entretien */}
      {showNewEval && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNewEval(false)}>
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">{t('newEvalModal.title')}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">{t('newEvalModal.employee')}</label>
                <select value={newEval.employee_id} onChange={e => setNewEval(p => ({ ...p, employee_id: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                  <option value="">{t('newEvalModal.selectEmployee')}</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name} — {emp.job_title}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('newEvalModal.type')}</label>
                  <select value={newEval.type} onChange={e => setNewEval(p => ({ ...p, type: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    <option value="annual">{t('evaluationType.annual')}</option>
                    <option value="trial_end">{t('evaluationType.trial_end')}</option>
                    <option value="mid_year">{t('evaluationType.mid_year')}</option>
                    <option value="exit">{t('evaluationType.exit')}</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">{t('newEvalModal.year')}</label>
                  <input type="number" value={newEval.year} onChange={e => setNewEval(p => ({ ...p, year: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNewEval(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{tCommon('actions.cancel')}</button>
              <button onClick={() => createEval.mutate(newEval)}
                disabled={!newEval.employee_id || createEval.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {createEval.isPending ? t('newEvalModal.submitting') : t('newEvalModal.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
