import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { Star, Target, Users, Plus, Grid3X3 } from 'lucide-react'

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

export default function CareersPage() {
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
