import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Edit, Sparkles, FileText, X, Plus, Trash2,
  Briefcase, Calendar, TrendingUp, Award, AlertCircle, UserCheck,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useEmployee, useUpdateEmployee } from '@/hooks/useEmployees'
import { usePaySlips } from '@/hooks/usePayroll'
import { useAbsences, useAbsenceBalances } from '@/hooks/useAbsences'
import { formatDate, formatCurrency, getStatusColor, cn } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'
import api from '@/lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HREvent {
  id: string
  type: string
  title: string
  description?: string | null
  eventDate: string
  isPrivate?: boolean
  createdAt: string
}

interface EmployeeSkill {
  id: string
  skillId: string
  skillName: string | null
  skillCategory: string | null
  level: number
  assessedAt?: string | null
}

interface SkillRef {
  id: string
  name: string
  category: string | null
}

interface EmployeeDocument {
  id: string
  type: string
  title: string
  fileUrl: string
  fileSize?: number | null
  mimeType?: string | null
  isConfidential?: boolean
  createdAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'profile', label: 'Profil' },
  { id: 'contracts', label: 'Contrats & Paie' },
  { id: 'absences', label: 'Absences & Congés' },
  { id: 'timeline', label: 'Timeline RH' },
  { id: 'skills', label: 'Compétences' },
  { id: 'documents', label: 'Documents' },
]

const HR_EVENT_TYPES: Record<string, { label: string; icon: typeof Briefcase; color: string }> = {
  hire:        { label: 'Embauche',           icon: UserCheck,    color: 'text-green-600 bg-green-100' },
  promotion:   { label: 'Promotion',          icon: TrendingUp,   color: 'text-indigo-600 bg-indigo-100' },
  salary:      { label: 'Augmentation',       icon: Award,        color: 'text-purple-600 bg-purple-100' },
  transfer:    { label: 'Mutation',           icon: Briefcase,    color: 'text-blue-600 bg-blue-100' },
  warning:     { label: 'Avertissement',      icon: AlertCircle,  color: 'text-red-600 bg-red-100' },
  departure:   { label: 'Départ',             icon: ArrowLeft,    color: 'text-gray-600 bg-gray-100' },
  training:    { label: 'Formation',          icon: Award,        color: 'text-yellow-600 bg-yellow-100' },
  evaluation:  { label: 'Entretien',          icon: UserCheck,    color: 'text-teal-600 bg-teal-100' },
  other:       { label: 'Autre',              icon: Calendar,     color: 'text-gray-500 bg-gray-100' },
}

const LEVEL_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'Débutant',      color: 'bg-gray-100 text-gray-600' },
  2: { label: 'Intermédiaire', color: 'bg-blue-100 text-blue-700' },
  3: { label: 'Avancé',        color: 'bg-indigo-100 text-indigo-700' },
  4: { label: 'Expert',        color: 'bg-purple-100 text-purple-700' },
}

const DOC_TYPE_LABELS: Record<string, string> = {
  contract:      'Contrat',
  id:            'Pièce d\'identité',
  payslip:       'Bulletin de paie',
  certificate:   'Certificat',
  amendment:     'Avenant',
  other:         'Autre',
}

// ── Edit schema ───────────────────────────────────────────────────────────────

const editSchema = z.object({
  firstName:              z.string().min(1),
  lastName:               z.string().min(1),
  email:                  z.string().email().optional().or(z.literal('')),
  phone:                  z.string().optional(),
  jobTitle:               z.string().optional(),
  jobLevel:               z.string().optional(),
  departmentId:           z.string().uuid().optional().or(z.literal('')),
  workingTimePercentage:  z.number().min(1).max(100),
  weeklyHours:            z.number().min(1).max(48),
})

type EditFormData = z.infer<typeof editSchema>

// ── Add event schema ──────────────────────────────────────────────────────────

const eventSchema = z.object({
  type:        z.string().min(1),
  title:       z.string().min(1),
  description: z.string().optional(),
  eventDate:   z.string().min(1),
})

type EventFormData = z.infer<typeof eventSchema>

// ── Contract schema ───────────────────────────────────────────────────────────

const contractSchema = z.object({
  type:               z.string().min(1, 'Requis'),
  startDate:          z.string().min(1, 'Requis'),
  endDate:            z.string().optional(),
  trialPeriodEnd:     z.string().optional(),
  grossSalary:        z.number({ invalid_type_error: 'Requis' }).min(1),
  workingHoursPerWeek:z.number().min(1).max(48).default(35),
  collectiveAgreement:z.string().optional(),
  telecommutingDays:  z.number().min(0).max(5).default(0),
})

type ContractFormData = z.infer<typeof contractSchema>

interface RefParam { id: string; code: string; label: string }

// ── Component ─────────────────────────────────────────────────────────────────

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('profile')
  const [editOpen, setEditOpen] = useState(false)
  const [addEventOpen, setAddEventOpen] = useState(false)
  const [addSkillOpen, setAddSkillOpen] = useState(false)
  const [addContractOpen, setAddContractOpen] = useState(false)
  const { setAIDrawerOpen } = useUIStore()

  const { data: employee, isLoading } = useEmployee(id ?? '')
  const { data: payslips } = usePaySlips(id ?? '')
  const { data: absences } = useAbsences(id ?? '')
  const { data: balances } = useAbsenceBalances(id ?? '')
  const updateEmployee = useUpdateEmployee(id ?? '')

  // Timeline
  const { data: timeline = [] } = useQuery<HREvent[]>({
    queryKey: ['employee-timeline', id],
    queryFn: async () => (await api.get(`/employees/${id}/timeline`)).data.data ?? [],
    enabled: !!id && activeTab === 'timeline',
  })

  // Skills
  const { data: employeeSkillsList = [] } = useQuery<EmployeeSkill[]>({
    queryKey: ['employee-skills', id],
    queryFn: async () => (await api.get(`/employees/${id}/skills`)).data.data ?? [],
    enabled: !!id && activeTab === 'skills',
  })

  const { data: skillRefs = [] } = useQuery<SkillRef[]>({
    queryKey: ['skills-ref'],
    queryFn: async () => (await api.get('/careers/skills')).data.data ?? [],
    enabled: addSkillOpen,
  })

  // Contract type & CCN refs
  const { data: contractTypes = [] } = useQuery<RefParam[]>({
    queryKey: ['settings-parameters', 'contract_type'],
    queryFn: async () => (await api.get('/settings/parameters?category=contract_type')).data.data ?? [],
  })
  const { data: collectiveAgreements = [] } = useQuery<RefParam[]>({
    queryKey: ['settings-parameters', 'collective_agreement'],
    queryFn: async () => (await api.get('/settings/parameters?category=collective_agreement')).data.data ?? [],
  })

  // Contract form
  const contractForm = useForm<ContractFormData>({
    resolver: zodResolver(contractSchema),
    defaultValues: { workingHoursPerWeek: 35, telecommutingDays: 0 },
  })

  const createContractMutation = useMutation({
    mutationFn: (data: ContractFormData) =>
      api.post('/contracts', { ...data, employeeId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employee-contracts', id] })
      setAddContractOpen(false)
      contractForm.reset()
    },
  })

  // Contracts
  interface Contract {
    id: string
    type: string
    startDate: string
    endDate?: string | null
    grossSalary: string
    status: string
    collectiveAgreement?: string | null
    workingHoursPerWeek?: string | null
    createdAt: string
  }
  const { data: employeeContracts = [] } = useQuery<Contract[]>({
    queryKey: ['employee-contracts', id],
    queryFn: async () => (await api.get(`/contracts?employeeId=${id}`)).data.data ?? [],
    enabled: !!id && activeTab === 'contracts',
  })

  // Documents
  const { data: documents = [] } = useQuery<EmployeeDocument[]>({
    queryKey: ['employee-documents', id],
    queryFn: async () => (await api.get(`/employees/${id}/documents`)).data.data ?? [],
    enabled: !!id && activeTab === 'documents',
  })

  // Edit form
  const editForm = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    values: employee
      ? {
          firstName:             employee.firstName,
          lastName:              employee.lastName,
          email:                 employee.email ?? '',
          phone:                 employee.phone ?? '',
          jobTitle:              employee.jobTitle ?? '',
          jobLevel:              employee.jobLevel ?? '',
          departmentId:          employee.departmentId ?? '',
          workingTimePercentage: Number(employee.workingTimePercentage ?? 100),
          weeklyHours:           Number(employee.weeklyHours ?? 35),
        }
      : undefined,
  })

  const handleEditSubmit = (data: EditFormData) => {
    updateEmployee.mutate(
      {
        ...data,
        departmentId: data.departmentId || undefined,
        email: data.email || undefined,
        workingTimePercentage: String(data.workingTimePercentage),
        weeklyHours: String(data.weeklyHours),
      },
      {
        onSuccess: () => setEditOpen(false),
      },
    )
  }

  // Add HR event
  const eventForm = useForm<EventFormData>({ resolver: zodResolver(eventSchema) })
  const addEventMutation = useMutation({
    mutationFn: (data: EventFormData) => api.post(`/employees/${id}/timeline`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employee-timeline', id] })
      setAddEventOpen(false)
      eventForm.reset()
    },
  })

  // Add skill
  const [newSkillId, setNewSkillId] = useState('')
  const [newSkillLevel, setNewSkillLevel] = useState(2)
  const addSkillMutation = useMutation({
    mutationFn: () => api.post(`/employees/${id}/skills`, { skillId: newSkillId, level: newSkillLevel }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employee-skills', id] })
      setAddSkillOpen(false)
      setNewSkillId('')
      setNewSkillLevel(2)
    },
  })

  const removeSkillMutation = useMutation({
    mutationFn: (skillRowId: string) => api.delete(`/employees/${id}/skills/${skillRowId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employee-skills', id] }),
  })

  const deleteEventMutation = useMutation({
    mutationFn: (eventId: string) => api.delete(`/employees/${id}/timeline/${eventId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employee-timeline', id] }),
  })

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-24 bg-gray-200 rounded-xl" />
          <div className="h-64 bg-gray-200 rounded-xl" />
        </div>
      </div>
    )
  }

  if (!employee) {
    return <div className="p-6 text-center text-gray-500">Collaborateur introuvable</div>
  }

  const retentionPct = employee.retentionScore
    ? Math.round(Number(employee.retentionScore) * 100)
    : null

  const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
  const labelClass = 'text-xs font-medium text-gray-700 block mb-1'

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/employees')}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Collaborateurs
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">{employee.firstName} {employee.lastName}</span>
      </div>

      {/* Hero card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      >
        <div className="h-24 bg-gradient-to-r from-indigo-600 to-purple-600" />
        <div className="px-6 pb-5">
          <div className="flex items-end justify-between -mt-10">
            <div className="w-20 h-20 rounded-2xl bg-white border-4 border-white shadow-md flex items-center justify-center text-2xl font-bold text-indigo-700">
              {employee.firstName.charAt(0)}{employee.lastName.charAt(0)}
            </div>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setAIDrawerOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Analyser avec l'IA
              </button>
              <button
                onClick={() => setEditOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <Edit className="w-4 h-4" />
                Modifier
              </button>
            </div>
          </div>

          <div className="mt-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">
                {employee.firstName} {employee.lastName}
              </h1>
              <span className={cn('text-xs px-2 py-1 rounded-full font-medium', getStatusColor(employee.status))}>
                {employee.status}
              </span>
              {employee.employeeNumber && (
                <span className="text-xs text-gray-400 font-mono">#{employee.employeeNumber}</span>
              )}
            </div>
            <p className="text-sm text-gray-500 mt-1">
              {employee.jobTitle ?? 'Poste non défini'}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t">
            <div>
              <p className="text-xs text-gray-400">Date d'embauche</p>
              <p className="text-sm font-medium text-gray-700">
                {employee.hireDate ? formatDate(employee.hireDate) : 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Temps de travail</p>
              <p className="text-sm font-medium text-gray-700">{employee.workingTimePercentage}%</p>
            </div>
            {retentionPct !== null && (
              <div>
                <p className="text-xs text-gray-400">Score rétention</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-gray-200 rounded-full">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        retentionPct >= 70 ? 'bg-green-500' :
                        retentionPct >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                      )}
                      style={{ width: `${retentionPct}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-gray-700">{retentionPct}%</span>
                </div>
              </div>
            )}
            {employee.burnoutRisk && (
              <div>
                <p className="text-xs text-gray-400">Risque burnout</p>
                <span className={cn(
                  'text-xs px-2 py-1 rounded-full font-medium',
                  employee.burnoutRisk === 'low'    ? 'bg-green-100 text-green-700' :
                  employee.burnoutRisk === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                )}>
                  {employee.burnoutRisk}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-gray-200 px-6 flex overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                activeTab === tab.id
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </motion.div>

      {/* Tab content */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">

        {/* ── PROFIL ── */}
        {activeTab === 'profile' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Informations personnelles</h3>
              {[
                { label: 'Email',             value: employee.email },
                { label: 'Téléphone',         value: employee.phone },
                { label: 'Date de naissance', value: employee.birthDate ? formatDate(employee.birthDate) : null },
                { label: 'Nationalité',       value: employee.nationality },
              ].map(({ label, value }) => value && (
                <div key={label}>
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className="text-sm text-gray-700">{value}</p>
                </div>
              ))}
            </div>
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Informations professionnelles</h3>
              {[
                { label: 'Titre',            value: employee.jobTitle },
                { label: 'Niveau',           value: employee.jobLevel },
                { label: 'Date d\'embauche', value: employee.hireDate ? formatDate(employee.hireDate) : null },
                { label: 'Temps de travail', value: `${employee.workingTimePercentage}% — ${employee.weeklyHours}h/semaine` },
              ].map(({ label, value }) => value && (
                <div key={label}>
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className="text-sm text-gray-700">{value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── CONTRATS & PAIE ── */}
        {activeTab === 'contracts' && (
          <div className="space-y-6">
            {/* Contracts list */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Contrats & Avenants</h3>
                <button
                  onClick={() => setAddContractOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" /> Nouveau contrat
                </button>
              </div>
              {employeeContracts.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Aucun contrat enregistré</p>
                  <button onClick={() => setAddContractOpen(true)} className="mt-2 text-sm text-indigo-600 hover:underline">
                    + Ajouter le premier contrat
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {employeeContracts.map((contract) => (
                    <div key={contract.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center">
                          <Briefcase className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-800">{contract.type.toUpperCase()}</p>
                          <p className="text-xs text-gray-500">
                            Depuis le {formatDate(contract.startDate)}
                            {contract.endDate ? ` → ${formatDate(contract.endDate)}` : ' (en cours)'}
                          </p>
                          {contract.collectiveAgreement && (
                            <p className="text-xs text-gray-400">CCN : {contract.collectiveAgreement}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-gray-700">{formatCurrency(Number(contract.grossSalary))}</p>
                        <p className="text-xs text-gray-400">brut / mois</p>
                        <span className={cn(
                          'text-xs px-2 py-0.5 rounded-full font-medium',
                          contract.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                        )}>
                          {contract.status === 'active' ? 'En cours' : contract.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pay slips */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Bulletins de paie récents</h3>
              {(!payslips || payslips.length === 0) ? (
                <p className="text-sm text-gray-400">Aucun bulletin de paie disponible</p>
              ) : (
                <div className="space-y-2">
                  {payslips.slice(0, 6).map((ps) => (
                    <div key={ps.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-gray-700">
                          {new Date(ps.year ?? 0, (ps.month ?? 1) - 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
                        </p>
                        <p className="text-xs text-gray-400">Net : {formatCurrency(Number(ps.netPayable))}</p>
                      </div>
                      {ps.pdfUrl && (
                        <a href={ps.pdfUrl} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-indigo-600 hover:underline flex items-center gap-1">
                          <FileText className="w-3 h-3" /> PDF
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ABSENCES ── */}
        {activeTab === 'absences' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Soldes de congés</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {balances?.map((balance) => (
                  <div key={balance.id} className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 font-medium">{balance.absenceTypeId}</p>
                    <div className="flex items-baseline gap-1 mt-1">
                      <span className="text-2xl font-bold text-gray-900">
                        {Number(balance.acquired) - Number(balance.taken)}
                      </span>
                      <span className="text-xs text-gray-400">jours</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 rounded-full mt-2">
                      <div className="h-full bg-indigo-600 rounded-full"
                        style={{ width: `${Math.min(100, (Number(balance.taken) / Math.max(1, Number(balance.acquired))) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-1">{Number(balance.taken)}/{Number(balance.acquired)} pris</p>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Historique des absences</h3>
              {(!absences || absences.length === 0) ? (
                <p className="text-sm text-gray-400">Aucune absence enregistrée</p>
              ) : (
                <div className="space-y-2">
                  {absences.map((absence) => (
                    <div key={absence.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-gray-700">
                          {formatDate(absence.startDate)} — {formatDate(absence.endDate)}
                        </p>
                        <p className="text-xs text-gray-400">{absence.daysCount} jours</p>
                      </div>
                      <span className={cn('text-xs px-2 py-1 rounded-full font-medium', getStatusColor(absence.status))}>
                        {absence.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TIMELINE RH ── */}
        {activeTab === 'timeline' && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-gray-700">Historique RH</h3>
              <button
                onClick={() => setAddEventOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Ajouter un événement
              </button>
            </div>

            {timeline.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <Calendar className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun événement RH enregistré</p>
                <p className="text-xs mt-1">Les embauches, promotions et événements importants apparaîtront ici</p>
              </div>
            ) : (
              <div className="relative">
                <div className="absolute left-5 top-0 bottom-0 w-px bg-gray-200" />
                <div className="space-y-4">
                  {timeline.map((event) => {
                    const meta = HR_EVENT_TYPES[event.type] ?? HR_EVENT_TYPES['other']!
                    const Icon = meta.icon
                    return (
                      <div key={event.id} className="flex gap-4 group">
                        <div className={cn('relative z-10 w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0', meta.color)}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 bg-gray-50 rounded-lg p-3 hover:bg-gray-100 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-gray-900">{event.title}</span>
                                <span className="text-xs px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-500">
                                  {meta.label}
                                </span>
                                {event.isPrivate && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-500 border border-red-100">
                                    Confidentiel
                                  </span>
                                )}
                              </div>
                              {event.description && (
                                <p className="text-xs text-gray-500 mt-1">{event.description}</p>
                              )}
                              <p className="text-xs text-gray-400 mt-1">{formatDate(event.eventDate)}</p>
                            </div>
                            <button
                              onClick={() => deleteEventMutation.mutate(event.id)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── COMPÉTENCES ── */}
        {activeTab === 'skills' && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-gray-700">Compétences du collaborateur</h3>
              <button
                onClick={() => setAddSkillOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Ajouter une compétence
              </button>
            </div>

            {employeeSkillsList.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <Award className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucune compétence enregistrée</p>
                <p className="text-xs mt-1">Ajoutez les compétences depuis le référentiel</p>
              </div>
            ) : (
              <div>
                {/* Group by category */}
                {Array.from(new Set(employeeSkillsList.map(s => s.skillCategory ?? 'Autres'))).map((cat) => (
                  <div key={cat} className="mb-5">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{cat}</p>
                    <div className="space-y-2">
                      {employeeSkillsList
                        .filter(s => (s.skillCategory ?? 'Autres') === cat)
                        .map((skill) => {
                          const lvl = LEVEL_LABELS[skill.level] ?? LEVEL_LABELS[1]!
                          return (
                            <div key={skill.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg group">
                              <div className="flex items-center gap-3">
                                <div className="flex gap-0.5">
                                  {[1, 2, 3, 4].map((n) => (
                                    <div key={n} className={cn(
                                      'w-2.5 h-2.5 rounded-full',
                                      n <= skill.level ? 'bg-indigo-600' : 'bg-gray-200'
                                    )} />
                                  ))}
                                </div>
                                <span className="text-sm text-gray-700">{skill.skillName}</span>
                                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', lvl.color)}>
                                  {lvl.label}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                {skill.assessedAt && (
                                  <span className="text-xs text-gray-400 hidden group-hover:inline">
                                    Évalué le {formatDate(skill.assessedAt)}
                                  </span>
                                )}
                                <button
                                  onClick={() => removeSkillMutation.mutate(skill.id)}
                                  className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
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
        )}

        {/* ── DOCUMENTS ── */}
        {activeTab === 'documents' && (
          <div>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-gray-700">Documents du collaborateur</h3>
            </div>

            {documents.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun document enregistré</p>
                <p className="text-xs mt-1">Les contrats, avenants et pièces jointes apparaîtront ici</p>
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-white border border-gray-200 rounded-lg flex items-center justify-center">
                        <FileText className="w-4 h-4 text-gray-500" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-700">{doc.title}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-400">
                            {DOC_TYPE_LABELS[doc.type] ?? doc.type}
                          </span>
                          {doc.fileSize && (
                            <span className="text-xs text-gray-300">
                              · {Math.round(doc.fileSize / 1024)} Ko
                            </span>
                          )}
                          <span className="text-xs text-gray-300">
                            · {formatDate(doc.createdAt)}
                          </span>
                          {doc.isConfidential && (
                            <span className="text-xs px-1.5 py-0.5 bg-red-50 text-red-500 rounded">
                              Confidentiel
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <a
                      href={doc.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:underline flex items-center gap-1 px-2 py-1 rounded hover:bg-indigo-50"
                    >
                      <FileText className="w-3 h-3" />
                      Ouvrir
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══ MODAL MODIFIER ════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {editOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setEditOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <h2 className="font-semibold text-gray-900">Modifier le collaborateur</h2>
                <button onClick={() => setEditOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={editForm.handleSubmit(handleEditSubmit)} className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Prénom *</label>
                    <input {...editForm.register('firstName')} className={inputClass} />
                    {editForm.formState.errors.firstName && (
                      <p className="text-xs text-red-500 mt-1">{editForm.formState.errors.firstName.message}</p>
                    )}
                  </div>
                  <div>
                    <label className={labelClass}>Nom *</label>
                    <input {...editForm.register('lastName')} className={inputClass} />
                    {editForm.formState.errors.lastName && (
                      <p className="text-xs text-red-500 mt-1">{editForm.formState.errors.lastName.message}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Email</label>
                  <input {...editForm.register('email')} type="email" className={inputClass} />
                </div>

                <div>
                  <label className={labelClass}>Téléphone</label>
                  <input {...editForm.register('phone')} className={inputClass} />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Intitulé du poste</label>
                    <input {...editForm.register('jobTitle')} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Niveau</label>
                    <input {...editForm.register('jobLevel')} className={inputClass} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Temps de travail (%)</label>
                    <input
                      {...editForm.register('workingTimePercentage', { valueAsNumber: true })}
                      type="number" min={1} max={100}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Heures / semaine</label>
                    <input
                      {...editForm.register('weeklyHours', { valueAsNumber: true })}
                      type="number" min={1} max={48}
                      className={inputClass}
                    />
                  </div>
                </div>

                {updateEmployee.isError && (
                  <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                    Erreur lors de la mise à jour
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditOpen(false)}
                    className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    disabled={updateEmployee.isPending}
                    className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                  >
                    {updateEmployee.isPending ? 'Enregistrement…' : 'Enregistrer'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══ MODAL AJOUTER ÉVÉNEMENT RH ════════════════════════════════════════ */}
      <AnimatePresence>
        {addEventOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setAddEventOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <h2 className="font-semibold text-gray-900">Nouvel événement RH</h2>
                <button onClick={() => setAddEventOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={eventForm.handleSubmit((d) => addEventMutation.mutate(d))} className="p-6 space-y-4">
                <div>
                  <label className={labelClass}>Type d'événement *</label>
                  <select {...eventForm.register('type')} className={inputClass}>
                    <option value="">— Choisir —</option>
                    {Object.entries(HR_EVENT_TYPES).map(([key, { label }]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  {eventForm.formState.errors.type && (
                    <p className="text-xs text-red-500 mt-1">Requis</p>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Titre *</label>
                  <input {...eventForm.register('title')} placeholder="Ex : Promotion Lead Developer" className={inputClass} />
                  {eventForm.formState.errors.title && (
                    <p className="text-xs text-red-500 mt-1">Requis</p>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Date *</label>
                  <input {...eventForm.register('eventDate')} type="date" className={inputClass} />
                  {eventForm.formState.errors.eventDate && (
                    <p className="text-xs text-red-500 mt-1">Requis</p>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Description (facultatif)</label>
                  <textarea {...eventForm.register('description')} rows={2} className={inputClass} />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => setAddEventOpen(false)}
                    className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
                    Annuler
                  </button>
                  <button type="submit" disabled={addEventMutation.isPending}
                    className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50">
                    {addEventMutation.isPending ? 'Ajout…' : 'Ajouter'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══ MODAL AJOUTER COMPÉTENCE ══════════════════════════════════════════ */}
      <AnimatePresence>
        {addSkillOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setAddSkillOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <h2 className="font-semibold text-gray-900">Ajouter une compétence</h2>
                <button onClick={() => setAddSkillOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className={labelClass}>Compétence *</label>
                  <select
                    value={newSkillId}
                    onChange={(e) => setNewSkillId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">— Choisir dans le référentiel —</option>
                    {skillRefs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.category ? `[${s.category}] ` : ''}{s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Niveau *</label>
                  <div className="grid grid-cols-4 gap-2">
                    {([1, 2, 3, 4] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setNewSkillLevel(n)}
                        className={cn(
                          'py-2 rounded-lg text-xs font-medium border transition-colors',
                          newSkillLevel === n
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
                        )}
                      >
                        {LEVEL_LABELS[n]?.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => setAddSkillOpen(false)}
                    className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
                    Annuler
                  </button>
                  <button
                    type="button"
                    disabled={!newSkillId || addSkillMutation.isPending}
                    onClick={() => addSkillMutation.mutate()}
                    className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                  >
                    {addSkillMutation.isPending ? 'Ajout…' : 'Ajouter'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══ MODAL NOUVEAU CONTRAT ═════════════════════════════════════════════ */}
      <AnimatePresence>
        {addContractOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
            onClick={(e) => { if (e.target === e.currentTarget) { setAddContractOpen(false); contractForm.reset() } }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
            >
              <div className="flex items-center justify-between p-5 border-b border-gray-100">
                <h2 className="text-base font-semibold text-gray-900">Nouveau contrat / avenant</h2>
                <button onClick={() => { setAddContractOpen(false); contractForm.reset() }} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={contractForm.handleSubmit((data) => createContractMutation.mutate(data))} className="p-5 space-y-4">
                {/* Type de contrat */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1">Type de contrat *</label>
                    <select
                      {...contractForm.register('type')}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                    >
                      <option value="">— Sélectionner —</option>
                      {contractTypes.map((ct) => (
                        <option key={ct.code} value={ct.code}>{ct.label}</option>
                      ))}
                    </select>
                    {contractForm.formState.errors.type && (
                      <p className="text-xs text-red-600 mt-0.5">{contractForm.formState.errors.type.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1">Salaire brut mensuel (€) *</label>
                    <input
                      type="number"
                      {...contractForm.register('grossSalary', { valueAsNumber: true })}
                      placeholder="3500"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {contractForm.formState.errors.grossSalary && (
                      <p className="text-xs text-red-600 mt-0.5">{contractForm.formState.errors.grossSalary.message}</p>
                    )}
                  </div>
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1">Date de début *</label>
                    <input
                      type="date"
                      {...contractForm.register('startDate')}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {contractForm.formState.errors.startDate && (
                      <p className="text-xs text-red-600 mt-0.5">{contractForm.formState.errors.startDate.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1">Date de fin <span className="text-gray-400">(CDD)</span></label>
                    <input
                      type="date"
                      {...contractForm.register('endDate')}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                {/* Trial period */}
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Fin de période d'essai</label>
                  <input
                    type="date"
                    {...contractForm.register('trialPeriodEnd')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* CCN */}
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Convention collective (CCN)</label>
                  <select
                    {...contractForm.register('collectiveAgreement')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  >
                    <option value="">— Sélectionner une CCN —</option>
                    {collectiveAgreements.map((ca) => (
                      <option key={ca.code} value={ca.code}>{ca.label}</option>
                    ))}
                  </select>
                </div>

                {/* Hours & télétravail */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1">Heures / semaine</label>
                    <input
                      type="number"
                      {...contractForm.register('workingHoursPerWeek', { valueAsNumber: true })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1">Jours télétravail / sem.</label>
                    <input
                      type="number"
                      min={0} max={5}
                      {...contractForm.register('telecommutingDays', { valueAsNumber: true })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                {createContractMutation.isError && (
                  <p className="text-sm text-red-600 bg-red-50 p-2 rounded">Erreur lors de la création du contrat.</p>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                  <button type="button" onClick={() => { setAddContractOpen(false); contractForm.reset() }}
                    className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Annuler</button>
                  <button type="submit"
                    disabled={createContractMutation.isPending}
                    className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 flex items-center gap-2">
                    {createContractMutation.isPending && <span className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />}
                    Enregistrer le contrat
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
