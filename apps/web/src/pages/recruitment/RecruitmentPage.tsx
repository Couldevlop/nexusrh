import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Search, MapPin, Users, Clock, Edit2, Send, X, AlertCircle, Briefcase, Filter, UserPlus,
  Sparkles, Brain, Mail, Globe, ChevronRight, Loader2, Star, CheckCircle, ExternalLink,
  FileText, Download, RefreshCw, Target, Zap,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import api from '@/lib/api'
import { formatDate, cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'

interface JobOffer {
  id: string
  title: string
  department: string
  location: string
  contractType: string
  status: 'draft' | 'published' | 'closed'
  applicantCount: number
  publishedAt: string | null
}

interface Candidate {
  id: string
  firstName: string
  lastName: string
  jobOfferId: string
  stage: 'new' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected'
  email: string
  appliedAt: string
  createdAt: string
}

const STAGES: { id: Candidate['stage']; label: string; color: string; header: string }[] = [
  { id: 'new',       label: 'Nouveau',       color: 'bg-gray-50',    header: 'bg-gray-100' },
  { id: 'screening', label: 'Pré-sélection', color: 'bg-blue-50',    header: 'bg-blue-100' },
  { id: 'interview', label: 'Entretien',     color: 'bg-yellow-50',  header: 'bg-yellow-100' },
  { id: 'offer',     label: 'Offre',         color: 'bg-purple-50',  header: 'bg-purple-100' },
  { id: 'hired',     label: 'Recruté',       color: 'bg-green-50',   header: 'bg-green-100' },
]

interface ContractType { id: string; code: string; label: string }

const offerSchema = z.object({
  title:        z.string().min(2, 'Intitulé requis'),
  department:   z.string().optional(),
  location:     z.string().optional(),
  contractType: z.string().min(1, 'Type de contrat requis'),
  description:  z.string().optional(),
  status:       z.enum(['draft', 'published']).default('draft'),
})
type OfferForm = z.infer<typeof offerSchema>

const candidateSchema = z.object({
  firstName:  z.string().min(1, 'Prénom requis'),
  lastName:   z.string().min(1, 'Nom requis'),
  email:      z.string().email('Email invalide'),
  jobOfferId: z.string().min(1, 'Offre requise'),
  phone:      z.string().optional(),
  source:     z.string().optional(),
})
type CandidateForm = z.infer<typeof candidateSchema>

const STATUS_LABELS: Record<string, string> = {
  draft: 'Brouillon', published: 'Publiée', closed: 'Fermée',
}
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-green-100 text-green-700',
  closed: 'bg-red-100 text-red-700',
}

export function RecruitmentPage() {
  const queryClient = useQueryClient()
  const { user, tenantConfig } = useAuthStore()
  const [activeTab, setActiveTab]         = useState<'offers' | 'pipeline' | 'ai-sourcing' | 'careers'>('offers')
  const [search, setSearch]               = useState('')
  const [showModal, setShowModal]         = useState(false)
  const [showCandidateModal, setShowCandidateModal] = useState(false)
  const [editingOffer, setEditingOffer]   = useState<JobOffer | null>(null)
  const [pipelineOffer, setPipelineOffer] = useState<string>('all')
  const dragId = useRef<string | null>(null)

  // ── AI Sourcing state ─────────────────────────────────────────────────────
  const [sourcingOfferId, setSourcingOfferId] = useState('')
  const [sourcingPlatforms, setSourcingPlatforms] = useState<string[]>(['LinkedIn', 'Welcome to the Jungle', 'Indeed'])
  const [sourcingMaxProfiles, setSourcingMaxProfiles] = useState(10)
  const [sourcingResult, setSourcingResult] = useState<{
    strategy?: {
      summary: string
      bestPlatforms: Array<{ name: string; rationale: string; estimatedPool: number; url: string }>
      searchKeywords: string[]
      booleanSearch: string
      estimatedTimeToFill: string
      salaryBenchmark: { min: number; max: number; median: number }
      tips: string[]
    }
    profiles?: Array<{
      firstName: string
      lastName: string
      currentPosition: string
      currentCompany: string
      location: string
      experienceYears: number
      keySkills: string[]
      matchScore: number
      availabilityEstimate: string
      suggestedPlatform: string
      linkedinSearch: string
      approachStrategy: string
      estimatedSalary: number
    }>
  } | null>(null)
  const [sourcingLoading, setSourcingLoading] = useState(false)
  // Sourcing email dialog: profile index → { email, sending, sent }
  const [sourcingContactDialog, setSourcingContactDialog] = useState<{
    idx: number
    email: string
    sending: boolean
    sent: boolean
  } | null>(null)
  const [sentProfiles, setSentProfiles] = useState<Set<number>>(new Set())

  // ── Email candidat state ──────────────────────────────────────────────────
  const [emailCandidateId, setEmailCandidateId] = useState<string | null>(null)
  const [emailTemplate, setEmailTemplate] = useState<'interview_invite' | 'rejection' | 'offer' | 'sourcing_contact' | 'custom'>('interview_invite')
  const [emailCustomBody, setEmailCustomBody] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailResult, setEmailResult] = useState<{ success: boolean; message: string } | null>(null)

  // ── CV Analysis state ─────────────────────────────────────────────────────
  const [analyzingCandidateId, setAnalyzingCandidateId] = useState<string | null>(null)
  const [cvAnalysis, setCvAnalysis] = useState<Record<string, unknown> | null>(null)
  const [cvAnalyzing, setCvAnalyzing] = useState(false)

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: contractTypes = [] } = useQuery<ContractType[]>({
    queryKey: ['settings-parameters', 'contract_type'],
    queryFn: async () => (await api.get('/settings/parameters?category=contract_type')).data.data ?? [],
    staleTime: 0,
  })

  const { data: offers = [], isLoading: offersLoading } = useQuery<JobOffer[]>({
    queryKey: ['job-offers'],
    queryFn: async () => (await api.get('/recruitment/offers')).data.data ?? [],
  })

  const { data: candidates = [] } = useQuery<Candidate[]>({
    queryKey: ['candidates'],
    queryFn: async () => (await api.get('/recruitment/candidates')).data.data ?? [],
  })

  // ── Form — offre ─────────────────────────────────────────────────────────
  const {
    register, handleSubmit, reset, setValue,
    formState: { errors },
  } = useForm<OfferForm>({
    resolver: zodResolver(offerSchema),
    defaultValues: { status: 'draft' },
  })

  // ── Form — candidat ──────────────────────────────────────────────────────
  const {
    register: registerC,
    handleSubmit: handleSubmitC,
    reset: resetC,
    setValue: setValueC,
    formState: { errors: errorsC },
  } = useForm<CandidateForm>({
    resolver: zodResolver(candidateSchema),
    defaultValues: { source: 'direct' },
  })

  const openAddCandidate = (offerId?: string) => {
    resetC({ source: 'direct', jobOfferId: offerId ?? (pipelineOffer !== 'all' ? pipelineOffer : '') })
    setShowCandidateModal(true)
  }

  const openCreate = () => {
    setEditingOffer(null)
    reset({ status: 'draft' })
    setShowModal(true)
  }

  const openEdit = (offer: JobOffer) => {
    setEditingOffer(offer)
    reset({
      title:        offer.title,
      department:   offer.department,
      location:     offer.location,
      contractType: offer.contractType,
      status:       offer.status === 'closed' ? 'published' : offer.status,
    })
    setShowModal(true)
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async (data: OfferForm) => {
      if (editingOffer) {
        await api.patch(`/recruitment/offers/${editingOffer.id}`, data)
      } else {
        await api.post('/recruitment/offers', data)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-offers'] })
      setShowModal(false)
      reset()
    },
  })

  const publishMutation = useMutation({
    mutationFn: async (id: string) =>
      api.patch(`/recruitment/offers/${id}`, { status: 'published' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job-offers'] }),
  })

  const stageMutation = useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: string }) =>
      api.patch(`/recruitment/candidates/${id}/stage`, { stage }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['candidates'] }),
  })

  const addCandidateMutation = useMutation({
    mutationFn: async (data: CandidateForm) =>
      api.post('/recruitment/candidates', { ...data, stage: 'new' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setShowCandidateModal(false)
      resetC()
    },
  })

  // ── Drag-and-drop handlers ────────────────────────────────────────────────
  const onDragStart = (e: React.DragEvent, candidateId: string) => {
    dragId.current = candidateId
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const onDrop = (e: React.DragEvent, stage: string) => {
    e.preventDefault()
    const id = dragId.current
    if (!id) return
    dragId.current = null
    const candidate = candidates.find((c) => c.id === id)
    if (!candidate || candidate.stage === stage) return
    stageMutation.mutate({ id, stage })
  }

  // ── Filtered data ─────────────────────────────────────────────────────────
  const filteredOffers = offers.filter((o) =>
    search === '' ||
    o.title.toLowerCase().includes(search.toLowerCase()) ||
    (o.department ?? '').toLowerCase().includes(search.toLowerCase())
  )

  const visibleCandidates = pipelineOffer === 'all'
    ? candidates
    : candidates.filter((c) => c.jobOfferId === pipelineOffer)

  const publishedOffers = offers.filter((o) => o.status === 'published')

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Recrutement</h1>
          <p className="text-sm text-gray-500 mt-1">Gestion des offres et du pipeline candidats</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Créer une offre
        </button>
      </div>

      {/* Modal create/edit */}
      <AnimatePresence>
        {showModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowModal(false)}
              className="fixed inset-0 bg-black/40 z-40"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
            >
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-100 rounded-xl flex items-center justify-center">
                      <Briefcase className="w-4 h-4 text-indigo-600" />
                    </div>
                    <h2 className="text-base font-semibold text-gray-900">
                      {editingOffer ? 'Modifier l\'offre' : 'Nouvelle offre d\'emploi'}
                    </h2>
                  </div>
                  <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit((d) => saveMutation.mutate(d))} className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Intitulé du poste *</label>
                    <input
                      {...register('title')}
                      placeholder="ex. Développeur Full Stack Senior"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errors.title && <p className="text-xs text-red-500 mt-1">{errors.title.message}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Département</label>
                      <input
                        {...register('department')}
                        placeholder="ex. Engineering"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Localisation</label>
                      <input
                        {...register('location')}
                        placeholder="ex. Paris, France"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Type de contrat *</label>
                      <select
                        {...register('contractType')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="">Sélectionner</option>
                        {contractTypes.map((t) => <option key={t.code} value={t.label}>{t.label}</option>)}
                      </select>
                      {errors.contractType && <p className="text-xs text-red-500 mt-1">{errors.contractType.message}</p>}
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Statut</label>
                      <select
                        {...register('status')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="draft">Brouillon</option>
                        <option value="published">Publier immédiatement</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Description du poste</label>
                    <textarea
                      {...register('description')}
                      rows={3}
                      placeholder="Missions, compétences requises, avantages..."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                    />
                  </div>

                  {saveMutation.isError && (
                    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      Erreur lors de l'enregistrement
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="flex-1 py-2.5 border border-gray-300 text-sm font-medium text-gray-700 rounded-xl hover:bg-gray-50"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={saveMutation.isPending}
                      className="flex-1 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saveMutation.isPending ? 'Enregistrement...' : editingOffer ? 'Enregistrer' : 'Créer l\'offre'}
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Offres actives',    value: offers.filter(o => o.status === 'published').length, color: 'text-green-600' },
          { label: 'Candidats total',   value: candidates.length,                                   color: 'text-indigo-600' },
          { label: 'En entretien',      value: candidates.filter(c => c.stage === 'interview').length, color: 'text-yellow-600' },
          { label: 'Recrutés',          value: candidates.filter(c => c.stage === 'hired').length,  color: 'text-teal-600' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-xs text-gray-500">{s.label}</p>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 flex-wrap">
        {[
          { id: 'offers',      label: 'Offres d\'emploi',  icon: Briefcase },
          { id: 'pipeline',    label: `Pipeline${candidates.length > 0 ? ` (${candidates.length})` : ''}`, icon: Users },
          { id: 'ai-sourcing', label: 'Sourcing IA',       icon: Sparkles },
          { id: 'careers',     label: 'Page carrières',    icon: Globe },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
            {tab.id === 'ai-sourcing' && (
              <span className="ml-1 text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-semibold">IA</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Offers list ───────────────────────────────────────────────────── */}
      {activeTab === 'offers' && (
        <div className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher une offre..."
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {offersLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />
            ))
          ) : filteredOffers.length === 0 ? (
            <div className="py-16 text-center bg-white rounded-xl border border-gray-200">
              <Briefcase className="w-10 h-10 text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-400">Aucune offre — créez votre première offre d'emploi</p>
            </div>
          ) : (
            filteredOffers.map((offer) => (
              <motion.div
                key={offer.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow flex items-center justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-900 truncate">{offer.title}</h3>
                    <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0', STATUS_COLORS[offer.status])}>
                      {STATUS_LABELS[offer.status]}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                    {offer.department && (
                      <span className="flex items-center gap-1"><Users className="w-3 h-3" />{offer.department}</span>
                    )}
                    {offer.location && (
                      <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{offer.location}</span>
                    )}
                    {offer.contractType && (
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{offer.contractType}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                  {/* Publish button (only for drafts) */}
                  {offer.status === 'draft' && (
                    <button
                      onClick={() => publishMutation.mutate(offer.id)}
                      disabled={publishMutation.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      <Send className="w-3 h-3" />
                      Publier
                    </button>
                  )}
                  {/* Edit button */}
                  <button
                    onClick={() => openEdit(offer)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <Edit2 className="w-3 h-3" />
                    Modifier
                  </button>
                  {/* Candidate count */}
                  <div className="text-right min-w-[48px]">
                    <p className="text-lg font-bold text-indigo-600">
                      {candidates.filter(c => c.jobOfferId === offer.id).length}
                    </p>
                    <p className="text-xs text-gray-400">candidats</p>
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </div>
      )}

      {/* ── Kanban pipeline ───────────────────────────────────────────────── */}
      {activeTab === 'pipeline' && (
        <div className="space-y-4">
          {/* Toolbar : filter + add candidate */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <select
                value={pipelineOffer}
                onChange={(e) => setPipelineOffer(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                <option value="all">Toutes les offres ({candidates.length} candidats)</option>
                {publishedOffers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title} ({candidates.filter(c => c.jobOfferId === o.id).length})
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => openAddCandidate()}
              disabled={publishedOffers.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={publishedOffers.length === 0 ? 'Publiez d\'abord une offre' : 'Ajouter un candidat'}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Ajouter un candidat
            </button>
          </div>

          {/* Kanban columns — always visible */}
          <div className="flex gap-4 overflow-x-auto pb-4">
            {STAGES.map((stage) => {
              const stageCandidates = visibleCandidates.filter((c) => c.stage === stage.id)
              return (
                <div
                  key={stage.id}
                  className="flex-shrink-0 w-64"
                  onDragOver={onDragOver}
                  onDrop={(e) => onDrop(e, stage.id)}
                >
                  {/* Column header */}
                  <div className={cn('px-3 py-2 rounded-t-lg flex items-center justify-between', stage.header)}>
                    <span className="text-sm font-semibold text-gray-700">{stage.label}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs bg-white/70 text-gray-600 px-1.5 py-0.5 rounded-full font-medium">
                        {stageCandidates.length}
                      </span>
                      {stage.id === 'new' && (
                        <button
                          onClick={() => openAddCandidate()}
                          disabled={publishedOffers.length === 0}
                          className="text-gray-400 hover:text-indigo-600 transition-colors disabled:opacity-30"
                          title="Ajouter un candidat"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Drop zone */}
                  <div className={cn(
                    'rounded-b-lg min-h-52 p-2 space-y-2 border border-t-0 border-gray-200 transition-colors',
                    stage.color,
                  )}>
                    <AnimatePresence>
                      {stageCandidates.map((candidate) => {
                        const offer = offers.find(o => o.id === candidate.jobOfferId)
                        return (
                          <motion.div
                            key={candidate.id}
                            layout
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            draggable
                            onDragStart={(e) => onDragStart(e as unknown as React.DragEvent, candidate.id)}
                            className="bg-white rounded-lg p-3 border border-gray-100 shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow select-none"
                          >
                            <p className="text-sm font-semibold text-gray-900">
                              {candidate.firstName} {candidate.lastName}
                            </p>
                            <p className="text-xs text-gray-500 truncate mt-0.5">{candidate.email}</p>
                            {offer && pipelineOffer === 'all' && (
                              <p className="text-xs text-indigo-500 truncate mt-1 font-medium">{offer.title}</p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {formatDate(candidate.appliedAt ?? candidate.createdAt)}
                            </p>
                          </motion.div>
                        )
                      })}
                    </AnimatePresence>
                    {stageCandidates.length === 0 && (
                      <div className="h-16 border-2 border-dashed border-gray-200 rounded-lg flex items-center justify-center">
                        <p className="text-xs text-gray-300">Déposer ici</p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Hint when no candidates exist yet */}
          {candidates.length === 0 && (
            <p className="text-center text-xs text-gray-400 -mt-2">
              Aucun candidat — cliquez sur "+ Ajouter un candidat" pour commencer
            </p>
          )}
        </div>
      )}

      {/* ── Modal ajout candidat ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {showCandidateModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowCandidateModal(false)}
              className="fixed inset-0 bg-black/40 z-40"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
            >
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-100 rounded-xl flex items-center justify-center">
                      <UserPlus className="w-4 h-4 text-indigo-600" />
                    </div>
                    <h2 className="text-base font-semibold text-gray-900">Ajouter un candidat</h2>
                  </div>
                  <button onClick={() => setShowCandidateModal(false)} className="text-gray-400 hover:text-gray-600">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmitC((d) => addCandidateMutation.mutate(d))} className="space-y-4">
                  {/* Offer selector */}
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Offre d'emploi *</label>
                    <select
                      {...registerC('jobOfferId')}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                    >
                      <option value="">Sélectionner une offre</option>
                      {publishedOffers.map((o) => (
                        <option key={o.id} value={o.id}>{o.title}</option>
                      ))}
                    </select>
                    {errorsC.jobOfferId && <p className="text-xs text-red-500 mt-1">{errorsC.jobOfferId.message}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Prénom *</label>
                      <input
                        {...registerC('firstName')}
                        placeholder="Jean"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errorsC.firstName && <p className="text-xs text-red-500 mt-1">{errorsC.firstName.message}</p>}
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Nom *</label>
                      <input
                        {...registerC('lastName')}
                        placeholder="Dupont"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errorsC.lastName && <p className="text-xs text-red-500 mt-1">{errorsC.lastName.message}</p>}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Email *</label>
                    <input
                      {...registerC('email')}
                      type="email"
                      placeholder="jean.dupont@email.com"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errorsC.email && <p className="text-xs text-red-500 mt-1">{errorsC.email.message}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Téléphone</label>
                      <input
                        {...registerC('phone')}
                        placeholder="+33 6 00 00 00 00"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Source</label>
                      <select
                        {...registerC('source')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="direct">Candidature directe</option>
                        <option value="linkedin">LinkedIn</option>
                        <option value="indeed">Indeed</option>
                        <option value="referral">Recommandation</option>
                        <option value="agency">Cabinet</option>
                        <option value="other">Autre</option>
                      </select>
                    </div>
                  </div>

                  {addCandidateMutation.isError && (
                    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      Erreur lors de l'ajout du candidat
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowCandidateModal(false)}
                      className="flex-1 py-2.5 border border-gray-300 text-sm font-medium text-gray-700 rounded-xl hover:bg-gray-50"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={addCandidateMutation.isPending}
                      className="flex-1 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {addCandidateMutation.isPending ? 'Ajout...' : 'Ajouter'}
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── AI Sourcing Tab ─────────────────────────────────────────────────── */}
      {activeTab === 'ai-sourcing' && (
        <div className="space-y-6">
          {/* Model info banner */}
          <div className="flex items-start gap-3 p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
            <Brain className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-indigo-900">Sourcing automatique — Propulsé par Claude AI</p>
              <p className="text-xs text-indigo-700 mt-0.5">
                Modèle recommandé : <strong>claude-sonnet-4-20250514</strong> (meilleur rapport qualité/coût pour le sourcing).
                Pour un sourcing très approfondi : <strong>claude-opus-4-20250514</strong>.
                L'IA génère des profils synthétiques réalistes et une stratégie de sourcing depuis LinkedIn, WTTJ, Indeed, Apec, Cadremploi.
              </p>
            </div>
          </div>

          {/* Sourcing config */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <Target className="w-4 h-4 text-indigo-500" />
              Paramètres du sourcing
            </h3>

            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1.5">Offre à pourvoir *</label>
              <select
                value={sourcingOfferId}
                onChange={(e) => setSourcingOfferId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                <option value="">— Sélectionner une offre —</option>
                {offers.map((o) => (
                  <option key={o.id} value={o.id}>{o.title} ({o.status})</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1.5">Plateformes de sourcing</label>
              <div className="flex flex-wrap gap-2">
                {['LinkedIn', 'Welcome to the Jungle', 'Indeed', 'Apec', 'Cadremploi', 'Monster', 'L\'Étudiant', 'Jobteaser'].map((p) => (
                  <button
                    key={p}
                    onClick={() => setSourcingPlatforms((prev) =>
                      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                    )}
                    className={cn(
                      'px-3 py-1.5 text-xs font-medium rounded-full border transition-all',
                      sourcingPlatforms.includes(p)
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    )}
                  >
                    {sourcingPlatforms.includes(p) ? '✓ ' : ''}{p}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1.5">
                Nombre de profils à générer : {sourcingMaxProfiles}
              </label>
              <input
                type="range" min={5} max={20} step={5}
                value={sourcingMaxProfiles}
                onChange={(e) => setSourcingMaxProfiles(Number(e.target.value))}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>5 (rapide)</span><span>10</span><span>15</span><span>20 (complet)</span>
              </div>
            </div>

            <button
              onClick={async () => {
                if (!sourcingOfferId) { alert('Sélectionnez une offre'); return }
                setSourcingLoading(true)
                setSourcingResult(null)
                try {
                  const res = await api.post(`/recruitment/offers/${sourcingOfferId}/source`, {
                    platforms: sourcingPlatforms,
                    maxProfiles: sourcingMaxProfiles,
                  })
                  setSourcingResult(res.data.data)
                } catch { alert('Erreur lors du sourcing IA') }
                finally { setSourcingLoading(false) }
              }}
              disabled={sourcingLoading || !sourcingOfferId}
              className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-60 transition-colors"
            >
              {sourcingLoading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Analyse en cours (10-30s)…</>
              ) : (
                <><Sparkles className="w-4 h-4" /> Lancer le sourcing IA</>
              )}
            </button>
          </div>

          {/* Results */}
          {sourcingResult && (
            <div className="space-y-4">
              {/* Strategy */}
              {sourcingResult.strategy && (
                <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
                  <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" />
                    Stratégie de sourcing recommandée
                  </h3>
                  <p className="text-sm text-gray-700">{sourcingResult.strategy.summary}</p>

                  {/* Salary benchmark */}
                  {sourcingResult.strategy.salaryBenchmark && (
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: 'Salaire min', value: sourcingResult.strategy.salaryBenchmark.min },
                        { label: 'Médiane marché', value: sourcingResult.strategy.salaryBenchmark.median },
                        { label: 'Salaire max', value: sourcingResult.strategy.salaryBenchmark.max },
                      ].map((item) => (
                        <div key={item.label} className="bg-gray-50 rounded-xl p-3 text-center">
                          <p className="text-xs text-gray-500">{item.label}</p>
                          <p className="text-base font-bold text-gray-900">{item.value?.toLocaleString('fr-FR')} €</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Best platforms */}
                  {sourcingResult.strategy.bestPlatforms?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-2">Meilleures plateformes</p>
                      <div className="space-y-2">
                        {sourcingResult.strategy.bestPlatforms.slice(0, 4).map((p) => (
                          <div key={p.name} className="flex items-start justify-between gap-3 p-2.5 bg-gray-50 rounded-lg">
                            <div className="flex-1">
                              <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                              <p className="text-xs text-gray-500">{p.rationale}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-xs text-indigo-600 font-semibold">~{p.estimatedPool?.toLocaleString()} profils</p>
                              {p.url && (
                                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-indigo-600 flex items-center gap-1 justify-end">
                                  Ouvrir <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Boolean search */}
                  {sourcingResult.strategy.booleanSearch && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-1.5">Recherche booléenne LinkedIn</p>
                      <div className="bg-gray-900 rounded-xl p-3">
                        <code className="text-xs text-green-400 font-mono">{sourcingResult.strategy.booleanSearch}</code>
                      </div>
                    </div>
                  )}

                  {/* Keywords */}
                  {sourcingResult.strategy.searchKeywords?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-1.5">Mots-clés recommandés</p>
                      <div className="flex flex-wrap gap-1.5">
                        {sourcingResult.strategy.searchKeywords.map((kw) => (
                          <span key={kw} className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded-full">{kw}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tips */}
                  {sourcingResult.strategy.tips?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-1.5">Conseils de sourcing</p>
                      <ul className="space-y-1">
                        {sourcingResult.strategy.tips.map((tip) => (
                          <li key={tip} className="flex items-start gap-2 text-xs text-gray-600">
                            <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                            {tip}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Candidate profiles */}
              {sourcingResult.profiles?.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
                    <Users className="w-4 h-4 text-indigo-500" />
                    {sourcingResult.profiles.length} profils identifiés
                  </h3>
                  <div className="grid grid-cols-1 gap-3">
                    {sourcingResult.profiles.map((profile, idx) => (
                      <div key={idx} className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-bold text-gray-900">{profile.firstName} {profile.lastName}</p>
                            <p className="text-xs text-gray-500">{profile.currentPosition} chez {profile.currentCompany}</p>
                            <p className="text-xs text-gray-400">📍 {profile.location} · {profile.experienceYears} ans d'exp.</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className={cn(
                              'text-lg font-bold rounded-full w-12 h-12 flex items-center justify-center',
                              profile.matchScore >= 80 ? 'bg-green-100 text-green-700' :
                              profile.matchScore >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'
                            )}>
                              {profile.matchScore}%
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {profile.keySkills?.slice(0, 5).map((sk) => (
                            <span key={sk} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">{sk}</span>
                          ))}
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                          <p>🏦 ~{profile.estimatedSalary?.toLocaleString('fr-FR')} €/an</p>
                          <p>⏳ Dispo : {
                            { immediate: 'Immédiate', '1month': '1 mois', '3months': '3 mois', passive: 'Passif' }[profile.availabilityEstimate] ?? profile.availabilityEstimate
                          }</p>
                          <p>📱 Via : {profile.suggestedPlatform}</p>
                        </div>

                        {profile.approachStrategy && (
                          <p className="text-xs text-indigo-700 bg-indigo-50 rounded-lg px-3 py-2">
                            💡 {profile.approachStrategy}
                          </p>
                        )}

                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={async () => {
                              try {
                                await api.post('/recruitment/candidates', {
                                  firstName: profile.firstName,
                                  lastName: profile.lastName,
                                  email: `${profile.firstName.toLowerCase()}.${profile.lastName.toLowerCase()}@sourcing.nexusrh`,
                                  jobOfferId: sourcingOfferId,
                                  currentPosition: profile.currentPosition,
                                  currentCompany: profile.currentCompany,
                                  source: profile.suggestedPlatform,
                                  stage: 'new',
                                })
                                queryClient.invalidateQueries({ queryKey: ['recruitment-candidates'] })
                                alert(`${profile.firstName} ${profile.lastName} ajouté au pipeline !`)
                              } catch { alert('Erreur lors de l\'ajout') }
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700"
                          >
                            <Plus className="w-3 h-3" /> Ajouter au pipeline
                          </button>

                          {sentProfiles.has(idx) ? (
                            <span className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 text-xs font-medium rounded-lg border border-green-200">
                              ✓ Email envoyé
                            </span>
                          ) : (
                            <button
                              onClick={() => setSourcingContactDialog({ idx, email: '', sending: false, sent: false })}
                              className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-300 text-indigo-700 bg-indigo-50 text-xs font-medium rounded-lg hover:bg-indigo-100"
                            >
                              <Mail className="w-3 h-3" /> Envoyer mail
                            </button>
                          )}

                          {profile.linkedinSearch && (
                            <button
                              onClick={() => window.open(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(profile.linkedinSearch)}`, '_blank')}
                              className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-700 text-xs font-medium rounded-lg hover:bg-gray-50"
                            >
                              <ExternalLink className="w-3 h-3" /> LinkedIn
                            </button>
                          )}
                        </div>

                        {/* Inline email dialog for this profile */}
                        {sourcingContactDialog?.idx === idx && (
                          <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded-xl space-y-2">
                            <p className="text-xs font-semibold text-indigo-900">Contacter {profile.firstName} {profile.lastName}</p>
                            <p className="text-xs text-indigo-700">
                              Un email de prise de contact personnalisé sera généré par l'IA selon l'offre <strong>{offers.find(o => o.id === sourcingOfferId)?.title ?? ''}</strong>.
                            </p>
                            <input
                              type="email"
                              placeholder="Email du candidat *"
                              value={sourcingContactDialog.email}
                              onChange={(e) => setSourcingContactDialog(d => d ? { ...d, email: e.target.value } : null)}
                              className="w-full border border-indigo-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                            />
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => setSourcingContactDialog(null)}
                                className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                              >
                                Annuler
                              </button>
                              <button
                                disabled={!sourcingContactDialog.email || sourcingContactDialog.sending}
                                onClick={async () => {
                                  if (!sourcingContactDialog.email) return
                                  setSourcingContactDialog(d => d ? { ...d, sending: true } : null)
                                  try {
                                    // Create candidate with real email
                                    const res = await api.post('/recruitment/candidates', {
                                      firstName: profile.firstName,
                                      lastName: profile.lastName,
                                      email: sourcingContactDialog.email,
                                      jobOfferId: sourcingOfferId,
                                      currentPosition: profile.currentPosition,
                                      currentCompany: profile.currentCompany,
                                      source: profile.suggestedPlatform,
                                      stage: 'new',
                                    })
                                    const candidateId = res.data.data?.id
                                    // Send sourcing contact email via AI
                                    await api.post(`/recruitment/candidates/${candidateId}/send-email`, {
                                      template: 'sourcing_contact',
                                      generateWithAI: true,
                                    })
                                    queryClient.invalidateQueries({ queryKey: ['recruitment-candidates'] })
                                    setSentProfiles(prev => new Set([...prev, idx]))
                                    setSourcingContactDialog(null)
                                  } catch {
                                    alert('Erreur lors de l\'envoi. Vérifiez la configuration SMTP.')
                                    setSourcingContactDialog(d => d ? { ...d, sending: false } : null)
                                  }
                                }}
                                className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                              >
                                {sourcingContactDialog.sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                                Envoyer
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Careers page Tab ─────────────────────────────────────────────────── */}
      {activeTab === 'careers' && (
        <div className="space-y-5">
          <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
            <Globe className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-green-900">Page carrières publique</p>
              <p className="text-xs text-green-700 mt-0.5">
                Vos candidats externes peuvent postuler directement via cette page intégrée à votre site internet.
                Aucun compte NexusRH nécessaire.
              </p>
            </div>
          </div>

          {/* URL Display */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <h3 className="text-sm font-bold text-gray-900">URL de votre page carrières</h3>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 font-mono text-sm text-gray-700 break-all">
                {(import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000')}/recruitment/careers/{tenantConfig?.slug ?? 'votre-slug'}
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000'}/recruitment/careers/${tenantConfig?.slug ?? ''}`)
                  alert('URL copiée !')
                }}
                className="px-3 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 flex-shrink-0"
              >
                Copier
              </button>
              <a
                href={`${import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000'}/recruitment/careers/${tenantConfig?.slug ?? ''}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 flex-shrink-0"
              >
                <ExternalLink className="w-4 h-4" />
                Aperçu
              </a>
            </div>
          </div>

          {/* Offers published */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-900 mb-3">Offres visibles sur la page carrières</h3>
            {offers.filter((o) => o.status === 'published').length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Briefcase className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm">Aucune offre publiée pour le moment.</p>
                <p className="text-xs text-gray-400 mt-1">Publiez une offre dans l'onglet "Offres d'emploi" pour qu'elle apparaisse sur votre page carrières.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {offers.filter((o) => o.status === 'published').map((o) => (
                  <div key={o.id} className="flex items-center justify-between gap-3 p-3 bg-gray-50 rounded-xl">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{o.title}</p>
                      <p className="text-xs text-gray-500">{o.location} · {o.contractType}</p>
                    </div>
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                      ✓ Visible
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Integration code */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <h3 className="text-sm font-bold text-gray-900">Intégrer sur votre site web</h3>
            <p className="text-xs text-gray-500">Ajoutez ce code sur votre site pour afficher les offres dans un iframe :</p>
            <div className="bg-gray-900 rounded-xl p-4">
              <code className="text-xs text-green-400 font-mono whitespace-pre">
{`<iframe
  src="${import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000'}/recruitment/careers/${tenantConfig?.slug ?? 'votre-slug'}"
  width="100%"
  height="800"
  frameborder="0"
  title="Offres d'emploi"
></iframe>`}
              </code>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
