import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Users, AlertTriangle, CheckCircle, Clock, TrendingUp,
  Plus, ChevronDown, ChevronUp, Send, PenLine, Star,
  BarChart2, BookOpen, Target, Award, Info
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { fr } from 'date-fns/locale'
import api from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
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
  signedByEmployee: boolean
  signedByManager: boolean
  cpfAbondementRequired: boolean
  employeeId: string
  employeeFirstName: string
  employeeLastName: string
  employeeJobTitle: string
}

interface ComplianceData {
  summary: {
    overdue: number
    dueSoon: number
    sixYearDue: number
    cpfRisk: number
    totalActive: number
    complianceRate: number
  }
  overdue: Array<{ id: string; firstName: string; lastName: string; jobTitle: string; hireDate: string }>
  dueSoon: Array<{ id: string; firstName: string; lastName: string; jobTitle: string; hireDate: string }>
  sixYearDue: Array<{ id: string; firstName: string; lastName: string; jobTitle: string }>
  cpfRisk: Array<{ id: string; firstName: string; lastName: string; jobTitle: string }>
}

interface NineBoxEntry {
  id: string
  year: number
  box: number
  performanceAxis: number
  potentialAxis: number
  employeeId: string
  employeeFirstName: string
  employeeLastName: string
  employeeJobTitle: string
  employeePhoto: string | null
  notes: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const INTERVIEW_TYPES: Record<string, { label: string; color: string; legal?: boolean }> = {
  annual:         { label: 'Entretien annuel',         color: 'bg-blue-100 text-blue-800' },
  professional:   { label: 'Entretien professionnel',  color: 'bg-indigo-100 text-indigo-800', legal: true },
  six_year_review:{ label: 'Bilan 6 ans',              color: 'bg-purple-100 text-purple-800', legal: true },
  mid_year:       { label: 'Point mi-parcours',        color: 'bg-green-100 text-green-800' },
  trial_period:   { label: 'Fin de période d\'essai',  color: 'bg-orange-100 text-orange-800' },
  '360':          { label: 'Évaluation 360°',          color: 'bg-yellow-100 text-yellow-800' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  planned:               { label: 'Planifié',            color: 'bg-slate-100 text-slate-700', icon: <Clock className="w-3 h-3" /> },
  invited:               { label: 'Invité',              color: 'bg-blue-100 text-blue-700',   icon: <Send className="w-3 h-3" /> },
  in_progress:           { label: 'En cours',            color: 'bg-yellow-100 text-yellow-700', icon: <PenLine className="w-3 h-3" /> },
  awaiting_employee_sign:{ label: 'Attente signature',   color: 'bg-orange-100 text-orange-700', icon: <PenLine className="w-3 h-3" /> },
  completed:             { label: 'Clôturé',             color: 'bg-green-100 text-green-700', icon: <CheckCircle className="w-3 h-3" /> },
  cancelled:             { label: 'Annulé',              color: 'bg-red-100 text-red-700',     icon: <AlertTriangle className="w-3 h-3" /> },
}

const NINE_BOX_LABELS: Record<number, { label: string; color: string; description: string }> = {
  1: { label: 'Performance à améliorer',  color: '#fee2e2', description: 'Potentiel faible, Performance faible' },
  2: { label: 'Employé stable',           color: '#fef3c7', description: 'Potentiel faible, Performance moyenne' },
  3: { label: 'Fort contributeur',        color: '#d1fae5', description: 'Potentiel faible, Performance élevée' },
  4: { label: 'Dilemme',                  color: '#fef3c7', description: 'Potentiel moyen, Performance faible' },
  5: { label: 'Cœur de métier',           color: '#dbeafe', description: 'Potentiel moyen, Performance moyenne' },
  6: { label: 'Expert reconnu',           color: '#d1fae5', description: 'Potentiel moyen, Performance élevée' },
  7: { label: 'Haut potentiel',           color: '#ede9fe', description: 'Potentiel élevé, Performance faible' },
  8: { label: 'Talent à développer',      color: '#dbeafe', description: 'Potentiel élevé, Performance moyenne' },
  9: { label: 'Talent exceptionnel',      color: '#d1fae5', description: 'Potentiel élevé, Performance élevée' },
}

// ── Composant entretien card ──────────────────────────────────────────────────
function EvaluationCard({ ev, onInvite, onSign }: {
  ev: Evaluation
  onInvite: (id: string) => void
  onSign: (id: string) => void
}) {
  const typeConfig = INTERVIEW_TYPES[ev.type] ?? { label: ev.type, color: 'bg-gray-100 text-gray-800' }
  const statusConf = STATUS_CONFIG[ev.status] ?? { label: ev.status, color: 'bg-gray-100', icon: null }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="hover:shadow-md transition-shadow">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', typeConfig.color)}>
                  {typeConfig.label}
                </span>
                {typeConfig.legal && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                    ⚖ Obligatoire L6315-1
                  </span>
                )}
                <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full', statusConf.color)}>
                  {statusConf.icon}{statusConf.label}
                </span>
              </div>
              <p className="font-semibold text-slate-900 truncate">
                {ev.employeeFirstName} {ev.employeeLastName}
              </p>
              <p className="text-xs text-slate-500 truncate">{ev.employeeJobTitle}</p>
              {ev.scheduledAt && (
                <p className="text-xs text-slate-500 mt-1">
                  📅 {format(new Date(ev.scheduledAt), 'dd MMM yyyy HH:mm', { locale: fr })}
                </p>
              )}
              {ev.overallRating && (
                <div className="flex gap-0.5 mt-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className={cn('w-3.5 h-3.5', i < ev.overallRating! ? 'fill-yellow-400 text-yellow-400' : 'text-gray-200')} />
                  ))}
                </div>
              )}
              {ev.cpfAbondementRequired && (
                <p className="text-xs text-red-600 font-medium mt-1">
                  ⚠ Abondement CPF requis (3 000 €)
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              {ev.status === 'planned' && (
                <Button size="sm" variant="outline" onClick={() => onInvite(ev.id)} className="text-xs">
                  <Send className="w-3 h-3 mr-1" />Inviter
                </Button>
              )}
              {ev.status === 'in_progress' && !ev.signedByManager && (
                <Button size="sm" onClick={() => onSign(ev.id)} className="text-xs">
                  <PenLine className="w-3 h-3 mr-1" />Signer
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

// ── Page principale ───────────────────────────────────────────────────────────
export function CareersPage() {
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState('evaluations')
  const [showNewEvalDialog, setShowNewEvalDialog] = useState(false)
  const [nineBoxYear, setNineBoxYear] = useState(new Date().getFullYear())
  const [filterType, setFilterType] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')

  // Form state
  const [newEval, setNewEval] = useState({
    employeeId: '',
    type: 'professional',
    year: new Date().getFullYear(),
    scheduledAt: '',
  })

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: evalsData } = useQuery({
    queryKey: ['evaluations', filterType, filterStatus],
    queryFn: () => {
      const params = new URLSearchParams()
      if (filterType !== 'all') params.set('type', filterType)
      if (filterStatus !== 'all') params.set('status', filterStatus)
      params.set('limit', '100')
      return api.get(`/careers/evaluations?${params}`).then((r) => r.data.data as Evaluation[])
    },
  })

  const { data: complianceData } = useQuery({
    queryKey: ['careers-compliance'],
    queryFn: () => api.get('/careers/compliance').then((r) => r.data.data as ComplianceData),
    staleTime: 5 * 60 * 1000,
  })

  const { data: nineBoxData } = useQuery({
    queryKey: ['nine-box', nineBoxYear],
    queryFn: () => api.get(`/careers/nine-box?year=${nineBoxYear}`).then((r) => r.data.data as NineBoxEntry[]),
  })

  const { data: employeesData } = useQuery({
    queryKey: ['employees-list-light'],
    queryFn: () => api.get('/employees?limit=500&status=active').then((r) => r.data.data as Array<{ id: string; firstName: string; lastName: string }>),
  })

  // ── Mutations ────────────────────────────────────────────────────────────
  const createEval = useMutation({
    mutationFn: (data: typeof newEval) => {
      if (!data.employeeId) throw new Error('Veuillez sélectionner un employé')
      return api.post('/careers/evaluations', data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evaluations'] })
      setShowNewEvalDialog(false)
      toast({ title: 'Entretien planifié avec succès' })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la création'
      toast({ title: msg, variant: 'destructive' })
    },
  })

  const inviteMut = useMutation({
    mutationFn: (id: string) => api.post(`/careers/evaluations/${id}/invite`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evaluations'] })
      toast({ title: 'Invitation envoyée par email' })
    },
  })

  const signMut = useMutation({
    mutationFn: (id: string) => api.post(`/careers/evaluations/${id}/sign-manager`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evaluations'] })
      toast({ title: 'Entretien signé' })
    },
  })

  const evals = evalsData ?? []
  const compliance = complianceData
  const nineBoxEntries = nineBoxData ?? []

  // ── Matrice 9-box layout ─────────────────────────────────────────────────
  const nineBoxGrid: NineBoxEntry[][] = Array.from({ length: 9 }, (_, i) =>
    nineBoxEntries.filter((e) => e.box === i + 1)
  )

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Carrières & Entretiens</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Gestion des entretiens annuels, entretiens professionnels obligatoires et plans de carrière
          </p>
        </div>
        <Button onClick={() => setShowNewEvalDialog(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Planifier un entretien
        </Button>
      </div>

      {/* Alerte conformité légale */}
      {compliance && compliance.summary.overdue > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3"
        >
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-800">
              {compliance.summary.overdue} collaborateur{compliance.summary.overdue > 1 ? 's' : ''} en retard sur l'entretien professionnel obligatoire
            </p>
            <p className="text-sm text-red-700 mt-0.5">
              Art. L6315-1 du Code du Travail : entretien professionnel obligatoire tous les 2 ans.
              Sanction en cas de non-respect : abondement correctif du CPF de 3 000 € par salarié.
            </p>
          </div>
        </motion.div>
      )}

      {/* KPIs conformité */}
      {compliance && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Taux de conformité</p>
                  <p className={cn('text-2xl font-bold', compliance.summary.complianceRate >= 90 ? 'text-green-600' : compliance.summary.complianceRate >= 70 ? 'text-yellow-600' : 'text-red-600')}>
                    {compliance.summary.complianceRate}%
                  </p>
                </div>
                <div className={cn('p-2 rounded-full', compliance.summary.complianceRate >= 90 ? 'bg-green-100' : 'bg-red-100')}>
                  <CheckCircle className={cn('w-5 h-5', compliance.summary.complianceRate >= 90 ? 'text-green-600' : 'text-red-600')} />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">En retard (&gt; 2 ans)</p>
                  <p className="text-2xl font-bold text-red-600">{compliance.summary.overdue}</p>
                </div>
                <div className="p-2 rounded-full bg-red-100">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Échéance proche</p>
                  <p className="text-2xl font-bold text-yellow-600">{compliance.summary.dueSoon}</p>
                </div>
                <div className="p-2 rounded-full bg-yellow-100">
                  <Clock className="w-5 h-5 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">Risque abondement CPF</p>
                  <p className="text-2xl font-bold text-purple-600">{compliance.summary.cpfRisk}</p>
                </div>
                <div className="p-2 rounded-full bg-purple-100">
                  <Award className="w-5 h-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Onglets */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="evaluations">Entretiens</TabsTrigger>
          <TabsTrigger value="compliance">Conformité légale</TabsTrigger>
          <TabsTrigger value="nine-box">Matrice 9-box</TabsTrigger>
        </TabsList>

        {/* ── Onglet Entretiens ──────────────────────────────────────────── */}
        <TabsContent value="evaluations" className="space-y-4">
          {/* Filtres */}
          <div className="flex gap-3 flex-wrap">
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Type d'entretien" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les types</SelectItem>
                {Object.entries(INTERVIEW_TYPES).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Statut" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {evals.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <BookOpen className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p className="font-medium">Aucun entretien trouvé</p>
              <p className="text-sm">Planifiez le premier entretien avec le bouton ci-dessus.</p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {evals.map((ev) => (
                <EvaluationCard
                  key={ev.id}
                  ev={ev}
                  onInvite={(id) => inviteMut.mutate(id)}
                  onSign={(id) => signMut.mutate(id)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Onglet Conformité ──────────────────────────────────────────── */}
        <TabsContent value="compliance" className="space-y-6">
          {/* Explication légale */}
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="p-4 flex gap-3">
              <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-semibold mb-1">Obligations légales — Article L6315-1 du Code du Travail</p>
                <ul className="space-y-1 list-disc list-inside text-blue-700">
                  <li>Entretien professionnel obligatoire tous les <strong>2 ans</strong> pour chaque salarié en CDI</li>
                  <li>Bilan récapitulatif tous les <strong>6 ans</strong> : vérification de 2 critères sur 3 (formation non obligatoire, certification, progression salariale/professionnelle)</li>
                  <li>Sanction si bilan insuffisant : <strong>abondement correctif du CPF de 3 000 €</strong> par salarié (entreprises ≥ 50 salariés)</li>
                  <li>En cas d'accord collectif : l'entreprise peut négocier une fréquence différente</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          {compliance && (
            <>
              {compliance.overdue.length > 0 && (
                <Card className="border-red-200">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-red-700 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" />
                      En retard — entretien professionnel non réalisé depuis &gt; 2 ans ({compliance.overdue.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y">
                      {compliance.overdue.map((emp) => (
                        <div key={emp.id} className="py-2.5 flex items-center justify-between">
                          <div>
                            <p className="font-medium text-sm">{emp.firstName} {emp.lastName}</p>
                            <p className="text-xs text-slate-500">{emp.jobTitle}</p>
                          </div>
                          <Button size="sm" variant="outline" className="text-xs border-red-300 text-red-700"
                            onClick={() => {
                              setNewEval((n) => ({ ...n, employeeId: emp.id, type: 'professional' }))
                              setShowNewEvalDialog(true)
                            }}>
                            <Plus className="w-3 h-3 mr-1" />Planifier
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {compliance.dueSoon.length > 0 && (
                <Card className="border-yellow-200">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-yellow-700 flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Échéance dans moins de 3 mois ({compliance.dueSoon.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y">
                      {compliance.dueSoon.map((emp) => (
                        <div key={emp.id} className="py-2.5 flex items-center justify-between">
                          <div>
                            <p className="font-medium text-sm">{emp.firstName} {emp.lastName}</p>
                            <p className="text-xs text-slate-500">{emp.jobTitle}</p>
                          </div>
                          <Button size="sm" variant="outline" className="text-xs"
                            onClick={() => {
                              setNewEval((n) => ({ ...n, employeeId: emp.id, type: 'professional' }))
                              setShowNewEvalDialog(true)
                            }}>
                            <Plus className="w-3 h-3 mr-1" />Planifier
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {compliance.sixYearDue.length > 0 && (
                <Card className="border-purple-200">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-purple-700 flex items-center gap-2">
                      <Award className="w-4 h-4" />
                      Bilan 6 ans à réaliser ({compliance.sixYearDue.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y">
                      {compliance.sixYearDue.map((emp) => (
                        <div key={emp.id} className="py-2.5 flex items-center justify-between">
                          <div>
                            <p className="font-medium text-sm">{emp.firstName} {emp.lastName}</p>
                            <p className="text-xs text-slate-500">{emp.jobTitle}</p>
                          </div>
                          <Button size="sm" variant="outline" className="text-xs border-purple-300 text-purple-700"
                            onClick={() => {
                              setNewEval((n) => ({ ...n, employeeId: emp.id, type: 'six_year_review' }))
                              setShowNewEvalDialog(true)
                            }}>
                            <Plus className="w-3 h-3 mr-1" />Bilan 6 ans
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {compliance.cpfRisk.length === 0 && compliance.overdue.length === 0 && compliance.dueSoon.length === 0 && (
                <div className="text-center py-10">
                  <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
                  <p className="font-semibold text-green-700">Conformité totale ✓</p>
                  <p className="text-sm text-slate-500">Tous les entretiens professionnels sont à jour.</p>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ── Onglet Matrice 9-box ───────────────────────────────────────── */}
        <TabsContent value="nine-box" className="space-y-4">
          <div className="flex items-center gap-4">
            <Label>Année</Label>
            <Select value={String(nineBoxYear)} onValueChange={(v) => setNineBoxYear(Number(v))}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2024, 2025, 2026].map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-slate-500">{nineBoxEntries.length} collaborateurs positionnés</p>
          </div>

          {/* Légendes axes */}
          <div className="flex gap-8 text-xs text-slate-500 mb-2">
            <span>← Performance (axe X) →</span>
            <span>↑ Potentiel (axe Y)</span>
          </div>

          {/* Grille 3x3 */}
          <div className="grid grid-cols-3 gap-2">
            {/* Ligne 3 (potentiel élevé) → boxes 7,8,9 */}
            {[7, 8, 9].map((boxNum) => (
              <NineBoxCell key={boxNum} boxNum={boxNum} entries={nineBoxGrid[boxNum - 1] ?? []} />
            ))}
            {/* Ligne 2 (potentiel moyen) → boxes 4,5,6 */}
            {[4, 5, 6].map((boxNum) => (
              <NineBoxCell key={boxNum} boxNum={boxNum} entries={nineBoxGrid[boxNum - 1] ?? []} />
            ))}
            {/* Ligne 1 (potentiel faible) → boxes 1,2,3 */}
            {[1, 2, 3].map((boxNum) => (
              <NineBoxCell key={boxNum} boxNum={boxNum} entries={nineBoxGrid[boxNum - 1] ?? []} />
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialog — planifier un entretien */}
      <Dialog open={showNewEvalDialog} onOpenChange={setShowNewEvalDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Planifier un entretien</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Collaborateur</Label>
              <Select value={newEval.employeeId} onValueChange={(v) => setNewEval((n) => ({ ...n, employeeId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionner un collaborateur" />
                </SelectTrigger>
                <SelectContent>
                  {(employeesData ?? []).map((emp) => (
                    <SelectItem key={emp.id} value={emp.id}>{emp.firstName} {emp.lastName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Type d'entretien</Label>
              <Select value={newEval.type} onValueChange={(v) => setNewEval((n) => ({ ...n, type: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(INTERVIEW_TYPES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v.label}{v.legal ? ' ⚖' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(newEval.type === 'professional' || newEval.type === 'six_year_review') && (
                <p className="text-xs text-blue-600 bg-blue-50 rounded px-2 py-1">
                  ⚖ Obligation légale — art. L6315-1 du Code du Travail
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Année</Label>
                <Input
                  type="number"
                  value={newEval.year}
                  onChange={(e) => setNewEval((n) => ({ ...n, year: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Date & heure</Label>
                <Input
                  type="datetime-local"
                  value={newEval.scheduledAt}
                  onChange={(e) => setNewEval((n) => ({ ...n, scheduledAt: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewEvalDialog(false)}>Annuler</Button>
            <Button
              disabled={!newEval.employeeId || createEval.isPending}
              onClick={() => createEval.mutate(newEval)}
            >
              {createEval.isPending ? 'Enregistrement...' : 'Planifier'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Cellule 9-box ──────────────────────────────────────────────────────────────
function NineBoxCell({ boxNum, entries }: { boxNum: number; entries: NineBoxEntry[] }) {
  const config = NINE_BOX_LABELS[boxNum]
  return (
    <div
      className="min-h-28 rounded-lg p-3 border border-slate-200"
      style={{ backgroundColor: config.color }}
    >
      <p className="text-xs font-semibold text-slate-700 mb-1.5">{config.label}</p>
      <p className="text-xs text-slate-500 mb-2">{config.description}</p>
      <div className="flex flex-wrap gap-1">
        {entries.map((e) => (
          <div key={e.id} className="inline-flex items-center gap-1 bg-white rounded-full px-2 py-0.5 text-xs shadow-sm">
            <div className="w-4 h-4 rounded-full bg-indigo-200 flex items-center justify-center text-xs font-bold text-indigo-700">
              {e.employeeFirstName[0]}
            </div>
            <span className="font-medium">{e.employeeFirstName} {e.employeeLastName[0]}.</span>
          </div>
        ))}
      </div>
    </div>
  )
}
