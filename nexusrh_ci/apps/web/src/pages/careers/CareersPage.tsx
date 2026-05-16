import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Brouillon',   color: 'bg-gray-100 text-gray-600' },
  in_progress: { label: 'En cours',  color: 'bg-yellow-100 text-yellow-700' },
  completed: { label: 'Finalisé',    color: 'bg-green-100 text-green-700' },
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

  const skillsByCategory = mySkills.reduce<Record<string, typeof mySkills>>((acc, s) => {
    const cat = s.category ?? 'Général'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(s)
    return acc
  }, {})

  return (
    <div className="p-6 space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-indigo-200/60 bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 p-6 shadow-sm">
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-purple-300/30 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-purple-500/30">
            <Award className="h-7 w-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Mon parcours · {user?.firstName} {user?.lastName}</h1>
            <p className="mt-1 text-sm text-slate-600">
              Vos entretiens, compétences, et opportunités d'évolution interne.
            </p>
          </div>
        </div>
      </div>

      {/* KPI Cards personnels */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard icon={Star} label="Entretiens" value={myEvals.length} hint={`Dernier : ${lastEval ? `${lastEval.year}` : '—'}`} color="amber" />
        <KpiCard icon={TrendingUp} label="Note globale" value={lastEval?.global_score ? `${lastEval.global_score}/5` : '—'} hint={lastEval?.status === 'completed' ? 'Finalisé' : 'En cours'} color="emerald" />
        <KpiCard icon={Target} label="Compétences" value={mySkills.length} hint={`${mastered.length} maîtrisées`} color="indigo" />
        <KpiCard icon={GraduationCap} label="À développer" value={gap.length} hint="Skills gap" color="rose" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Dernier entretien */}
        <div className="lg:col-span-2 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Star className="h-4 w-4 text-amber-500" />
            <h2 className="font-semibold">Dernier entretien</h2>
          </div>
          {lastEval ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="rounded bg-slate-100 px-2 py-0.5 uppercase font-medium">{lastEval.type}</span>
                <span className="font-mono text-slate-600">{lastEval.year}</span>
                <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_CONFIG[lastEval.status]?.color ?? 'bg-muted'}`}>
                  {STATUS_CONFIG[lastEval.status]?.label ?? lastEval.status}
                </span>
                {lastEval.evaluator_first_name && (
                  <span className="text-slate-500">par {lastEval.evaluator_first_name} {lastEval.evaluator_last_name}</span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <ScoreBlock label="Global"      value={lastEval.global_score} />
                <ScoreBlock label="Performance" value={lastEval.performance_score} />
                <ScoreBlock label="Compétences" value={lastEval.skills_score} />
              </div>
              {lastEval.manager_comments && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 mb-1">Commentaires manager</p>
                  {lastEval.manager_comments}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6 text-sm text-slate-500">
              <Star className="mx-auto mb-2 h-8 w-8 opacity-30" />
              Aucun entretien enregistré pour le moment.
            </div>
          )}
        </div>

        {/* Mobilité interne */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Briefcase className="h-4 w-4 text-indigo-500" />
            <h2 className="font-semibold">Mobilité interne</h2>
          </div>
          <a href="/mon-espace/offres-internes"
            className="block rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 hover:bg-indigo-50 transition-colors">
            <p className="text-sm font-medium text-indigo-900">Voir les offres internes</p>
            <p className="text-xs text-indigo-700/70 mt-0.5">Postes ouverts en interne pour votre profil</p>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-indigo-700">
              Découvrir <ChevronRight className="h-3 w-3" />
            </span>
          </a>
          <a href="/mon-espace/formation"
            className="mt-2 block rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 hover:bg-emerald-50 transition-colors">
            <p className="text-sm font-medium text-emerald-900">Catalogue formations</p>
            <p className="text-xs text-emerald-700/70 mt-0.5">Développez vos compétences</p>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
              Explorer <ChevronRight className="h-3 w-3" />
            </span>
          </a>
        </div>
      </div>

      {/* Compétences par catégorie + skill gap */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-indigo-500" />
            <h2 className="font-semibold">Mes compétences</h2>
          </div>
          {gap.length > 0 && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
              {gap.length} à développer
            </span>
          )}
        </div>
        {mySkills.length === 0 ? (
          <div className="text-center py-6 text-sm text-slate-500">
            <Target className="mx-auto mb-2 h-8 w-8 opacity-30" />
            Aucune compétence évaluée. Demandez à votre manager une cartographie de vos compétences.
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
                          <span>Niveau {s.level}/5</span>
                          {target > 0 && <span>Cible : {target}</span>}
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
            <Sparkles className="h-4 w-4 text-purple-500" />
            <h2 className="font-semibold">Historique de mes entretiens</h2>
          </div>
          <ul className="divide-y divide-border">
            {myEvals.slice(1).map(e => (
              <li key={e.id} className="py-2 flex items-center gap-3 text-sm">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] uppercase font-medium">{e.type}</span>
                <span className="font-mono text-slate-600">{e.year}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CONFIG[e.status]?.color ?? 'bg-muted'}`}>
                  {STATUS_CONFIG[e.status]?.label ?? e.status}
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
    star:        { label: '⭐ Stars', color: 'bg-yellow-50 border-yellow-200' },
    high_perf:   { label: '🚀 Hautes performances', color: 'bg-green-50 border-green-200' },
    expert:      { label: '🎯 Experts', color: 'bg-blue-50 border-blue-200' },
    high_pot:    { label: '💡 Haut potentiel', color: 'bg-purple-50 border-purple-200' },
    core:        { label: '✅ Contributeurs clés', color: 'bg-teal-50 border-teal-200' },
    solid:       { label: '📊 Solides', color: 'bg-cyan-50 border-cyan-200' },
    enigma:      { label: '❓ Énigmes', color: 'bg-orange-50 border-orange-200' },
    inconsistent: { label: '⚠️ Incohérents', color: 'bg-amber-50 border-amber-200' },
    risk:        { label: '🔴 À risque', color: 'bg-red-50 border-red-200' },
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Carrières & Compétences</h1>
          <p className="text-sm text-muted-foreground mt-1">{evaluations.length} entretien(s) · {year}</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
            {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => setShowNewEval(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> Nouvel entretien
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['evaluations', 'ninebox'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'evaluations' ? <span className="flex items-center gap-1.5"><Star className="h-3.5 w-3.5" />Entretiens</span>
              : <span className="flex items-center gap-1.5"><Grid3X3 className="h-3.5 w-3.5" />Matrice 9-box</span>}
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
                  <th className="p-4">Employé</th>
                  <th className="p-4">Type</th>
                  <th className="p-4">Évaluateur</th>
                  <th className="p-4">Score global</th>
                  <th className="p-4">Performance</th>
                  <th className="p-4">Compétences</th>
                  <th className="p-4">Statut</th>
                  <th className="p-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {evaluations.map(ev => (
                  <tr key={ev.id} className="hover:bg-muted/30">
                    <td className="p-4">
                      <p className="font-medium">{ev.first_name} {ev.last_name}</p>
                      {ev.job_title && <p className="text-xs text-muted-foreground">{ev.job_title}</p>}
                    </td>
                    <td className="p-4 capitalize">{ev.type}</td>
                    <td className="p-4 text-muted-foreground">
                      {ev.evaluator_first_name
                        ? `${ev.evaluator_first_name} ${ev.evaluator_last_name}`
                        : '—'}
                    </td>
                    <td className="p-4"><ScoreStars score={ev.global_score !== null ? parseFloat(ev.global_score) : null} /></td>
                    <td className="p-4"><ScoreStars score={ev.performance_score !== null ? parseFloat(ev.performance_score) : null} /></td>
                    <td className="p-4"><ScoreStars score={ev.skills_score !== null ? parseFloat(ev.skills_score) : null} /></td>
                    <td className="p-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CONFIG[ev.status]?.color ?? 'bg-muted'}`}>
                        {STATUS_CONFIG[ev.status]?.label ?? ev.status}
                      </span>
                    </td>
                    <td className="p-4">
                      {ev.status === 'draft' && (
                        <button
                          onClick={() => updateEval.mutate({ id: ev.id, data: { status: 'in_progress' } })}
                          className="text-xs text-primary hover:underline">
                          Démarrer
                        </button>
                      )}
                      {ev.status === 'in_progress' && (
                        <button
                          onClick={() => updateEval.mutate({ id: ev.id, data: { status: 'completed' } })}
                          className="text-xs text-green-600 hover:underline">
                          Finaliser
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {evaluations.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
                      <Target className="mx-auto mb-2 h-8 w-8 opacity-30" />
                      Aucun entretien pour {year}
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
            <span>Positionnement des {nineBox.length} employé(s) évalués en {year} (Performance × Potentiel)</span>
          </div>
          {nineBox.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center text-muted-foreground">
              <Users className="mx-auto mb-2 h-8 w-8 opacity-30" />
              Aucun entretien finalisé pour {year}
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
            <h3 className="font-semibold mb-4">Créer un entretien</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Employé *</label>
                <select value={newEval.employee_id} onChange={e => setNewEval(p => ({ ...p, employee_id: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                  <option value="">— Sélectionner —</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name} — {emp.job_title}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Type</label>
                  <select value={newEval.type} onChange={e => setNewEval(p => ({ ...p, type: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none">
                    <option value="annual">Annuel</option>
                    <option value="trial_end">Fin période essai</option>
                    <option value="mid_year">Mi-année</option>
                    <option value="exit">Départ</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Année</label>
                  <input type="number" value={newEval.year} onChange={e => setNewEval(p => ({ ...p, year: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none" />
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setShowNewEval(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">Annuler</button>
              <button onClick={() => createEval.mutate(newEval)}
                disabled={!newEval.employee_id || createEval.isPending}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {createEval.isPending ? 'Création...' : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
