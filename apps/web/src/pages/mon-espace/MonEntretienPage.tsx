import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Calendar, CheckCircle, Clock, PenLine, ChevronDown, ChevronUp,
  Star, FileText, Info, Award, AlertTriangle, BookOpen, Target
} from 'lucide-react'
import { format } from 'date-fns'
import { fr } from 'date-fns/locale'
import api from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Evaluation {
  id: string
  type: string
  year: number
  status: string
  scheduledAt: string | null
  completedAt: string | null
  overallRating: number | null
  goalsAchievement: number | null
  strengths: string | null
  improvements: string | null
  nextYearGoals: Array<{ goal: string; indicator?: string; dueDate?: string }> | null
  signedByEmployee: boolean
  signedByManager: boolean
  employeeSignedAt: string | null
  managerSignedAt: string | null
  employeeComments: string | null
  managerComments: string | null
  // Champs entretien professionnel L6315-1
  careerProjectDiscussed: boolean | null
  trainingNeedsIdentified: boolean | null
  cpfInformationProvided: boolean | null
  qualificationsDiscussed: boolean | null
  employabilityDiscussed: boolean | null
  // Bilan 6 ans
  sixYearCriteria_formation: boolean | null
  sixYearCriteria_certification: boolean | null
  sixYearCriteria_progression: boolean | null
  cpfAbondementRequired: boolean | null
}

interface DevelopmentPlan {
  id: string
  year: number
  title: string
  status: string
  shortTermGoal: string | null
  mediumTermGoal: string | null
  longTermGoal: string | null
  objectives: Array<{ id: string; description: string; type: string; priority: string; dueDate?: string; progress: number }>
  trainingActions: Array<{ id: string; title: string; type: string; status: string; estimatedDuration?: string }>
  employeeComments: string | null
}

// ── Config ────────────────────────────────────────────────────────────────────
const TYPE_CONFIG: Record<string, { label: string; icon: string; description: string; color: string; legal?: boolean }> = {
  annual:         { label: 'Entretien annuel d\'évaluation', icon: '📊', color: 'border-blue-200 bg-blue-50',
                    description: 'Évaluation de vos performances, objectifs et évolution salariale.' },
  professional:   { label: 'Entretien professionnel',       icon: '⚖️', color: 'border-indigo-200 bg-indigo-50', legal: true,
                    description: 'Entretien obligatoire (art. L6315-1) portant sur vos perspectives d\'évolution professionnelle, vos souhaits de formation et votre employabilité. Distinct de l\'évaluation.' },
  six_year_review:{ label: 'Bilan 6 ans',                   icon: '🎯', color: 'border-purple-200 bg-purple-50', legal: true,
                    description: 'Bilan récapitulatif obligatoire tous les 6 ans vérifiant 3 critères légaux (formation, certification, progression).' },
  mid_year:       { label: 'Point mi-parcours',              icon: '📅', color: 'border-green-200 bg-green-50',
                    description: 'Point intermédiaire sur l\'avancement de vos objectifs annuels.' },
  trial_period:   { label: 'Fin de période d\'essai',        icon: '🤝', color: 'border-orange-200 bg-orange-50',
                    description: 'Entretien de bilan de votre période d\'essai.' },
  '360':          { label: 'Évaluation 360°',                icon: '🔄', color: 'border-yellow-200 bg-yellow-50',
                    description: 'Évaluation à 360° incluant les retours de vos pairs, managés et manager.' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  planned:               { label: 'Planifié',              color: 'bg-slate-100 text-slate-700' },
  invited:               { label: 'Invitation reçue',      color: 'bg-blue-100 text-blue-700' },
  in_progress:           { label: 'En cours',              color: 'bg-yellow-100 text-yellow-700' },
  awaiting_employee_sign:{ label: 'En attente de votre signature', color: 'bg-orange-100 text-orange-700' },
  completed:             { label: 'Clôturé',               color: 'bg-green-100 text-green-700' },
  cancelled:             { label: 'Annulé',                color: 'bg-red-100 text-red-700' },
}

// ── Carte entretien (expandable) ──────────────────────────────────────────────
function EvaluationCard({ ev, onSign, onComment }: {
  ev: Evaluation
  onSign: (id: string, comments: string) => void
  onComment: (id: string, comments: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [signDialog, setSignDialog] = useState(false)
  const [commentDialog, setCommentDialog] = useState(false)
  const [draftComment, setDraftComment] = useState(ev.employeeComments ?? '')

  const type = TYPE_CONFIG[ev.type] ?? { label: ev.type, icon: '📋', description: '', color: 'border-slate-200 bg-slate-50' }
  const status = STATUS_CONFIG[ev.status] ?? { label: ev.status, color: 'bg-gray-100 text-gray-700' }

  const needsSignature = ev.status === 'awaiting_employee_sign' && !ev.signedByEmployee

  return (
    <>
      <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className={cn('border-l-4', type.color, needsSignature && 'ring-2 ring-orange-400')}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-lg">{type.icon}</span>
                  <div>
                    <p className="font-semibold text-slate-900 text-sm">{type.label}</p>
                    <p className="text-xs text-slate-500">Année {ev.year}</p>
                  </div>
                  {type.legal && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                      ⚖ Obligatoire
                    </span>
                  )}
                </div>

                <span className={cn('inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-2', status.color)}>
                  {status.label}
                </span>

                {needsSignature && (
                  <p className="text-sm font-medium text-orange-700 bg-orange-50 rounded px-2 py-1 mb-2">
                    ✋ Votre signature est requise pour clôturer cet entretien.
                  </p>
                )}

                {ev.scheduledAt && (
                  <p className="text-xs text-slate-500 flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {format(new Date(ev.scheduledAt), 'EEEE dd MMMM yyyy à HH:mm', { locale: fr })}
                  </p>
                )}

                {ev.overallRating && (
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-xs text-slate-500">Note globale :</span>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} className={cn('w-3.5 h-3.5', i < ev.overallRating! ? 'fill-yellow-400 text-yellow-400' : 'text-gray-200')} />
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2 shrink-0">
                {needsSignature && (
                  <Button size="sm" onClick={() => setSignDialog(true)} className="text-xs bg-orange-600 hover:bg-orange-700">
                    <PenLine className="w-3 h-3 mr-1" />Signer
                  </Button>
                )}
                {ev.status === 'completed' && (
                  <Button size="sm" variant="outline" onClick={() => setCommentDialog(true)} className="text-xs">
                    <FileText className="w-3 h-3 mr-1" />Mon commentaire
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)} className="text-xs">
                  {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            {/* Détails expandables */}
            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-4 space-y-4 border-t pt-4"
                >
                  <p className="text-xs text-slate-500 italic">{type.description}</p>

                  {/* Entretien annuel — objectifs */}
                  {ev.type === 'annual' && ev.nextYearGoals && ev.nextYearGoals.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5" />Objectifs pour l'année prochaine
                      </p>
                      <div className="space-y-1.5">
                        {ev.nextYearGoals.map((g, i) => (
                          <div key={i} className="text-xs bg-slate-50 rounded px-3 py-2 flex items-start gap-2">
                            <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold shrink-0 mt-0.5">{i + 1}</span>
                            <div>
                              <p>{g.goal}</p>
                              {g.indicator && <p className="text-slate-400 mt-0.5">Indicateur : {g.indicator}</p>}
                              {g.dueDate && <p className="text-slate-400">Échéance : {g.dueDate}</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Forces / Axes d'amélioration */}
                  {ev.strengths && (
                    <div>
                      <p className="text-xs font-semibold text-green-700 mb-1">✅ Points forts</p>
                      <p className="text-xs text-slate-600 bg-green-50 rounded px-3 py-2">{ev.strengths}</p>
                    </div>
                  )}
                  {ev.improvements && (
                    <div>
                      <p className="text-xs font-semibold text-blue-700 mb-1">📈 Axes de développement</p>
                      <p className="text-xs text-slate-600 bg-blue-50 rounded px-3 py-2">{ev.improvements}</p>
                    </div>
                  )}

                  {/* Entretien professionnel L6315-1 — thèmes abordés */}
                  {ev.type === 'professional' && ev.status === 'completed' && (
                    <div>
                      <p className="text-xs font-semibold text-indigo-700 mb-2">⚖ Thèmes abordés (art. L6315-1)</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[
                          { key: 'careerProjectDiscussed',   label: 'Projet professionnel' },
                          { key: 'trainingNeedsIdentified',  label: 'Besoins de formation' },
                          { key: 'cpfInformationProvided',   label: 'Information CPF' },
                          { key: 'qualificationsDiscussed',  label: 'Certification / qualification' },
                          { key: 'employabilityDiscussed',   label: 'Employabilité' },
                        ].map(({ key, label }) => {
                          const val = (ev as Record<string, unknown>)[key]
                          return (
                            <div key={key} className={cn('text-xs rounded px-2 py-1 flex items-center gap-1.5', val ? 'bg-green-50 text-green-700' : 'bg-slate-50 text-slate-400')}>
                              {val ? <CheckCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                              {label}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Bilan 6 ans */}
                  {ev.type === 'six_year_review' && ev.status === 'completed' && (
                    <div>
                      <p className="text-xs font-semibold text-purple-700 mb-2">🎯 Critères bilan 6 ans</p>
                      <div className="space-y-1">
                        {[
                          { key: 'sixYearCriteria_formation',     label: 'Au moins une formation non obligatoire' },
                          { key: 'sixYearCriteria_certification', label: 'Certification ou qualification obtenue' },
                          { key: 'sixYearCriteria_progression',   label: 'Progression salariale ou professionnelle' },
                        ].map(({ key, label }, i) => {
                          const val = (ev as Record<string, unknown>)[key]
                          return (
                            <div key={key} className={cn('text-xs rounded px-3 py-2 flex items-center gap-2', val ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200')}>
                              {val ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                              <span className="font-medium">Critère {i + 1}</span> — {label}
                            </div>
                          )
                        })}
                      </div>
                      {ev.cpfAbondementRequired && (
                        <p className="text-xs font-medium text-red-700 bg-red-50 rounded px-3 py-2 mt-2 border border-red-200">
                          ⚠ Abondement correctif CPF (3 000 €) requis — moins de 2 critères atteints sur 6 ans.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Commentaires manager */}
                  {ev.managerComments && (
                    <div>
                      <p className="text-xs font-semibold text-slate-700 mb-1">💬 Commentaire du manager</p>
                      <p className="text-xs text-slate-600 bg-slate-50 rounded px-3 py-2 italic">{ev.managerComments}</p>
                    </div>
                  )}

                  {/* Mes commentaires */}
                  {ev.employeeComments && (
                    <div>
                      <p className="text-xs font-semibold text-slate-700 mb-1">✏ Mes commentaires</p>
                      <p className="text-xs text-slate-600 bg-indigo-50 rounded px-3 py-2">{ev.employeeComments}</p>
                    </div>
                  )}

                  {/* Signatures */}
                  <div className="flex gap-4 text-xs text-slate-500 border-t pt-3">
                    <span className={cn('flex items-center gap-1', ev.signedByEmployee ? 'text-green-600' : 'text-slate-400')}>
                      <CheckCircle className="w-3 h-3" />
                      Signé par vous {ev.employeeSignedAt ? `le ${format(new Date(ev.employeeSignedAt), 'dd/MM/yyyy', { locale: fr })}` : ''}
                    </span>
                    <span className={cn('flex items-center gap-1', ev.signedByManager ? 'text-green-600' : 'text-slate-400')}>
                      <CheckCircle className="w-3 h-3" />
                      Signé par le manager {ev.managerSignedAt ? `le ${format(new Date(ev.managerSignedAt), 'dd/MM/yyyy', { locale: fr })}` : ''}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </motion.div>

      {/* Dialog signature */}
      <Dialog open={signDialog} onOpenChange={setSignDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Signer l'entretien</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-slate-600">
              En signant, vous confirmez avoir participé à cet entretien et pris connaissance de son contenu.
              Vous pouvez ajouter un commentaire avant de signer.
            </p>
            <div className="space-y-1.5">
              <Label>Commentaire (optionnel)</Label>
              <Textarea
                placeholder="Vos remarques, précisions ou réserves sur le contenu de l'entretien..."
                value={draftComment}
                onChange={(e) => setDraftComment(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignDialog(false)}>Annuler</Button>
            <Button onClick={() => {
              onSign(ev.id, draftComment)
              setSignDialog(false)
            }}>
              <PenLine className="w-4 h-4 mr-2" />Signer l'entretien
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog commentaire */}
      <Dialog open={commentDialog} onOpenChange={setCommentDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mon commentaire</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>Commentaire</Label>
            <Textarea
              placeholder="Vos observations sur cet entretien..."
              value={draftComment}
              onChange={(e) => setDraftComment(e.target.value)}
              rows={5}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommentDialog(false)}>Annuler</Button>
            <Button onClick={() => {
              onComment(ev.id, draftComment)
              setCommentDialog(false)
            }}>
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ── Page principale ───────────────────────────────────────────────────────────
export function MonEntretienPage() {
  const qc = useQueryClient()

  const { data: evalsData, isLoading } = useQuery({
    queryKey: ['my-evaluations'],
    queryFn: () => api.get('/careers/my-evaluations').then((r) => r.data.data as Evaluation[]),
  })

  const { data: devPlan } = useQuery({
    queryKey: ['my-dev-plan'],
    queryFn: () => api.get('/careers/my-development-plan').then((r) => r.data.data as DevelopmentPlan | null),
  })

  const signMut = useMutation({
    mutationFn: ({ id, comments }: { id: string; comments: string }) =>
      api.post(`/careers/evaluations/${id}/sign-employee`, { comments }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-evaluations'] })
      toast({ title: 'Entretien signé', description: 'Votre signature a bien été enregistrée.' })
    },
  })

  const commentMut = useMutation({
    mutationFn: ({ id, comments }: { id: string; comments: string }) =>
      api.patch(`/careers/my-evaluations/${id}/comments`, { comments }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-evaluations'] })
      toast({ title: 'Commentaire enregistré' })
    },
  })

  const evals = evalsData ?? []
  const pendingSign = evals.filter((e) => e.status === 'awaiting_employee_sign' && !e.signedByEmployee)
  const upcoming = evals.filter((e) => ['planned', 'invited'].includes(e.status))
  const past = evals.filter((e) => ['completed', 'cancelled'].includes(e.status))

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Mes entretiens</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Entretiens annuels, entretiens professionnels obligatoires et bilans de carrière
        </p>
      </div>

      {/* Alerte : signature requise */}
      {pendingSign.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-orange-800">
              {pendingSign.length} entretien{pendingSign.length > 1 ? 's' : ''} en attente de votre signature
            </p>
            <p className="text-sm text-orange-700">Veuillez signer pour clôturer l'entretien.</p>
          </div>
        </div>
      )}

      {/* Info entretien professionnel */}
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-4 flex gap-3">
          <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700">
            <strong>Entretien professionnel :</strong> vous avez le droit à un entretien professionnel tous les 2 ans
            (art. L6315-1 du Code du Travail). Il porte sur votre évolution professionnelle, vos besoins en formation
            et votre projet professionnel — non sur l'évaluation de vos performances.
          </p>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* À signer */}
      {pendingSign.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-orange-700 mb-3 flex items-center gap-2">
            <PenLine className="w-4 h-4" />En attente de signature ({pendingSign.length})
          </h2>
          <div className="space-y-3">
            {pendingSign.map((ev) => (
              <EvaluationCard
                key={ev.id}
                ev={ev}
                onSign={(id, c) => signMut.mutate({ id, comments: c })}
                onComment={(id, c) => commentMut.mutate({ id, comments: c })}
              />
            ))}
          </div>
        </section>
      )}

      {/* À venir */}
      {upcoming.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Calendar className="w-4 h-4" />À venir ({upcoming.length})
          </h2>
          <div className="space-y-3">
            {upcoming.map((ev) => (
              <EvaluationCard
                key={ev.id}
                ev={ev}
                onSign={(id, c) => signMut.mutate({ id, comments: c })}
                onComment={(id, c) => commentMut.mutate({ id, comments: c })}
              />
            ))}
          </div>
        </section>
      )}

      {/* Passés */}
      {past.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />Historique ({past.length})
          </h2>
          <div className="space-y-3">
            {past.map((ev) => (
              <EvaluationCard
                key={ev.id}
                ev={ev}
                onSign={(id, c) => signMut.mutate({ id, comments: c })}
                onComment={(id, c) => commentMut.mutate({ id, comments: c })}
              />
            ))}
          </div>
        </section>
      )}

      {!isLoading && evals.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          <BookOpen className="w-12 h-12 mx-auto mb-3 text-slate-300" />
          <p className="font-medium">Aucun entretien planifié</p>
          <p className="text-sm">Vos entretiens apparaîtront ici une fois planifiés par votre manager ou le service RH.</p>
        </div>
      )}

      {/* Plan de développement individuel */}
      {devPlan && (
        <section>
          <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Target className="w-4 h-4" />Mon Plan de Développement Individuel (PDI)
          </h2>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{devPlan.title}</CardTitle>
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">{devPlan.year}</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {devPlan.shortTermGoal && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-1">Objectif 1 an</p>
                  <p className="text-sm text-slate-700">{devPlan.shortTermGoal}</p>
                </div>
              )}
              {devPlan.mediumTermGoal && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-1">Objectif 3 ans</p>
                  <p className="text-sm text-slate-700">{devPlan.mediumTermGoal}</p>
                </div>
              )}
              {devPlan.objectives.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">Objectifs de développement</p>
                  <div className="space-y-2">
                    {devPlan.objectives.map((obj) => (
                      <div key={obj.id} className="text-xs bg-slate-50 rounded px-3 py-2">
                        <div className="flex items-start justify-between">
                          <p className="font-medium">{obj.description}</p>
                          <span className={cn('ml-2 px-1.5 py-0.5 rounded text-xs', obj.priority === 'high' ? 'bg-red-100 text-red-700' : obj.priority === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700')}>
                            {obj.priority === 'high' ? 'Prioritaire' : obj.priority === 'medium' ? 'Moyen' : 'Normal'}
                          </span>
                        </div>
                        <div className="mt-1.5 bg-slate-200 rounded-full h-1.5 w-full">
                          <div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: `${obj.progress}%` }} />
                        </div>
                        <p className="text-slate-400 mt-0.5">{obj.progress}% réalisé</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {devPlan.trainingActions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">Actions de formation</p>
                  <div className="space-y-1.5">
                    {devPlan.trainingActions.map((action) => (
                      <div key={action.id} className="text-xs flex items-center gap-2 bg-blue-50 rounded px-3 py-2">
                        <BookOpen className="w-3 h-3 text-blue-500" />
                        <span className="flex-1">{action.title}</span>
                        <span className={cn('px-1.5 py-0.5 rounded', action.status === 'completed' ? 'bg-green-100 text-green-700' : action.status === 'in_progress' ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-100 text-slate-600')}>
                          {action.status === 'completed' ? 'Réalisé' : action.status === 'in_progress' ? 'En cours' : 'Prévu'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}
