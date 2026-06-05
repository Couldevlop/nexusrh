/**
 * Mon intégration — vue self-service du collaborateur.
 *
 * Le nouveau collaborateur voit son parcours d'intégration : progression
 * globale, étapes groupées par phase (avant l'arrivée → fin d'essai), qui est
 * responsable de quoi, et les ressources associées (documents, vidéos, liens
 * utiles). Il peut faire avancer LES étapes qui lui sont assignées.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Rocket, Loader2, FileText, PlayCircle, Link2, CheckCircle2,
  Circle, CalendarDays, UserCheck, PartyPopper,
} from 'lucide-react'
import { api, formatDate } from '@/lib/api'

interface Resource { type: 'document' | 'video' | 'link'; title: string; url: string }
interface Step {
  id: string; title: string; description: string | null; phase: string
  owner_role: string; status: 'todo' | 'in_progress' | 'done'
  due_date: string | null; resources: Resource[]
}
interface MyJourney {
  id: string; status: string; started_at: string; template_name: string | null
  first_name: string; last_name: string; job_title: string | null; hire_date: string | null
  manager_first_name: string | null; manager_last_name: string | null
  steps: Step[]
}

const PHASES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'before_start',  label: 'Avant l\'arrivée',         hint: 'Tout est prêt pour vous accueillir' },
  { key: 'day_one',       label: 'Jour J',                   hint: 'Bienvenue ! Votre première journée' },
  { key: 'first_week',    label: 'Première semaine',         hint: 'Prise de repères et formations clés' },
  { key: 'first_month',   label: 'Premier mois',             hint: 'Montée en compétence et feedbacks' },
  { key: 'probation_end', label: 'Fin de période d\'essai',  hint: 'Bilan et confirmation' },
]
const OWNERS: Record<string, string> = {
  hr: 'RH', manager: 'Votre manager', employee: 'Vous', it: 'IT', buddy: 'Votre parrain',
}

function ResourceLink({ r }: { r: Resource }) {
  const Icon = r.type === 'video' ? PlayCircle : r.type === 'link' ? Link2 : FileText
  const label = r.type === 'video' ? 'Vidéo' : r.type === 'link' ? 'Lien' : 'Document'
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <Icon className="h-4 w-4 text-primary shrink-0" />
      <div className="min-w-0">
        {r.url
          ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate block">{r.title}</a>
          : <span className="text-sm truncate block">{r.title}</span>}
        <span className="text-[10px] uppercase text-muted-foreground">{label}{!r.url ? ' · remis par les RH' : ''}</span>
      </div>
    </div>
  )
}

export default function MonIntegration() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<{ data: MyJourney | null }>({
    queryKey: ['my-onboarding'],
    queryFn: () => api.get('/onboarding/my-journey').then((r) => r.data),
  })
  const updateStep = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Step['status'] }) =>
      api.patch(`/onboarding/my-steps/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-onboarding'] }),
  })

  if (isLoading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
  }
  const j = data?.data
  if (!j) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Rocket className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-semibold">Aucun parcours d'intégration en cours</p>
          <p className="text-sm text-muted-foreground mt-1">
            Votre parcours apparaîtra ici dès qu'il sera lancé par les ressources humaines.
          </p>
        </div>
      </div>
    )
  }

  const total = j.steps.length
  const done = j.steps.filter((s) => s.status === 'done').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* En-tête + progression */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {pct === 100 ? <PartyPopper className="h-6 w-6 text-emerald-600" /> : <Rocket className="h-6 w-6 text-primary" />}
          </div>
          <div className="flex-1 min-w-52">
            <h1 className="text-lg font-bold">
              {pct === 100 ? 'Intégration terminée — félicitations ! 🎉' : 'Mon parcours d\'intégration'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {j.job_title ?? ''}{j.hire_date ? ` · embauche le ${formatDate(j.hire_date)}` : ''}
              {(j.manager_first_name || j.manager_last_name) ? ` · manager : ${j.manager_first_name ?? ''} ${j.manager_last_name ?? ''}` : ''}
            </p>
          </div>
          <div className="w-full sm:w-64">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>{done}/{total} étapes</span><span>{pct}%</span>
            </div>
            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Étapes par phase */}
      {PHASES.map((phase) => {
        const steps = j.steps.filter((s) => s.phase === phase.key)
        if (steps.length === 0) return null
        const phaseDone = steps.every((s) => s.status === 'done')
        return (
          <div key={phase.key} className="rounded-xl border border-border bg-card overflow-hidden">
            <div className={`px-5 py-3 border-b border-border flex items-center gap-2 ${phaseDone ? 'bg-emerald-50' : 'bg-muted/40'}`}>
              {phaseDone ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
              <p className="font-semibold text-sm">{phase.label}</p>
              <p className="text-xs text-muted-foreground hidden sm:block">— {phase.hint}</p>
            </div>
            <div className="divide-y divide-border">
              {steps.map((s) => {
                const mine = s.owner_role === 'employee'
                const late = s.status !== 'done' && s.due_date !== null && s.due_date < today
                return (
                  <div key={s.id} className={`px-5 py-4 ${s.status === 'done' ? 'bg-emerald-50/30' : ''}`}>
                    <div className="flex items-start gap-3">
                      {/* Coche : uniquement les étapes assignées au collaborateur */}
                      {mine ? (
                        <button
                          onClick={() => updateStep.mutate({ id: s.id, status: s.status === 'done' ? 'todo' : 'done' })}
                          disabled={updateStep.isPending}
                          title={s.status === 'done' ? 'Marquer à refaire' : 'Marquer comme fait'}
                          className="mt-0.5 shrink-0">
                          {s.status === 'done'
                            ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                            : <Circle className="h-5 w-5 text-muted-foreground hover:text-primary" />}
                        </button>
                      ) : (
                        <span className="mt-0.5 shrink-0">
                          {s.status === 'done'
                            ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                            : <Circle className="h-5 w-5 text-muted-foreground/40" />}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${s.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>{s.title}</p>
                        {s.description && <p className="text-xs text-muted-foreground mt-0.5">{s.description}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                            <UserCheck className="h-3 w-3" />{OWNERS[s.owner_role] ?? s.owner_role}
                          </span>
                          {s.due_date && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${late ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                              <CalendarDays className="h-3 w-3" />{formatDate(s.due_date)}{late ? ' · en retard' : ''}
                            </span>
                          )}
                          {s.status === 'in_progress' && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">En cours</span>
                          )}
                        </div>
                        {(s.resources ?? []).length > 0 && (
                          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {s.resources.map((r, i) => <ResourceLink key={i} r={r} />)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
