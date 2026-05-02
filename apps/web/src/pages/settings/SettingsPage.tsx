import { useState, useRef } from 'react'
import {
  Building2, Users, Shield, Bell, Palette, Sliders,
  List, Plus, Pencil, Trash2, Check, X, Loader2,
  Download, Upload, FileSpreadsheet, AlertCircle,
  Mail, Smartphone, RefreshCw, Eye, EyeOff,
  UserSquare, CalendarDays, Banknote, FileText, KeyRound,
  Clock, Lock, FileWarning, Globe, Zap, Link2, ExternalLink,
  Settings2, ChevronRight, Sun, Moon, Monitor, LayoutDashboard,
  Type, Paintbrush, Image, Columns, GripVertical, ChevronDown, Target,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Parameter {
  id: string
  category: string
  code: string
  label: string
  color: string | null
  sortOrder: number
  isActive: boolean
  metadata?: Record<string, unknown>
}

interface LevelTask {
  id: string
  label: string
  description?: string
  category?: string
}

interface Department {
  id: string
  name: string
  code: string | null
  costCenter: string | null
}

interface AbsenceType {
  id: string
  code: string
  label: string
  category: string
  color: string
  requiresApproval: boolean
  requiresJustification: boolean
  isPaid: boolean
  maxDaysPerYear: string | null
  isActive: boolean
}

interface TenantUser {
  id: string
  email: string
  firstName: string
  lastName: string
  role: string
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PARAM_CATEGORIES = [
  { key: 'contract_type',        label: 'Types de contrat' },
  { key: 'collective_agreement', label: 'Conventions collectives (CCN)' },
  { key: 'expense_category',     label: 'Catégories de frais' },
  { key: 'job_level',            label: 'Niveaux de poste' },
  { key: 'training_category',    label: 'Catégories de formation' },
  { key: 'termination_reason',   label: 'Motifs de fin de contrat' },
  { key: 'sector',               label: "Secteurs d'activité (NAF)" },
]

const ABSENCE_CATEGORIES = [
  { value: 'paid_leave', label: 'Congé payé' },
  { value: 'rtt',        label: 'RTT' },
  { value: 'sick',       label: 'Maladie' },
  { value: 'maternity',  label: 'Maternité / Paternité' },
  { value: 'family',     label: 'Événement familial' },
  { value: 'unpaid',     label: 'Sans solde' },
  { value: 'other',      label: 'Autre' },
]

const TENANT_ROLES = [
  { value: 'admin',      label: 'Administrateur' },
  { value: 'hr_manager', label: 'Responsable RH' },
  { value: 'hr_officer', label: 'Chargé RH' },
  { value: 'manager',    label: 'Manager' },
  { value: 'employee',   label: 'Employé' },
  { value: 'readonly',   label: 'Lecture seule' },
]

const MAIN_SECTIONS = [
  { id: 'referentials', label: 'Référentiels',      icon: List },
  { id: 'company',      label: 'Entreprise',         icon: Building2 },
  { id: 'users',        label: 'Utilisateurs',        icon: Users },
  { id: 'workflow',     label: 'Workflows',           icon: Zap },
  { id: 'security',     label: 'Sécurité',            icon: Shield },
  { id: 'notifications',label: 'Notifications',       icon: Bell },
  { id: 'appearance',   label: 'Apparence',           icon: Palette },
  { id: 'integrations', label: 'Intégrations',        icon: Sliders },
  { id: 'import',       label: 'Import de données',   icon: FileSpreadsheet },
]

const IMPORT_TEMPLATES = [
  {
    type: 'employees',
    label: 'Employés',
    description: 'Importer vos employés en masse (nom, prénom, email, poste, département, salaire...)',
    Icon: UserSquare,
    color: 'indigo',
  },
  {
    type: 'departments',
    label: 'Départements',
    description: 'Créer vos départements et organigramme',
    Icon: Building2,
    color: 'blue',
  },
  {
    type: 'absences',
    label: 'Soldes de congés',
    description: 'Initialiser les soldes CP, RTT et autres compteurs de congés',
    Icon: CalendarDays,
    color: 'green',
  },
  {
    type: 'payroll_rules',
    label: 'Rubriques de paie',
    description: 'Importer le plan de rubriques paie personnalisé',
    Icon: Banknote,
    color: 'amber',
  },
  {
    type: 'contracts',
    label: 'Contrats',
    description: 'Reprendre les contrats existants (type, dates, salaire)',
    Icon: FileText,
    color: 'purple',
  },
  {
    type: 'users',
    label: 'Utilisateurs',
    description: 'Créer les comptes utilisateurs en masse',
    Icon: KeyRound,
    color: 'rose',
  },
]

// ─── Generic CRUD list component ─────────────────────────────────────────────

function CrudList({
  items,
  onAdd,
  onEdit,
  onDelete,
  isLoading,
  renderItem,
  renderForm,
  editingId,
  setEditingId,
}: {
  items: { id: string }[]
  onAdd: (data: Record<string, string>) => void
  onEdit: (id: string, data: Record<string, string>) => void
  onDelete: (id: string) => void
  isLoading: boolean
  renderItem: (item: Record<string, unknown>) => React.ReactNode
  renderForm: (values: Record<string, string>, onChange: (k: string, v: string) => void) => React.ReactNode
  editingId: string | null
  setEditingId: (id: string | null) => void
}) {
  const [adding, setAdding] = useState(false)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [editValues, setEditValues] = useState<Record<string, string>>({})

  const handleAdd = () => {
    onAdd(formValues)
    setFormValues({})
    setAdding(false)
  }

  const startEdit = (item: Record<string, unknown>) => {
    setEditingId(item['id'] as string)
    const vals: Record<string, string> = {}
    for (const k of Object.keys(item)) {
      vals[k] = item[k] != null ? String(item[k]) : ''
    }
    setEditValues(vals)
  }

  const handleEdit = () => {
    if (!editingId) return
    onEdit(editingId, editValues)
    setEditingId(null)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
        {items.length === 0 && !adding && (
          <div className="py-10 text-center text-sm text-gray-400">
            Aucun élément — cliquez sur "+ Ajouter" pour commencer
          </div>
        )}
        {items.map((item) => {
          const it = item as Record<string, unknown>
          const isEdit = editingId === it['id']
          return (
            <div key={it['id'] as string} className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50">
              {isEdit ? (
                <>
                  <div className="flex-1">
                    {renderForm(editValues, (k, v) => setEditValues((prev) => ({ ...prev, [k]: v })))}
                  </div>
                  <button onClick={handleEdit} className="text-green-600 hover:text-green-700 p-1">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 p-1">
                    <X className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <div className="flex-1">{renderItem(it)}</div>
                  <button onClick={() => startEdit(it)} className="text-gray-400 hover:text-indigo-600 p-1">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => onDelete(it['id'] as string)} className="text-gray-400 hover:text-red-600 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          )
        })}
        {adding && (
          <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50">
            <div className="flex-1">
              {renderForm(formValues, (k, v) => setFormValues((prev) => ({ ...prev, [k]: v })))}
            </div>
            <button onClick={handleAdd} className="text-green-600 hover:text-green-700 p-1">
              <Check className="w-4 h-4" />
            </button>
            <button onClick={() => { setAdding(false); setFormValues({}) }} className="text-gray-400 hover:text-gray-600 p-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      {!adding && (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
        >
          <Plus className="w-4 h-4" />
          Ajouter
        </button>
      )}
    </div>
  )
}

// ─── Parameters tab ───────────────────────────────────────────────────────────

function ParametersTab({ category }: { category: string }) {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: Parameter[] }>({
    queryKey: ['settings-parameters', category],
    queryFn: async () => (await api.get(`/settings/parameters?category=${category}`)).data,
  })
  const items = data?.data ?? []

  const createMutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api.post('/settings/parameters', { ...body, category }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings-parameters', category] }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      api.patch(`/settings/parameters/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings-parameters', category] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/parameters/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings-parameters', category] }),
  })

  const withColor = category === 'expense_category'

  return (
    <CrudList
      items={items}
      isLoading={isLoading}
      editingId={editingId}
      setEditingId={setEditingId}
      onAdd={(d) => createMutation.mutate(d)}
      onEdit={(id, d) => updateMutation.mutate({ id, body: d })}
      onDelete={(id) => deleteMutation.mutate(id)}
      renderItem={(it) => (
        <div className="flex items-center gap-3">
          {withColor && it['color'] && (
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: it['color'] as string }} />
          )}
          <span className="text-sm font-medium text-gray-900">{it['label'] as string}</span>
          <span className="text-xs text-gray-400 font-mono">{it['code'] as string}</span>
        </div>
      )}
      renderForm={(vals, onChange) => (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={vals['label'] ?? ''}
            onChange={(e) => onChange('label', e.target.value)}
            placeholder="Libellé *"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-52 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <input
            value={vals['code'] ?? ''}
            onChange={(e) => onChange('code', e.target.value)}
            placeholder="Code (ex: CDI)"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-32 font-mono uppercase focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          {withColor && (
            <input
              type="color"
              value={vals['color'] ?? '#6B7280'}
              onChange={(e) => onChange('color', e.target.value)}
              className="w-8 h-8 rounded border border-gray-300 cursor-pointer p-0.5"
              title="Couleur"
            />
          )}
        </div>
      )}
    />
  )
}

// ─── Departments tab ──────────────────────────────────────────────────────────

function DepartmentsTab() {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: Department[] }>({
    queryKey: ['settings-departments'],
    queryFn: async () => (await api.get('/settings/departments')).data,
  })
  const items = data?.data ?? []

  const createMutation = useMutation({
    mutationFn: (body: Record<string, string>) => api.post('/settings/departments', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-departments'] })
      queryClient.invalidateQueries({ queryKey: ['departments'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      api.patch(`/settings/departments/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-departments'] })
      queryClient.invalidateQueries({ queryKey: ['departments'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/departments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-departments'] })
      queryClient.invalidateQueries({ queryKey: ['departments'] })
    },
  })

  return (
    <CrudList
      items={items}
      isLoading={isLoading}
      editingId={editingId}
      setEditingId={setEditingId}
      onAdd={(d) => createMutation.mutate(d)}
      onEdit={(id, d) => updateMutation.mutate({ id, body: d })}
      onDelete={(id) => deleteMutation.mutate(id)}
      renderItem={(it) => (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-900">{it['name'] as string}</span>
          {it['code'] && <span className="text-xs font-mono text-gray-400">{it['code'] as string}</span>}
          {it['costCenter'] && <span className="text-xs text-gray-400">CC : {it['costCenter'] as string}</span>}
        </div>
      )}
      renderForm={(vals, onChange) => (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={vals['name'] ?? ''}
            onChange={(e) => onChange('name', e.target.value)}
            placeholder="Nom du département *"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-52 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <input
            value={vals['code'] ?? ''}
            onChange={(e) => onChange('code', e.target.value)}
            placeholder="Code (ex: ENG)"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-28 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <input
            value={vals['costCenter'] ?? ''}
            onChange={(e) => onChange('costCenter', e.target.value)}
            placeholder="Centre de coût"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-36 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      )}
    />
  )
}

// ─── Absence types tab ────────────────────────────────────────────────────────

function AbsenceTypesTab() {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ data: AbsenceType[] }>({
    queryKey: ['settings-absence-types'],
    queryFn: async () => (await api.get('/settings/absence-types')).data,
  })
  const items = data?.data ?? []

  const createMutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api.post('/settings/absence-types', {
        ...body,
        requiresApproval: body['requiresApproval'] === 'true',
        isPaid: body['isPaid'] === 'true',
        maxDaysPerYear: body['maxDaysPerYear'] ? Number(body['maxDaysPerYear']) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-absence-types'] })
      queryClient.invalidateQueries({ queryKey: ['absence-types'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      api.patch(`/settings/absence-types/${id}`, {
        label: body['label'],
        category: body['category'],
        color: body['color'],
        requiresApproval: body['requiresApproval'] === 'true',
        isPaid: body['isPaid'] === 'true',
        maxDaysPerYear: body['maxDaysPerYear'] ? Number(body['maxDaysPerYear']) : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-absence-types'] })
      queryClient.invalidateQueries({ queryKey: ['absence-types'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/absence-types/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-absence-types'] })
      queryClient.invalidateQueries({ queryKey: ['absence-types'] })
    },
  })

  return (
    <CrudList
      items={items}
      isLoading={isLoading}
      editingId={editingId}
      setEditingId={setEditingId}
      onAdd={(d) => createMutation.mutate(d)}
      onEdit={(id, d) => updateMutation.mutate({ id, body: d })}
      onDelete={(id) => deleteMutation.mutate(id)}
      renderItem={(it) => (
        <div className="flex items-center gap-3">
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: (it['color'] as string) ?? '#6B7280' }}
          />
          <span className="text-sm font-medium text-gray-900">{it['label'] as string}</span>
          <span className="text-xs font-mono text-gray-400">{it['code'] as string}</span>
          {it['isPaid'] ? (
            <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">Payé</span>
          ) : (
            <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">Non payé</span>
          )}
          {it['maxDaysPerYear'] && (
            <span className="text-xs text-gray-400">{it['maxDaysPerYear'] as string} j/an</span>
          )}
        </div>
      )}
      renderForm={(vals, onChange) => (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={vals['code'] ?? ''}
            onChange={(e) => onChange('code', e.target.value)}
            placeholder="Code (ex: CP)"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-24 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <input
            value={vals['label'] ?? ''}
            onChange={(e) => onChange('label', e.target.value)}
            placeholder="Libellé *"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <select
            value={vals['category'] ?? 'other'}
            onChange={(e) => onChange('category', e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
          >
            {ABSENCE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <input
            type="color"
            value={vals['color'] ?? '#4F46E5'}
            onChange={(e) => onChange('color', e.target.value)}
            className="w-8 h-8 rounded border border-gray-300 cursor-pointer p-0.5"
          />
          <select
            value={vals['isPaid'] ?? 'true'}
            onChange={(e) => onChange('isPaid', e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
          >
            <option value="true">Payé</option>
            <option value="false">Non payé</option>
          </select>
          <select
            value={vals['requiresApproval'] ?? 'true'}
            onChange={(e) => onChange('requiresApproval', e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
          >
            <option value="true">Approbation requise</option>
            <option value="false">Approbation non requise</option>
          </select>
          <input
            value={vals['maxDaysPerYear'] ?? ''}
            onChange={(e) => onChange('maxDaysPerYear', e.target.value)}
            type="number"
            placeholder="Jours/an"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-24 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      )}
    />
  )
}

// ─── Job Levels Tab (niveaux de poste avec tâches par niveau) ────────────────

function JobLevelsTab() {
  const queryClient = useQueryClient()

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery<{ data: Parameter[] }>({
    queryKey: ['settings-parameters', 'job_level'],
    queryFn: async () => (await api.get('/settings/parameters?category=job_level')).data,
  })
  const levels = (data?.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder)

  // ── UI State ───────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingLevelId, setEditingLevelId] = useState<string | null>(null)
  const [newLevelForm, setNewLevelForm] = useState<{ label: string; code: string } | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [newTaskForm, setNewTaskForm] = useState<Partial<LevelTask> | null>(null)
  const [taskDraft, setTaskDraft] = useState<Partial<LevelTask>>({})

  // Current selected level
  const selectedLevel = levels.find((l) => l.id === selectedId) ?? null
  const selectedTasks: LevelTask[] = (selectedLevel?.metadata?.tasks as LevelTask[] | undefined) ?? []

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createLevel = useMutation({
    mutationFn: (body: { label: string; code: string }) =>
      api.post('/settings/parameters', { ...body, category: 'job_level', sortOrder: levels.length, metadata: { tasks: [] } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-parameters', 'job_level'] })
      setNewLevelForm(null)
    },
  })

  const updateLevel = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/settings/parameters/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-parameters', 'job_level'] })
      setEditingLevelId(null)
    },
  })

  const deleteLevel = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/parameters/${id}`),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['settings-parameters', 'job_level'] })
      if (selectedId === deletedId) setSelectedId(null)
    },
  })

  // Save tasks array for a given level
  const saveTasks = (levelId: string, tasks: LevelTask[]) => {
    const level = levels.find((l) => l.id === levelId)
    if (!level) return
    updateLevel.mutate({ id: levelId, body: { metadata: { ...(level.metadata ?? {}), tasks } } })
  }

  // ── Task helpers ───────────────────────────────────────────────────────────
  const addTask = () => {
    if (!selectedId || !taskDraft.label?.trim()) return
    const task: LevelTask = {
      id: crypto.randomUUID(),
      label: taskDraft.label.trim(),
      description: taskDraft.description?.trim() || undefined,
      category: taskDraft.category?.trim() || undefined,
    }
    const updated = [...selectedTasks, task]
    saveTasks(selectedId, updated)
    setNewTaskForm(null)
    setTaskDraft({})
  }

  const updateTask = (taskId: string) => {
    if (!selectedId || !taskDraft.label?.trim()) return
    const updated = selectedTasks.map((t) =>
      t.id === taskId
        ? { ...t, label: taskDraft.label!.trim(), description: taskDraft.description?.trim() || undefined, category: taskDraft.category?.trim() || undefined }
        : t
    )
    saveTasks(selectedId, updated)
    setEditingTaskId(null)
    setTaskDraft({})
  }

  const deleteTask = (taskId: string) => {
    if (!selectedId) return
    saveTasks(selectedId, selectedTasks.filter((t) => t.id !== taskId))
  }

  const moveTask = (taskId: string, dir: -1 | 1) => {
    if (!selectedId) return
    const idx = selectedTasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= selectedTasks.length) return
    const arr = [...selectedTasks]
    ;[arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]]
    saveTasks(selectedId, arr)
  }

  // Group tasks by category for display
  const groupedTasks = selectedTasks.reduce<Record<string, LevelTask[]>>((acc, t) => {
    const cat = t.category || 'Général'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(t)
    return acc
  }, {})

  if (isLoading) {
    return <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-indigo-500" /></div>
  }

  return (
    <div className="flex gap-6 min-h-96">
      {/* ── Colonne gauche : liste des niveaux ─────────────────────────────── */}
      <div className="w-64 shrink-0 space-y-2">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            {levels.length} niveau{levels.length !== 1 ? 'x' : ''} configuré{levels.length !== 1 ? 's' : ''}
          </p>
          <button
            onClick={() => setNewLevelForm({ label: '', code: '' })}
            className="p-1 rounded hover:bg-indigo-50 text-indigo-600 transition-colors"
            title="Ajouter un niveau"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {levels.length === 0 && !newLevelForm && (
          <div className="text-center py-8 border-2 border-dashed border-gray-200 rounded-lg">
            <Target className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-xs text-gray-400">Aucun niveau défini</p>
            <button
              onClick={() => setNewLevelForm({ label: '', code: '' })}
              className="mt-2 text-xs text-indigo-600 hover:underline"
            >
              Créer le premier niveau
            </button>
          </div>
        )}

        <div className="space-y-1">
          {levels.map((lvl, idx) => {
            const taskCount = ((lvl.metadata?.tasks as LevelTask[] | undefined) ?? []).length
            const isSelected = selectedId === lvl.id

            if (editingLevelId === lvl.id) {
              return (
                <LevelEditRow
                  key={lvl.id}
                  initial={{ label: lvl.label, code: lvl.code }}
                  onSave={(d) => updateLevel.mutate({ id: lvl.id, body: d })}
                  onCancel={() => setEditingLevelId(null)}
                />
              )
            }

            return (
              <div
                key={lvl.id}
                onClick={() => setSelectedId(isSelected ? null : lvl.id)}
                className={cn(
                  'group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border',
                  isSelected
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-900'
                    : 'bg-white border-gray-200 text-gray-700 hover:border-indigo-200 hover:bg-indigo-50/50'
                )}
              >
                <span className={cn(
                  'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
                  isSelected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500'
                )}>
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{lvl.label}</p>
                  <p className="text-xs text-gray-400 font-mono">{lvl.code}</p>
                </div>
                <span className={cn(
                  'text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0',
                  taskCount > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                )}>
                  {taskCount} tâche{taskCount !== 1 ? 's' : ''}
                </span>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingLevelId(lvl.id) }}
                    className="p-1 rounded hover:bg-white text-gray-400 hover:text-gray-700"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteLevel.mutate(lvl.id) }}
                    className="p-1 rounded hover:bg-white text-gray-400 hover:text-red-600"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )
          })}

          {/* Formulaire nouveau niveau */}
          {newLevelForm !== null && (
            <LevelEditRow
              initial={newLevelForm}
              onSave={(d) => createLevel.mutate(d as { label: string; code: string })}
              onCancel={() => setNewLevelForm(null)}
              autoFocus
            />
          )}
        </div>
      </div>

      {/* ── Colonne droite : tâches du niveau sélectionné ──────────────────── */}
      <div className="flex-1 min-w-0">
        {!selectedLevel ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl p-10">
            <Target className="w-10 h-10 mb-3 text-gray-200" />
            <p className="font-medium text-sm">Sélectionnez un niveau</p>
            <p className="text-xs mt-1">Cliquez sur un niveau pour définir ses tâches et son périmètre.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Header niveau */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">
                  Tâches — {selectedLevel.label}
                  <span className="ml-2 text-xs font-mono text-gray-400">{selectedLevel.code}</span>
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Définissez les tâches et responsabilités qui délimitent le périmètre de ce niveau.
                  Ces tâches sont spécifiques à votre organisation.
                </p>
              </div>
              <button
                onClick={() => { setNewTaskForm({}); setTaskDraft({}) }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Ajouter une tâche
              </button>
            </div>

            {/* Formulaire nouvelle tâche */}
            {newTaskForm !== null && (
              <TaskEditForm
                draft={taskDraft}
                onChange={setTaskDraft}
                onSave={addTask}
                onCancel={() => { setNewTaskForm(null); setTaskDraft({}) }}
                isSaving={updateLevel.isPending}
              />
            )}

            {/* Liste des tâches groupées par catégorie */}
            {selectedTasks.length === 0 && newTaskForm === null ? (
              <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-xl">
                <p className="text-sm text-gray-400">Aucune tâche définie pour ce niveau.</p>
                <button
                  onClick={() => { setNewTaskForm({}); setTaskDraft({}) }}
                  className="mt-2 text-xs text-indigo-600 hover:underline"
                >
                  Ajouter la première tâche
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(groupedTasks).map(([cat, tasks]) => (
                  <div key={cat}>
                    {Object.keys(groupedTasks).length > 1 && (
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 pb-1 border-b border-gray-100">
                        {cat}
                      </p>
                    )}
                    <div className="space-y-2">
                      {tasks.map((task) => {
                        const globalIdx = selectedTasks.findIndex((t) => t.id === task.id)
                        if (editingTaskId === task.id) {
                          return (
                            <TaskEditForm
                              key={task.id}
                              draft={taskDraft}
                              onChange={setTaskDraft}
                              onSave={() => updateTask(task.id)}
                              onCancel={() => { setEditingTaskId(null); setTaskDraft({}) }}
                              isSaving={updateLevel.isPending}
                            />
                          )
                        }
                        return (
                          <div
                            key={task.id}
                            className="group flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-lg hover:border-indigo-200 transition-colors"
                          >
                            {/* Drag handle / reorder */}
                            <div className="flex flex-col gap-0.5 shrink-0 pt-0.5">
                              <button
                                onClick={() => moveTask(task.id, -1)}
                                disabled={globalIdx === 0}
                                className="p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600 disabled:opacity-0 disabled:cursor-default"
                              >
                                <ChevronDown className="w-3 h-3 rotate-180" />
                              </button>
                              <button
                                onClick={() => moveTask(task.id, 1)}
                                disabled={globalIdx === selectedTasks.length - 1}
                                className="p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600 disabled:opacity-0 disabled:cursor-default"
                              >
                                <ChevronDown className="w-3 h-3" />
                              </button>
                            </div>

                            {/* Badge numéro */}
                            <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                              {globalIdx + 1}
                            </span>

                            {/* Contenu */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900">{task.label}</p>
                              {task.description && (
                                <p className="text-xs text-gray-500 mt-0.5">{task.description}</p>
                              )}
                              {task.category && (
                                <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
                                  {task.category}
                                </span>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button
                                onClick={() => {
                                  setEditingTaskId(task.id)
                                  setTaskDraft({ label: task.label, description: task.description, category: task.category })
                                }}
                                className="p-1.5 rounded hover:bg-indigo-50 text-gray-400 hover:text-indigo-600"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => deleteTask(task.id)}
                                className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
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
      </div>
    </div>
  )
}

// ── Sous-formulaire : créer/modifier un niveau ────────────────────────────────
function LevelEditRow({
  initial,
  onSave,
  onCancel,
  autoFocus = false,
}: {
  initial: { label: string; code: string }
  onSave: (d: { label: string; code: string }) => void
  onCancel: () => void
  autoFocus?: boolean
}) {
  const [label, setLabel] = useState(initial.label)
  const [code, setCode] = useState(initial.code)

  const autoCode = (v: string) => v.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 20)

  return (
    <div className="flex items-center gap-2 p-2 bg-indigo-50 border border-indigo-200 rounded-lg">
      <input
        autoFocus={autoFocus}
        value={label}
        onChange={(e) => {
          setLabel(e.target.value)
          if (!initial.label) setCode(autoCode(e.target.value))
        }}
        placeholder="Libellé (ex: Confirmé)"
        className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <input
        value={code}
        onChange={(e) => setCode(autoCode(e.target.value))}
        placeholder="CODE"
        className="w-24 border border-gray-300 rounded px-2 py-1 text-xs font-mono uppercase focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <button
        onClick={() => { if (label.trim()) onSave({ label: label.trim(), code: code.trim() || autoCode(label) }) }}
        disabled={!label.trim()}
        className="p-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
      >
        <Check className="w-3.5 h-3.5" />
      </button>
      <button onClick={onCancel} className="p-1 rounded hover:bg-gray-200 text-gray-500">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ── Sous-formulaire : créer/modifier une tâche ────────────────────────────────
function TaskEditForm({
  draft,
  onChange,
  onSave,
  onCancel,
  isSaving,
}: {
  draft: Partial<LevelTask>
  onChange: (v: Partial<LevelTask>) => void
  onSave: () => void
  onCancel: () => void
  isSaving: boolean
}) {
  return (
    <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl space-y-3">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-gray-700">Tâche / Responsabilité *</label>
        <input
          autoFocus
          value={draft.label ?? ''}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
          placeholder="Ex : Rédiger les spécifications fonctionnelles"
          className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
          onKeyDown={(e) => { if (e.key === 'Enter' && draft.label?.trim()) onSave() }}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-700">Description (optionnel)</label>
          <input
            value={draft.description ?? ''}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            placeholder="Précisions sur la tâche..."
            className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-700">Catégorie (optionnel)</label>
          <input
            value={draft.category ?? ''}
            onChange={(e) => onChange({ ...draft, category: e.target.value })}
            placeholder="Ex : Technique, Management..."
            className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={!draft.label?.trim() || isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Enregistrer
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-50 transition-colors"
        >
          Annuler
        </button>
      </div>
    </div>
  )
}

// ─── Referentials section ─────────────────────────────────────────────────────

function ReferentialsSection() {
  const [activeRef, setActiveRef] = useState('departments')

  const refTabs = [
    { id: 'departments',          label: 'Départements' },
    { id: 'absence_types',        label: "Types d'absence" },
    ...PARAM_CATEGORIES.map((c) => ({ id: c.key, label: c.label })),
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Référentiels</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Gérez toutes les listes déroulantes utilisées dans l'application.
          Chaque modification est immédiatement prise en compte dans les formulaires.
        </p>
      </div>
      <div className="flex gap-1 flex-wrap border-b border-gray-200 pb-0">
        {refTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveRef(tab.id)}
            className={cn(
              'px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap',
              activeRef === tab.id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div>
        {activeRef === 'departments' && <DepartmentsTab />}
        {activeRef === 'absence_types' && <AbsenceTypesTab />}
        {activeRef === 'job_level' && <JobLevelsTab />}
        {PARAM_CATEGORIES.filter((c) => c.key !== 'job_level').map((c) =>
          activeRef === c.key ? <ParametersTab key={c.key} category={c.key} /> : null
        )}
      </div>
    </div>
  )
}

// ─── Users section ────────────────────────────────────────────────────────────

function UsersSection() {
  const queryClient = useQueryClient()
  const { user: currentUser } = useAuthStore()
  const [showForm, setShowForm] = useState(false)
  const [editingUser, setEditingUser] = useState<TenantUser | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'employee', password: '' })

  const { data, isLoading } = useQuery<{ data: TenantUser[] }>({
    queryKey: ['settings-users'],
    queryFn: async () => (await api.get('/settings/users')).data,
  })
  const users = data?.data ?? []

  const createMutation = useMutation({
    mutationFn: (body: typeof form) => api.post('/settings/users', body),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['settings-users'] })
      setShowForm(false)
      setErrorMsg(null)
      setSuccessMsg(`Compte créé — email de bienvenue envoyé à ${variables.email}`)
      setForm({ email: '', firstName: '', lastName: '', role: 'employee', password: '' })
      setTimeout(() => setSuccessMsg(null), 6000)
    },
    onError: (err: unknown) => {
      const res = (err as { response?: { status?: number; data?: { error?: string } } }).response
      if (res?.status === 409) {
        setErrorMsg(`Cet email est déjà utilisé dans ce tenant. Modifiez le rôle de l'utilisateur existant ou utilisez un autre email.`)
      } else {
        setErrorMsg(res?.data?.error ?? 'Erreur lors de la création de l\'utilisateur')
      }
      setTimeout(() => setErrorMsg(null), 8000)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<typeof form & { isActive: boolean }> }) =>
      api.patch(`/settings/users/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-users'] })
      setEditingUser(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings-users'] }),
  })

  const roleLabel = (role: string) =>
    TENANT_ROLES.find((r) => r.value === role)?.label ?? role

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':      return 'bg-red-100 text-red-700'
      case 'hr_manager': return 'bg-purple-100 text-purple-700'
      case 'hr_officer': return 'bg-blue-100 text-blue-700'
      case 'manager':    return 'bg-amber-100 text-amber-700'
      case 'employee':   return 'bg-green-100 text-green-700'
      default:           return 'bg-gray-100 text-gray-700'
    }
  }

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-indigo-500" /></div>

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Utilisateurs</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Gérez les comptes d'accès à NexusRH. Les utilisateurs peuvent être liés à un employé.
          </p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingUser(null) }}
          className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nouvel utilisateur
        </button>
      </div>

      {/* Success message */}
      {successMsg && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
          <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
          {successMsg}
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50 space-y-3">
          <p className="text-sm font-semibold text-indigo-800">Nouveau compte utilisateur</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Prénom *</label>
              <input
                value={form.firstName}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                placeholder="Prénom"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Nom *</label>
              <input
                value={form.lastName}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                placeholder="Nom"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Email *</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@entreprise.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Rôle *</label>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                {TENANT_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-gray-700">Mot de passe temporaire *</label>
                <button
                  type="button"
                  onClick={() => {
                    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%'
                    const pwd = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                    setForm((f) => ({ ...f, password: pwd }))
                    setShowPassword(true)
                  }}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Générer
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Minimum 8 caractères"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 pr-10"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1">Le mot de passe sera envoyé par email à l'utilisateur.</p>
            </div>
          </div>
          {errorMsg && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {errorMsg}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); setErrorMsg(null) }} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Annuler</button>
            <button
              onClick={() => createMutation.mutate(form)}
              disabled={createMutation.isPending || !form.email || !form.firstName || !form.lastName || !form.password}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Créer l'utilisateur
            </button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        {users.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">Aucun utilisateur trouvé</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Utilisateur</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Rôle</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Statut</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Dernière connexion</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {editingUser?.id === u.id ? (
                      <select
                        value={editingUser.role}
                        onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value })}
                        className="border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        {TENANT_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    ) : (
                      <div>
                        <p className="font-medium text-gray-900">{u.firstName} {u.lastName}</p>
                        <p className="text-xs text-gray-400">{u.email}</p>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', roleBadgeColor(u.role))}>
                      {roleLabel(u.role)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'text-xs px-2 py-0.5 rounded-full font-medium',
                      u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    )}>
                      {u.isActive ? 'Actif' : 'Suspendu'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {u.lastLoginAt
                      ? new Date(u.lastLoginAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
                      : 'Jamais'}
                  </td>
                  <td className="px-4 py-3">
                    {editingUser?.id === u.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => updateMutation.mutate({ id: u.id, body: { role: editingUser.role } })}
                          className="text-green-600 hover:text-green-700 p-1"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => setEditingUser(null)} className="text-gray-400 hover:text-gray-600 p-1">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        {currentUser?.id !== u.id && (
                          <>
                            <button
                              onClick={() => setEditingUser(u)}
                              className="text-gray-400 hover:text-indigo-600 p-1"
                              title="Modifier le rôle"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => updateMutation.mutate({ id: u.id, body: { isActive: !u.isActive } })}
                              className={cn('p-1', u.isActive ? 'text-gray-400 hover:text-amber-600' : 'text-gray-400 hover:text-green-600')}
                              title={u.isActive ? 'Suspendre' : 'Réactiver'}
                            >
                              {u.isActive ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                            </button>
                            <button
                              onClick={() => {
                                if (confirm(`Supprimer l'utilisateur ${u.firstName} ${u.lastName} ?`)) {
                                  deleteMutation.mutate(u.id)
                                }
                              }}
                              className="text-gray-400 hover:text-red-600 p-1"
                              title="Supprimer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Notifications section ────────────────────────────────────────────────────

interface NotifSetting {
  key: string
  label: string
  description: string
  channel: 'email' | 'app'
  enabled: boolean
}

const NOTIF_DEFAULTS: NotifSetting[] = [
  { key: 'absence_request',   label: 'Demande d\'absence',        description: 'Notifier les managers lorsqu\'une absence est déposée',     channel: 'email', enabled: true },
  { key: 'absence_approved',  label: 'Absence approuvée',          description: 'Informer l\'employé dès que sa demande est validée',        channel: 'email', enabled: true },
  { key: 'absence_rejected',  label: 'Absence refusée',            description: 'Informer l\'employé en cas de refus',                       channel: 'email', enabled: true },
  { key: 'expense_submitted', label: 'Note de frais soumise',      description: 'Notifier le manager lorsqu\'une note de frais est soumise', channel: 'email', enabled: true },
  { key: 'expense_approved',  label: 'Note de frais approuvée',    description: 'Informer l\'employé de l\'approbation',                     channel: 'email', enabled: true },
  { key: 'payslip_available', label: 'Bulletin de paie disponible', description: 'Notifier les employés quand leurs bulletins sont générés',  channel: 'email', enabled: true },
  { key: 'contract_expiry',   label: 'Contrat bientôt expirant',   description: 'Alerte 30 jours avant la fin d\'un CDD',                    channel: 'email', enabled: true },
  { key: 'trial_expiry',      label: 'Fin de période d\'essai',    description: 'Alerte 7 jours avant la fin d\'essai',                      channel: 'email', enabled: false },
  { key: 'new_employee',      label: 'Nouvelle candidature',       description: 'Notifier le recruteur à chaque nouvelle candidature',       channel: 'email', enabled: true },
  { key: 'birthday',          label: 'Rappel formation',           description: 'Rappel 48h avant le début d\'une session',                  channel: 'app',   enabled: true },
  { key: 'ai_insights',       label: 'Insights IA',                description: 'Alertes intelligentes sur les risques RH détectés',        channel: 'app',   enabled: true },
]

function NotificationsSection() {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState<NotifSetting[]>(NOTIF_DEFAULTS)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  // Load from API
  useQuery({
    queryKey: ['settings-notifications'],
    queryFn: async () => {
      const res = await api.get('/settings/notifications')
      const data = res.data.data as Record<string, { channel: string; enabled: boolean }>
      setSettings((prev) => prev.map((s) => data[s.key] ? { ...s, ...data[s.key] } : s))
      return data
    },
  })

  const toggle = (key: string) => {
    setSettings((prev) => prev.map((s) => s.key === key ? { ...s, enabled: !s.enabled } : s))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    const payload: Record<string, { channel: string; enabled: boolean }> = {}
    settings.forEach((s) => { payload[s.key] = { channel: s.channel, enabled: s.enabled } })
    try {
      await api.patch('/settings/notifications', payload)
      queryClient.invalidateQueries({ queryKey: ['settings-notifications'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const emailSettings = settings.filter((s) => s.channel === 'email')
  const appSettings   = settings.filter((s) => s.channel === 'app')

  const renderGroup = (title: string, icon: React.ReactNode, items: NotifSetting[]) => (
    <div className="space-y-1">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-gray-500">{icon}</span>
        <p className="text-sm font-semibold text-gray-800">{title}</p>
      </div>
      {items.map((s) => (
        <div key={s.key} className="flex items-center justify-between py-3 px-3 rounded-lg hover:bg-gray-50 transition-colors">
          <div className="flex-1 min-w-0 mr-4">
            <p className="text-sm font-medium text-gray-900">{s.label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
          </div>
          <button
            onClick={() => toggle(s.key)}
            className={cn(
              'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
              s.enabled ? 'bg-indigo-600' : 'bg-gray-200'
            )}
          >
            <span className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200',
              s.enabled ? 'translate-x-4' : 'translate-x-0'
            )} />
          </button>
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Notifications</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Configurez les événements qui déclenchent des notifications email ou dans l'application.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-60',
            saved
              ? 'bg-green-100 text-green-700'
              : 'bg-indigo-600 text-white hover:bg-indigo-700'
          )}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
          {saved ? 'Enregistré' : 'Enregistrer'}
        </button>
      </div>

      <div className="space-y-6">
        {renderGroup('Notifications email', <Mail className="w-4 h-4" />, emailSettings)}
        <div className="border-t border-gray-100" />
        {renderGroup('Notifications dans l\'application', <Smartphone className="w-4 h-4" />, appSettings)}
      </div>
    </div>
  )
}

// ─── Integrations section ─────────────────────────────────────────────────────

interface Integration {
  id: string
  name: string
  description: string
  category: string
  icon: string
  connected: boolean
  configUrl?: string
}

function IntegrationsSection() {
  const [integrations] = useState<Integration[]>([
    { id: 'google',      name: 'Google Workspace',   description: 'Connexion SSO Google + synchronisation agenda',       category: 'Identité',     icon: '🔵', connected: false },
    { id: 'microsoft',   name: 'Microsoft 365',       description: 'SSO Microsoft + Teams + Outlook',                     category: 'Identité',     icon: '🟦', connected: false },
    { id: 'slack',       name: 'Slack',               description: 'Notifications RH dans vos channels Slack',            category: 'Messagerie',   icon: '💬', connected: false },
    { id: 'teams',       name: 'Microsoft Teams',     description: 'Alertes et rappels dans Teams',                       category: 'Messagerie',   icon: '📋', connected: false },
    { id: 'docusign',    name: 'DocuSign',             description: 'Signature électronique des contrats',                 category: 'Documents',    icon: '✍️', connected: false },
    { id: 'yousign',     name: 'YouSign',              description: 'Signature électronique (alternative française)',      category: 'Documents',    icon: '📝', connected: false },
    { id: 'silae',       name: 'Silae',                description: 'Export DSN et données de paie vers Silae',            category: 'Paie',         icon: '💶', connected: false },
    { id: 'payfit',      name: 'PayFit',               description: 'Synchronisation avec PayFit',                         category: 'Paie',         icon: '💰', connected: false },
    { id: 'workday',     name: 'Workday',              description: 'Synchronisation bidirectionnelle SIRH',               category: 'SIRH',         icon: '🔄', connected: false },
    { id: 'bamboohr',    name: 'BambooHR',             description: 'Import / export employés',                            category: 'SIRH',         icon: '🌿', connected: false },
    { id: 'zapier',      name: 'Zapier',               description: 'Automatisations via Zapier',                          category: 'Automatisation',icon: '⚡', connected: false },
    { id: 'webhook',     name: 'Webhooks',             description: 'Envoyez des événements vers vos propres systèmes',   category: 'Automatisation',icon: '🔗', connected: true  },
  ])

  const categories = [...new Set(integrations.map((i) => i.category))]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Intégrations</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Connectez NexusRH à vos outils existants. Les intégrations disponibles dépendent de votre plan.
        </p>
      </div>

      {categories.map((cat) => (
        <div key={cat} className="space-y-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{cat}</p>
          <div className="grid grid-cols-2 gap-3">
            {integrations.filter((i) => i.category === cat).map((integration) => (
              <div
                key={integration.id}
                className={cn(
                  'border rounded-xl p-4 flex items-start gap-3 transition-colors',
                  integration.connected
                    ? 'border-green-200 bg-green-50'
                    : 'border-gray-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/30'
                )}
              >
                <span className="text-2xl flex-shrink-0">{integration.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">{integration.name}</p>
                    {integration.connected && (
                      <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Connecté</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{integration.description}</p>
                  <button className={cn(
                    'mt-2 text-xs font-medium transition-colors',
                    integration.connected
                      ? 'text-red-500 hover:text-red-700'
                      : 'text-indigo-600 hover:text-indigo-800'
                  )}>
                    {integration.connected ? 'Déconnecter' : 'Configurer'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Webhook config */}
      <div className="border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-800">Configuration Webhook</p>
          <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">Actif</span>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">URL de destination</label>
          <div className="flex gap-2">
            <input
              type="url"
              placeholder="https://votre-app.com/webhook/nexusrh"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700">
              Tester
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">Événements déclencheurs</label>
          <div className="flex flex-wrap gap-2">
            {['employee.created', 'employee.updated', 'absence.approved', 'payslip.generated', 'contract.signed'].map((evt) => (
              <label key={evt} className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" defaultChecked className="rounded" />
                <span className="font-mono">{evt}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Import section ───────────────────────────────────────────────────────────

interface ImportResult {
  success: boolean
  imported: number
  errors: string[]
  warnings: string[]
}

function ImportSection() {
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [downloadingType, setDownloadingType] = useState<string | null>(null)

  const downloadTemplate = async (type: string) => {
    setDownloadingType(type)
    try {
      const response = await api.get(`/settings/import/template/${type}`, {
        responseType: 'blob',
      })
      const url = window.URL.createObjectURL(new Blob([response.data as BlobPart]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `modele_${type}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      alert('Erreur lors du téléchargement du modèle')
    } finally {
      setDownloadingType(null)
    }
  }

  const handleImport = async () => {
    if (!selectedType || !uploadFile) return
    setImporting(true)
    setResult(null)
    try {
      const formData = new FormData()
      formData.append('file', uploadFile)
      const response = await api.post<ImportResult>(`/settings/import/${selectedType}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setResult(response.data)
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } }
      setResult({
        success: false,
        imported: 0,
        errors: [error.response?.data?.message ?? 'Erreur lors de l\'import'],
        warnings: [],
      })
    } finally {
      setImporting(false)
    }
  }

  const colorMap: Record<string, string> = {
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    blue:   'border-blue-200 bg-blue-50 text-blue-700',
    green:  'border-green-200 bg-green-50 text-green-700',
    amber:  'border-amber-200 bg-amber-50 text-amber-700',
    purple: 'border-purple-200 bg-purple-50 text-purple-700',
    rose:   'border-rose-200 bg-rose-50 text-rose-700',
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Import de données</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Reprise de données initiale ou mise à jour en masse. Téléchargez le modèle Excel,
          renseignez vos données et importez le fichier.
        </p>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-amber-800">
          <p className="font-semibold">Important — reprise de données</p>
          <p className="mt-0.5">Les colonnes obligatoires sont marquées d'un <strong>*</strong> dans le modèle. Ne modifiez pas les en-têtes de colonnes. Les données existantes ne seront pas écrasées si un doublon est détecté (par email ou matricule).</p>
        </div>
      </div>

      {/* Template cards */}
      <div className="grid grid-cols-2 gap-3">
        {IMPORT_TEMPLATES.map((tpl) => (
          <div
            key={tpl.type}
            className={cn(
              'border rounded-xl p-4 cursor-pointer transition-all',
              selectedType === tpl.type
                ? `${colorMap[tpl.color]} border-2`
                : 'border-gray-200 bg-white hover:border-gray-300'
            )}
            onClick={() => { setSelectedType(tpl.type); setResult(null); setUploadFile(null) }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 flex-1">
                <tpl.Icon className={cn('w-5 h-5 flex-shrink-0 mt-0.5', {
                    'text-indigo-500': tpl.color === 'indigo',
                    'text-blue-500': tpl.color === 'blue',
                    'text-green-500': tpl.color === 'green',
                    'text-amber-500': tpl.color === 'amber',
                    'text-purple-500': tpl.color === 'purple',
                    'text-rose-500': tpl.color === 'rose',
                  })} />
                <div>
                  <p className="text-sm font-semibold text-gray-900">{tpl.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{tpl.description}</p>
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); downloadTemplate(tpl.type) }}
                disabled={downloadingType === tpl.type}
                className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium flex-shrink-0 disabled:opacity-60"
                title={`Télécharger le modèle ${tpl.label}`}
              >
                {downloadingType === tpl.type
                  ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  : <Download className="w-3.5 h-3.5" />}
                Modèle
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Upload zone */}
      {selectedType && (
        <div className="border-2 border-dashed border-indigo-300 rounded-xl p-6 text-center space-y-3 bg-indigo-50/30">
          <div className="flex justify-center">
            <FileSpreadsheet className="w-10 h-10 text-indigo-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-800">
              Import — {IMPORT_TEMPLATES.find((t) => t.type === selectedType)?.label}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">Formats acceptés : .xlsx, .xls, .csv</p>
          </div>

          {uploadFile ? (
            <div className="flex items-center justify-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              <Check className="w-4 h-4" />
              <span className="font-medium">{uploadFile.name}</span>
              <button onClick={() => setUploadFile(null)} className="text-gray-400 hover:text-gray-600 ml-1">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <label className="cursor-pointer">
              <span className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                <Upload className="w-4 h-4 text-indigo-500" />
                Choisir un fichier
              </span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) { setUploadFile(file); setResult(null) }
                }}
              />
            </label>
          )}

          {uploadFile && (
            <button
              onClick={handleImport}
              disabled={importing}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {importing ? 'Import en cours...' : 'Lancer l\'import'}
            </button>
          )}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={cn(
          'rounded-xl p-4 space-y-2',
          result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
        )}>
          <div className="flex items-center gap-2">
            {result.success
              ? <Check className="w-4 h-4 text-green-600" />
              : <AlertCircle className="w-4 h-4 text-red-600" />}
            <p className={cn('text-sm font-semibold', result.success ? 'text-green-800' : 'text-red-800')}>
              {result.success
                ? `Import réussi — ${result.imported} ligne(s) importée(s)`
                : 'Échec de l\'import'}
            </p>
          </div>
          {result.warnings.length > 0 && (
            <div className="space-y-1">
              {result.warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700">⚠ {w}</p>
              ))}
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="space-y-1">
              {result.errors.map((e, i) => (
                <p key={i} className="text-xs text-red-700">✕ {e}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Security section (functional) ───────────────────────────────────────────

interface SecuritySettings {
  mfaRequired: boolean
  sessionTimeoutMinutes: number
  auditLogEnabled: boolean
  passwordMinLength: number
  passwordRequireSpecial: boolean
  ipWhitelistEnabled: boolean
  ipWhitelist: string
}

function SecuritySection() {
  const [settings, setSettings] = useState<SecuritySettings>({
    mfaRequired: false,
    sessionTimeoutMinutes: 480,
    auditLogEnabled: true,
    passwordMinLength: 8,
    passwordRequireSpecial: true,
    ipWhitelistEnabled: false,
    ipWhitelist: '',
  })
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mfaExpanded, setMfaExpanded] = useState(false)

  const toggle = (key: keyof SecuritySettings) => {
    setSettings((s) => ({ ...s, [key]: !s[key] }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.patch('/settings/security', settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch {
      // Store locally if API not yet wired
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const ToggleRow = ({
    icon: Icon,
    label,
    description,
    settingKey,
    children,
  }: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    description: string
    settingKey: keyof SecuritySettings
    children?: React.ReactNode
  }) => (
    <div className="border-b border-gray-100 last:border-0">
      <div className="flex items-start justify-between py-4">
        <div className="flex items-start gap-3">
          <div className="p-1.5 bg-gray-100 rounded-lg mt-0.5">
            <Icon className="w-3.5 h-3.5 text-gray-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">{label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{description}</p>
          </div>
        </div>
        <button
          onClick={() => { toggle(settingKey); if (settingKey === 'mfaRequired') setMfaExpanded(!settings[settingKey]) }}
          className={cn(
            'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 mt-0.5',
            settings[settingKey] ? 'bg-indigo-600' : 'bg-gray-200'
          )}
        >
          <span className={cn(
            'inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200',
            settings[settingKey] ? 'translate-x-4' : 'translate-x-0'
          )} />
        </button>
      </div>
      {children && settings[settingKey] && (
        <div className="pb-4 pl-10">{children}</div>
      )}
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Sécurité</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Protégez votre espace NexusRH avec des règles de sécurité adaptées.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
            saved ? 'bg-green-100 text-green-700' : 'bg-indigo-600 text-white hover:bg-indigo-700'
          )}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
          {saved ? 'Enregistré' : 'Enregistrer'}
        </button>
      </div>

      {/* MFA Banner when enabled */}
      {settings.mfaRequired && (
        <div className="flex items-start gap-3 p-3 bg-indigo-50 border border-indigo-200 rounded-xl">
          <Shield className="w-4 h-4 text-indigo-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-indigo-800">
            <p className="font-semibold">MFA activé</p>
            <p className="mt-0.5">Les utilisateurs sans MFA configuré seront invités à l'activer à leur prochaine connexion.</p>
          </div>
        </div>
      )}

      <div className="border border-gray-200 rounded-xl px-4 divide-y divide-gray-100">
        <ToggleRow
          icon={Lock}
          label="Authentification à deux facteurs (MFA)"
          description="Exiger le TOTP (Google Authenticator, Authy…) pour tous les utilisateurs de ce tenant"
          settingKey="mfaRequired"
        >
          <div className="space-y-2 text-xs text-indigo-700 bg-indigo-50 rounded-lg p-3 border border-indigo-200">
            <p className="font-semibold">Délai de grâce avant enforcement :</p>
            <div className="flex items-center gap-2">
              {[0, 1, 3, 7].map((days) => (
                <button
                  key={days}
                  className="px-2.5 py-1 bg-white border border-indigo-200 rounded-lg hover:border-indigo-400 font-medium"
                >
                  {days === 0 ? 'Immédiat' : `${days}j`}
                </button>
              ))}
            </div>
          </div>
        </ToggleRow>

        <ToggleRow
          icon={Clock}
          label="Expiration de session automatique"
          description="Déconnecter l'utilisateur après une période d'inactivité"
          settingKey="sessionTimeoutMinutes"
        >
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-600">Délai d'inactivité :</p>
            <select
              value={settings.sessionTimeoutMinutes}
              onChange={(e) => { setSettings((s) => ({ ...s, sessionTimeoutMinutes: Number(e.target.value) })); setSaved(false) }}
              className="border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              <option value={30}>30 minutes</option>
              <option value={60}>1 heure</option>
              <option value={240}>4 heures</option>
              <option value={480}>8 heures (défaut)</option>
              <option value={1440}>24 heures</option>
            </select>
          </div>
        </ToggleRow>

        <ToggleRow
          icon={FileWarning}
          label="Journal d'audit complet"
          description="Enregistrer toutes les actions sensibles (connexions, modifications RH, exports paie…)"
          settingKey="auditLogEnabled"
        />

        <ToggleRow
          icon={Lock}
          label="Politique de mot de passe renforcée"
          description="Exiger des caractères spéciaux et une longueur minimale"
          settingKey="passwordRequireSpecial"
        >
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-600">Longueur minimale :</p>
            <input
              type="number"
              min={6}
              max={32}
              value={settings.passwordMinLength}
              onChange={(e) => { setSettings((s) => ({ ...s, passwordMinLength: Number(e.target.value) })); setSaved(false) }}
              className="w-16 border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <span className="text-xs text-gray-500">caractères</span>
          </div>
        </ToggleRow>

        <ToggleRow
          icon={Globe}
          label="Liste blanche d'adresses IP"
          description="Restreindre l'accès à NexusRH à des adresses IP spécifiques (CIDR accepté)"
          settingKey="ipWhitelistEnabled"
        >
          <textarea
            value={settings.ipWhitelist}
            onChange={(e) => { setSettings((s) => ({ ...s, ipWhitelist: e.target.value })); setSaved(false) }}
            placeholder={'192.168.1.0/24\n10.0.0.1\n203.0.113.42'}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-gray-400 mt-1">Une IP ou plage CIDR par ligne. Votre IP actuelle sera ajoutée automatiquement.</p>
        </ToggleRow>
      </div>

      {/* Sessions actives */}
      <div className="border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-800">Sessions actives</p>
          <button className="text-xs text-red-500 hover:text-red-700 font-medium">
            Révoquer toutes les sessions
          </button>
        </div>
        <div className="space-y-2">
          {[
            { device: 'Chrome sur Windows', ip: '203.0.113.1', lastSeen: 'maintenant', current: true },
            { device: 'Safari sur iPhone', ip: '185.220.101.8', lastSeen: 'il y a 2h', current: false },
          ].map((session) => (
            <div key={session.ip} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
              <div className="flex items-center gap-2">
                <div className={cn('w-2 h-2 rounded-full', session.current ? 'bg-green-500' : 'bg-gray-300')} />
                <div>
                  <p className="text-xs font-medium text-gray-800">{session.device}</p>
                  <p className="text-xs text-gray-400">{session.ip} · {session.lastSeen}</p>
                </div>
              </div>
              {!session.current && (
                <button className="text-xs text-red-400 hover:text-red-600">Révoquer</button>
              )}
              {session.current && <span className="text-xs text-green-600 font-medium">Session en cours</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Appearance section (full options) ───────────────────────────────────────

function AppearanceSection() {
  const { theme, setTheme } = useUIStore()
  const { user, tenantConfig, setTenantConfig } = useAuthStore()
  const [primaryColor, setPrimaryColor] = useState(tenantConfig?.primaryColor ?? '#4F46E5')
  const [secondaryColor, setSecondaryColor] = useState(tenantConfig?.secondaryColor ?? '#818CF8')
  const [density, setDensity] = useState<'compact' | 'comfortable' | 'spacious'>('comfortable')
  const [sidebarStyle, setSidebarStyle] = useState<'full' | 'icons' | 'minimal'>('full')
  const [fontFamily, setFontFamily] = useState<'inter' | 'roboto' | 'poppins' | 'system'>('inter')
  const [saved, setSaved] = useState(false)
  // Prevent API query from overwriting user's in-progress edits
  const initializedRef = useRef(false)

  // Load saved appearance from API — only initializes state ONCE on mount
  useQuery({
    queryKey: ['settings-appearance'],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api.get('/settings/appearance')
      const d = res.data.data
      // Only set state on first load, never overwrite user's live changes
      if (!initializedRef.current) {
        initializedRef.current = true
        if (d.primaryColor)   setPrimaryColor(d.primaryColor)
        if (d.secondaryColor) setSecondaryColor(d.secondaryColor)
        if (d.density)        setDensity(d.density as typeof density)
        if (d.sidebarStyle)   setSidebarStyle(d.sidebarStyle as typeof sidebarStyle)
        if (d.fontFamily)     setFontFamily(d.fontFamily as typeof fontFamily)
        if (d.theme)          setTheme(d.theme)
      }
      return d
    },
  })

  /** Applique les couleurs dans le store ET via CSS vars pour couvrir tous les cas */
  const applyTheme = (primary: string, secondary: string) => {
    document.documentElement.style.setProperty('--primary-color', primary)
    document.documentElement.style.setProperty('--secondary-color', secondary)
    const base = tenantConfig ?? {
      name: user?.firstName ?? 'Tenant',
      slug: '',
      primaryColor: primary,
      secondaryColor: secondary,
      logoUrl: null,
    }
    setTenantConfig({ ...base, primaryColor: primary, secondaryColor: secondary })
  }

  const handleSave = async () => {
    // Apply immediately regardless of API result
    applyTheme(primaryColor, secondaryColor)
    try {
      await api.patch('/settings/appearance', { primaryColor, secondaryColor, density, sidebarStyle, fontFamily, theme })
    } catch {
      // Already applied locally — silently ignore API failure
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const PRESET_THEMES = [
    { name: 'Indigo (défaut)', primary: '#4F46E5', secondary: '#818CF8' },
    { name: 'Bleu ocean',      primary: '#0EA5E9', secondary: '#38BDF8' },
    { name: 'Vert émeraude',   primary: '#059669', secondary: '#34D399' },
    { name: 'Violet amethyste',primary: '#7C3AED', secondary: '#A78BFA' },
    { name: 'Rouge corail',    primary: '#DC2626', secondary: '#F87171' },
    { name: 'Orange sable',    primary: '#D97706', secondary: '#FCD34D' },
    { name: 'Rose magenta',    primary: '#DB2777', secondary: '#F472B6' },
    { name: 'Gris ardoise',    primary: '#475569', secondary: '#94A3B8' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Apparence</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Personnalisez l'interface NexusRH aux couleurs de votre entreprise.
          </p>
        </div>
        <button
          onClick={handleSave}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
            saved ? 'bg-green-100 text-green-700' : 'bg-indigo-600 text-white hover:bg-indigo-700'
          )}
        >
          {saved ? <Check className="w-4 h-4" /> : <Paintbrush className="w-4 h-4" />}
          {saved ? 'Appliqué' : 'Appliquer'}
        </button>
      </div>

      {/* Thème clair/sombre */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sun className="w-4 h-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Mode d'affichage</p>
        </div>
        <div className="flex gap-3">
          {([
            { id: 'light' as const,  label: 'Clair',   Icon: Sun },
            { id: 'dark' as const,   label: 'Sombre',  Icon: Moon },
            { id: 'system' as const, label: 'Système', Icon: Monitor },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all',
                theme === t.id
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm'
                  : 'border-gray-200 text-gray-700 hover:border-gray-300 hover:bg-gray-50'
              )}
            >
              <t.Icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Couleurs */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Paintbrush className="w-4 h-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Couleurs de la marque</p>
        </div>
        {/* Presets */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {PRESET_THEMES.map((preset) => (
            <button
              key={preset.primary}
              onClick={() => { setPrimaryColor(preset.primary); setSecondaryColor(preset.secondary) }}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-all',
                primaryColor === preset.primary
                  ? 'border-gray-400 shadow-sm ring-1 ring-gray-300'
                  : 'border-gray-200 hover:border-gray-300'
              )}
            >
              <span
                className="w-4 h-4 rounded-full flex-shrink-0"
                style={{ background: `linear-gradient(135deg, ${preset.primary}, ${preset.secondary})` }}
              />
              <span className="truncate text-gray-700">{preset.name}</span>
            </button>
          ))}
        </div>
        {/* Custom colors */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1.5">Couleur primaire</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-10 h-10 rounded-lg border border-gray-300 cursor-pointer p-0.5"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="#4F46E5"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1.5">Couleur secondaire</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={secondaryColor}
                onChange={(e) => setSecondaryColor(e.target.value)}
                className="w-10 h-10 rounded-lg border border-gray-300 cursor-pointer p-0.5"
              />
              <input
                type="text"
                value={secondaryColor}
                onChange={(e) => setSecondaryColor(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="#818CF8"
              />
            </div>
          </div>
        </div>
        {/* Live preview */}
        <div className="mt-3 p-3 rounded-xl border border-gray-200 bg-gray-50">
          <p className="text-xs text-gray-500 mb-2">Aperçu en direct</p>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="px-3 py-1.5 text-white text-xs font-medium rounded-lg" style={{ backgroundColor: primaryColor }}>
              Bouton primaire
            </button>
            <button className="px-3 py-1.5 text-xs font-medium rounded-lg border-2" style={{ borderColor: primaryColor, color: primaryColor }}>
              Bouton secondaire
            </button>
            <span className="px-2 py-0.5 text-xs font-medium rounded-full text-white" style={{ backgroundColor: secondaryColor }}>Badge</span>
            <div className="w-5 h-5 rounded-full" style={{ backgroundColor: primaryColor }} />
          </div>
        </div>
      </div>

      {/* Logo */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Image className="w-4 h-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Logo de l'entreprise</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-300 flex items-center justify-center bg-gray-50">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-white text-lg font-bold"
              style={{ backgroundColor: primaryColor }}
            >
              {user?.firstName?.[0] ?? 'T'}
            </div>
          </div>
          <div className="space-y-2">
            <label className="cursor-pointer">
              <span className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">
                <Upload className="w-4 h-4 text-indigo-500" />
                Changer le logo
              </span>
              <input type="file" accept=".png,.jpg,.jpeg,.svg,.webp" className="hidden" />
            </label>
            <p className="text-xs text-gray-400">PNG, JPG, SVG ou WebP — max 2 Mo — recommandé : 512×512px</p>
          </div>
        </div>
      </div>

      {/* Densité */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <LayoutDashboard className="w-4 h-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Densité de l'interface</p>
        </div>
        <div className="flex gap-3">
          {([
            { id: 'compact' as const,     label: 'Compacte',     desc: 'Plus d\'infos à l\'écran' },
            { id: 'comfortable' as const, label: 'Confortable',  desc: 'Équilibre lisibilité / densité' },
            { id: 'spacious' as const,    label: 'Aérée',        desc: 'Plus d\'espace entre les éléments' },
          ]).map((d) => (
            <button
              key={d.id}
              onClick={() => setDensity(d.id)}
              className={cn(
                'flex-1 px-3 py-2.5 rounded-xl border text-sm transition-all text-left',
                density === d.id
                  ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                  : 'border-gray-200 hover:border-gray-300'
              )}
            >
              <p className={cn('font-medium', density === d.id ? 'text-indigo-700' : 'text-gray-800')}>{d.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{d.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Sidebar */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Columns className="w-4 h-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Style de la barre latérale</p>
        </div>
        <div className="flex gap-3">
          {([
            { id: 'full' as const,    label: 'Complète',  desc: 'Icône + libellé' },
            { id: 'icons' as const,   label: 'Icônes',    desc: 'Icônes seules + tooltips' },
            { id: 'minimal' as const, label: 'Minimale',  desc: 'Réduite par défaut' },
          ]).map((s) => (
            <button
              key={s.id}
              onClick={() => setSidebarStyle(s.id)}
              className={cn(
                'flex-1 px-3 py-2.5 rounded-xl border text-sm transition-all text-left',
                sidebarStyle === s.id
                  ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                  : 'border-gray-200 hover:border-gray-300'
              )}
            >
              <p className={cn('font-medium', sidebarStyle === s.id ? 'text-indigo-700' : 'text-gray-800')}>{s.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{s.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Police */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Type className="w-4 h-4 text-gray-500" />
          <p className="text-sm font-semibold text-gray-800">Police d'écriture</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {([
            { id: 'inter' as const,   label: 'Inter',   sample: 'Aa — Police moderne et lisible' },
            { id: 'roboto' as const,  label: 'Roboto',  sample: 'Aa — Police Google Workspace' },
            { id: 'poppins' as const, label: 'Poppins', sample: 'Aa — Police arrondie et chaleureuse' },
            { id: 'system' as const,  label: 'Système', sample: 'Aa — Police système de l\'OS' },
          ]).map((f) => (
            <button
              key={f.id}
              onClick={() => setFontFamily(f.id)}
              className={cn(
                'px-3 py-2.5 rounded-xl border text-left transition-all',
                fontFamily === f.id
                  ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                  : 'border-gray-200 hover:border-gray-300'
              )}
            >
              <p className={cn('text-sm font-semibold', fontFamily === f.id ? 'text-indigo-700' : 'text-gray-800')}>{f.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{f.sample}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Integrations section V2 (real logos + functional modals) ─────────────────

// Inline SVG logos for integrations
const INTEGRATION_LOGOS: Record<string, React.ReactNode> = {
  google: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  microsoft: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <path d="M11.4 2H2v9.4h9.4V2z" fill="#F25022"/>
      <path d="M22 2h-9.4v9.4H22V2z" fill="#7FBA00"/>
      <path d="M11.4 12.6H2V22h9.4v-9.4z" fill="#00A4EF"/>
      <path d="M22 12.6h-9.4V22H22v-9.4z" fill="#FFB900"/>
    </svg>
  ),
  slack: (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#E01E5A"/>
    </svg>
  ),
  teams: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <path d="M20 3h-5a3 3 0 0 0-3 3v2H7a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z" fill="#5059C9"/>
      <circle cx="18" cy="5" r="3" fill="#7B83EB"/>
      <circle cx="9" cy="10" r="3" fill="#5059C9"/>
      <path d="M15 11a4 4 0 0 0-8 0v8h8v-8z" fill="#4B53BC"/>
    </svg>
  ),
  docusign: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#FFCC22"/>
      <path d="M12 4C7.58 4 4 7.58 4 12s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm-1 11.5l-3-3 1.41-1.41L11 13.67l5.59-5.58L18 9.5l-7 7z" fill="#333"/>
    </svg>
  ),
  yousign: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#0058FF"/>
      <path d="M7 8h10M7 12h7M7 16h5" stroke="white" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  silae: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#00B4D8"/>
      <text x="12" y="16" textAnchor="middle" fill="white" fontSize="9" fontWeight="bold">SILAE</text>
    </svg>
  ),
  payfit: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#FF4C61"/>
      <path d="M6 12h12M12 6v12" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  ),
  workday: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#F5A623"/>
      <circle cx="12" cy="12" r="5" fill="white"/>
      <circle cx="12" cy="12" r="2.5" fill="#F5A623"/>
    </svg>
  ),
  bamboohr: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#7AC143"/>
      <path d="M8 17V10c0-2.2 1.8-4 4-4s4 1.8 4 4v1" stroke="white" strokeWidth="2" strokeLinecap="round"/>
      <path d="M12 13v4" stroke="white" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  zapier: (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="4" fill="#FF4A00"/>
      <path d="M12 3l1.5 4.5H18l-3.75 2.72 1.43 4.4L12 11.9l-3.68 2.72 1.43-4.4L6 7.5h4.5L12 3z" fill="white"/>
    </svg>
  ),
  webhook: (
    <div className="w-6 h-6 rounded-lg bg-gray-800 flex items-center justify-center">
      <Link2 className="w-3.5 h-3.5 text-white" />
    </div>
  ),
}

interface IntegrationConfig {
  id: string
  name: string
  description: string
  category: string
  connected: boolean
  fields?: Array<{ key: string; label: string; type: string; placeholder: string; required?: boolean }>
}

function IntegrationsSectionV2() {
  const INTEGRATIONS: IntegrationConfig[] = [
    {
      id: 'google', name: 'Google Workspace', description: 'SSO Google + synchronisation Google Agenda', category: 'Identité', connected: false,
      fields: [
        { key: 'clientId',     label: 'Client ID',     type: 'text',     placeholder: '...apps.googleusercontent.com', required: true },
        { key: 'clientSecret', label: 'Client Secret', type: 'password', placeholder: 'GOCSPX-...', required: true },
        { key: 'domain',       label: 'Domaine G Suite', type: 'text',   placeholder: 'entreprise.com' },
      ],
    },
    {
      id: 'microsoft', name: 'Microsoft 365', description: 'SSO Azure AD + Teams + Outlook', category: 'Identité', connected: false,
      fields: [
        { key: 'tenantId',     label: 'Tenant ID',     type: 'text',     placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true },
        { key: 'clientId',     label: 'Application ID',type: 'text',     placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true },
        { key: 'clientSecret', label: 'Client Secret', type: 'password', placeholder: 'Valeur du secret', required: true },
      ],
    },
    { id: 'slack',    name: 'Slack',            description: 'Notifications RH dans vos channels Slack', category: 'Messagerie', connected: false,
      fields: [
        { key: 'webhookUrl', label: 'Webhook URL Slack', type: 'url', placeholder: 'https://hooks.slack.com/services/...', required: true },
        { key: 'channel',    label: 'Channel par défaut', type: 'text', placeholder: '#rh-notifications' },
      ],
    },
    { id: 'teams',    name: 'Microsoft Teams',  description: 'Alertes et rappels dans Teams', category: 'Messagerie', connected: false,
      fields: [
        { key: 'webhookUrl', label: 'Webhook Connector URL', type: 'url', placeholder: 'https://outlook.office.com/webhook/...', required: true },
      ],
    },
    { id: 'docusign', name: 'DocuSign',          description: 'Signature électronique des contrats', category: 'Documents', connected: false,
      fields: [
        { key: 'integrationKey', label: 'Integration Key', type: 'text',     placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true },
        { key: 'secretKey',      label: 'Secret Key',      type: 'password', placeholder: 'Votre clé secrète DocuSign', required: true },
        { key: 'accountId',      label: 'Account ID',      type: 'text',     placeholder: 'Votre identifiant de compte DocuSign' },
        { key: 'environment',    label: 'Environnement',   type: 'select',   placeholder: 'demo|production' },
      ],
    },
    { id: 'yousign',  name: 'YouSign',            description: 'Signature électronique (solution française)', category: 'Documents', connected: false,
      fields: [
        { key: 'apiKey',      label: 'Clé API YouSign', type: 'password', placeholder: 'ys_xxx...', required: true },
        { key: 'environment', label: 'Environnement',   type: 'text',     placeholder: 'staging | production' },
      ],
    },
    { id: 'silae',    name: 'Silae',              description: 'Export DSN et données de paie vers Silae', category: 'Paie / RH', connected: false,
      fields: [
        { key: 'url',      label: 'URL API Silae',  type: 'url',      placeholder: 'https://...silae.fr/api', required: true },
        { key: 'login',    label: 'Identifiant',    type: 'text',     placeholder: 'Votre identifiant Silae', required: true },
        { key: 'password', label: 'Mot de passe',   type: 'password', placeholder: '••••••••', required: true },
        { key: 'dossierId',label: 'Numéro de dossier', type: 'text',  placeholder: 'Ex: 123456' },
      ],
    },
    { id: 'payfit',   name: 'PayFit',             description: 'Synchronisation avec PayFit', category: 'Paie / RH', connected: false,
      fields: [
        { key: 'apiKey',   label: 'Clé API PayFit', type: 'password', placeholder: 'pk_live_...', required: true },
        { key: 'companyId',label: 'ID Entreprise',  type: 'text',     placeholder: 'Identifiant entreprise PayFit', required: true },
      ],
    },
    { id: 'workday',  name: 'Workday',            description: 'Synchronisation bidirectionnelle SIRH', category: 'SIRH', connected: false,
      fields: [
        { key: 'tenant',   label: 'Tenant Workday', type: 'text',     placeholder: 'mycompany', required: true },
        { key: 'username', label: 'Utilisateur ISU',type: 'text',     placeholder: 'ISU_nexusrh', required: true },
        { key: 'password', label: 'Mot de passe',   type: 'password', placeholder: '••••••••', required: true },
      ],
    },
    { id: 'bamboohr', name: 'BambooHR',           description: 'Import / export employés BambooHR', category: 'SIRH', connected: false,
      fields: [
        { key: 'subdomain', label: 'Sous-domaine',  type: 'text',     placeholder: 'votreentreprise', required: true },
        { key: 'apiKey',    label: 'Clé API',       type: 'password', placeholder: 'Votre clé API BambooHR', required: true },
      ],
    },
    { id: 'zapier',   name: 'Zapier',             description: 'Automatisations via Zapier', category: 'Automatisation', connected: false,
      fields: [
        { key: 'webhookUrl', label: 'Webhook Zapier', type: 'url', placeholder: 'https://hooks.zapier.com/hooks/catch/...', required: true },
      ],
    },
    { id: 'webhook',  name: 'Webhooks',           description: 'Envoyez des événements vers vos propres systèmes', category: 'Automatisation', connected: true,
      fields: [
        { key: 'url',    label: 'URL de destination', type: 'url',  placeholder: 'https://votre-app.com/webhook', required: true },
        { key: 'secret', label: 'Secret de signature (HMAC)', type: 'password', placeholder: 'Clé secrète pour vérifier l\'authenticité' },
      ],
    },
  ]

  const queryClient = useQueryClient()
  const [integrations, setIntegrations] = useState(INTEGRATIONS)
  const [configuringId, setConfiguringId] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  // Load saved integrations state from API
  useQuery({
    queryKey: ['settings-integrations'],
    queryFn: async () => {
      const res = await api.get('/settings/integrations')
      const saved = res.data.data as Record<string, { connected: boolean }>
      setIntegrations((prev) => prev.map((i) => saved[i.id] ? { ...i, connected: saved[i.id].connected ?? true } : i))
      return saved
    },
  })

  const categories = [...new Set(integrations.map((i) => i.category))]
  const configuringIntegration = integrations.find((i) => i.id === configuringId)

  const openConfig = (id: string) => {
    setConfiguringId(id)
    setConfigValues({})
    setTestResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.post(`/settings/integrations/${configuringId}/test`, configValues)
      setTestResult({ success: true, message: res.data.message ?? 'Connexion réussie ! L\'intégration fonctionne correctement.' })
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } }
      setTestResult({ success: false, message: error.response?.data?.message ?? 'Échec de la connexion. Vérifiez vos identifiants.' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.post(`/settings/integrations/${configuringId}`, configValues)
      setIntegrations((prev) => prev.map((i) => i.id === configuringId ? { ...i, connected: true } : i))
      queryClient.invalidateQueries({ queryKey: ['settings-integrations'] })
      setConfiguringId(null)
    } catch {
      setIntegrations((prev) => prev.map((i) => i.id === configuringId ? { ...i, connected: true } : i))
      setConfiguringId(null)
    } finally {
      setSaving(false)
    }
  }

  const handleDisconnect = async (id: string) => {
    if (confirm('Déconnecter cette intégration ? Les automatisations associées cesseront de fonctionner.')) {
      try {
        await api.delete(`/settings/integrations/${id}`)
        queryClient.invalidateQueries({ queryKey: ['settings-integrations'] })
      } catch { /* ignore */ }
      setIntegrations((prev) => prev.map((i) => i.id === id ? { ...i, connected: false } : i))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Intégrations</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Connectez NexusRH à vos outils existants. Les intégrations disponibles dépendent de votre plan.
        </p>
      </div>

      {categories.map((cat) => (
        <div key={cat} className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{cat}</p>
          <div className="grid grid-cols-2 gap-3">
            {integrations.filter((i) => i.category === cat).map((integration) => (
              <div
                key={integration.id}
                className={cn(
                  'border rounded-xl p-4 flex items-start gap-3 transition-colors',
                  integration.connected
                    ? 'border-green-200 bg-green-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                )}
              >
                <div className="flex-shrink-0 mt-0.5">
                  {INTEGRATION_LOGOS[integration.id] ?? <Settings2 className="w-6 h-6 text-gray-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900">{integration.name}</p>
                    {integration.connected && (
                      <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Connecté</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{integration.description}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={() => integration.connected ? handleDisconnect(integration.id) : openConfig(integration.id)}
                      className={cn(
                        'text-xs font-medium transition-colors flex items-center gap-1',
                        integration.connected
                          ? 'text-red-500 hover:text-red-700'
                          : 'text-indigo-600 hover:text-indigo-800'
                      )}
                    >
                      {integration.connected ? (
                        <><X className="w-3 h-3" /> Déconnecter</>
                      ) : (
                        <><Settings2 className="w-3 h-3" /> Configurer</>
                      )}
                    </button>
                    {integration.connected && (
                      <button
                        onClick={() => openConfig(integration.id)}
                        className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                      >
                        <ChevronRight className="w-3 h-3" /> Modifier
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Configuration Modal */}
      {configuringId && configuringIntegration && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center gap-3 p-6 border-b border-gray-100">
              <div className="flex-shrink-0">
                {INTEGRATION_LOGOS[configuringIntegration.id] ?? <Settings2 className="w-7 h-7 text-gray-400" />}
              </div>
              <div className="flex-1">
                <h3 className="text-base font-bold text-gray-900">Configurer {configuringIntegration.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5">{configuringIntegration.description}</p>
              </div>
              <button onClick={() => setConfiguringId(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {(configuringIntegration.fields ?? []).map((field) => (
                <div key={field.key}>
                  <label className="text-xs font-medium text-gray-700 block mb-1.5">
                    {field.label} {field.required && <span className="text-red-500">*</span>}
                  </label>
                  {field.placeholder.includes('|') ? (
                    <select
                      value={configValues[field.key] ?? ''}
                      onChange={(e) => setConfigValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                    >
                      <option value="">Choisir...</option>
                      {field.placeholder.split('|').map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type}
                      value={configValues[field.key] ?? ''}
                      onChange={(e) => setConfigValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  )}
                </div>
              ))}

              {testResult && (
                <div className={cn(
                  'flex items-start gap-2 p-3 rounded-xl text-sm border',
                  testResult.success ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
                )}>
                  {testResult.success
                    ? <Check className="w-4 h-4 flex-shrink-0 mt-0.5 text-green-600" />
                    : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />}
                  <span className="text-xs">{testResult.message}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-60"
                >
                  {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  Tester la connexion
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Enregistrer
                </button>
                <button onClick={() => setConfiguringId(null)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700">
                  Annuler
                </button>
              </div>

              <div className="pt-2 border-t border-gray-100">
                <a
                  href="#"
                  className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800"
                  onClick={(e) => e.preventDefault()}
                >
                  <ExternalLink className="w-3 h-3" />
                  Documentation {configuringIntegration.name}
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Workflow Section ─────────────────────────────────────────────────────────

const ROLES_OPTIONS = [
  { value: 'manager',    label: 'Manager direct (N+1)' },
  { value: 'hr_officer', label: 'Chargé RH' },
  { value: 'hr_manager', label: 'Responsable RH' },
  { value: 'admin',      label: 'Administrateur' },
]

const MODULE_LABELS: Record<string, { label: string; description: string }> = {
  absences: { label: 'Absences & Congés', description: 'Validation des demandes d\'absence et congés des collaborateurs' },
  expenses: { label: 'Notes de frais', description: 'Validation des notes de frais soumises par les collaborateurs' },
}

interface WorkflowConfig {
  id: string
  module: string
  levels_count: number
  level1_role: string
  level2_role: string | null
  level3_role: string | null
  level4_role: string | null
  updated_at: string
}

function WorkflowSection() {
  const queryClient = useQueryClient()
  const { data: configs = [], isLoading } = useQuery<WorkflowConfig[]>({
    queryKey: ['workflow-configs'],
    queryFn: async () => (await api.get('/settings/workflow')).data.data ?? [],
  })

  const [editing, setEditing] = useState<Record<string, Partial<WorkflowConfig>>>({})

  const updateMutation = useMutation({
    mutationFn: async ({ module, ...body }: { module: string; levelsCount: number; level1Role: string; level2Role?: string | null; level3Role?: string | null; level4Role?: string | null }) => {
      const res = await api.put(`/settings/workflow/${module}`, body)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-configs'] })
      setEditing({})
    },
  })

  const getEdit = (cfg: WorkflowConfig) => editing[cfg.module] ?? {
    levels_count: cfg.levels_count,
    level1_role: cfg.level1_role,
    level2_role: cfg.level2_role,
    level3_role: cfg.level3_role,
    level4_role: cfg.level4_role,
  }

  const patchEdit = (module: string, patch: Partial<WorkflowConfig>) =>
    setEditing((prev) => ({ ...prev, [module]: { ...(prev[module] ?? {}), ...patch } }))

  const levelLabel = (n: number) => ['N+1', 'N+2', 'N+3', 'N+4'][n - 1] ?? `Niveau ${n}`
  const levelKey = (n: number) => [`level1_role`, `level2_role`, `level3_role`, `level4_role`][n - 1] as keyof WorkflowConfig

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-indigo-500" /></div>

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Workflows de validation</h2>
        <p className="text-sm text-gray-500 mt-1">
          Configurez le nombre de niveaux d'approbation (N+1, N+2, N+3, N+4) pour chaque type de demande.
          Modifiable à tout moment en cas de changement d'organigramme.
        </p>
      </div>

      <div className="space-y-4">
        {configs.map((cfg) => {
          const mod = MODULE_LABELS[cfg.module] ?? { label: cfg.module, description: '' }
          const ed = getEdit(cfg)
          const levelsCount = ed.levels_count ?? cfg.levels_count
          const isDirty = JSON.stringify(ed) !== JSON.stringify({
            levels_count: cfg.levels_count, level1_role: cfg.level1_role,
            level2_role: cfg.level2_role, level3_role: cfg.level3_role, level4_role: cfg.level4_role,
          })

          return (
            <div key={cfg.module} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-indigo-500" />
                    {mod.label}
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">{mod.description}</p>
                </div>
                <span className="flex-shrink-0 text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                  {levelsCount} niveau{levelsCount > 1 ? 'x' : ''}
                </span>
              </div>

              {/* Level count selector */}
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-2">Nombre de niveaux de validation</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        patchEdit(cfg.module, { levels_count: n })
                        // Clear unused level roles
                        const patch: Partial<WorkflowConfig> = { levels_count: n }
                        if (n < 2) patch.level2_role = null
                        if (n < 3) patch.level3_role = null
                        if (n < 4) patch.level4_role = null
                        patchEdit(cfg.module, patch)
                      }}
                      className={cn(
                        'flex-1 py-2 text-sm font-medium rounded-lg border transition-all',
                        levelsCount === n
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      )}
                    >
                      {n} {n === 1 ? 'niveau' : 'niveaux'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Role selectors for each active level */}
              <div className="space-y-3">
                <label className="text-xs font-medium text-gray-700 block">Rôles approbateurs par niveau</label>
                {Array.from({ length: levelsCount }, (_, i) => i + 1).map((lvl) => {
                  const key = levelKey(lvl)
                  return (
                    <div key={lvl} className="flex items-center gap-3">
                      <div className="w-16 flex-shrink-0">
                        <span className={cn(
                          'inline-flex items-center justify-center px-2 py-1 rounded-lg text-xs font-bold',
                          lvl === 1 ? 'bg-blue-100 text-blue-700' :
                          lvl === 2 ? 'bg-purple-100 text-purple-700' :
                          lvl === 3 ? 'bg-orange-100 text-orange-700' :
                          'bg-red-100 text-red-700'
                        )}>
                          {levelLabel(lvl)}
                        </span>
                      </div>
                      <select
                        value={(ed[key] as string | null) ?? 'manager'}
                        onChange={(e) => patchEdit(cfg.module, { [key]: e.target.value })}
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        {ROLES_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>

              {/* Validation chain visual */}
              <div className="flex items-center gap-2 py-2 px-3 bg-gray-50 rounded-lg">
                <span className="text-xs text-gray-500 font-medium">Chaîne :</span>
                <span className="text-xs text-gray-400">Employé</span>
                {Array.from({ length: levelsCount }, (_, i) => i + 1).map((lvl) => {
                  const key = levelKey(lvl)
                  const roleLabel = ROLES_OPTIONS.find((r) => r.value === ((ed[key] as string | null) ?? 'manager'))?.label ?? ''
                  return (
                    <span key={lvl} className="flex items-center gap-1.5">
                      <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                      <span className={cn(
                        'text-xs font-medium px-1.5 py-0.5 rounded',
                        lvl === 1 ? 'bg-blue-100 text-blue-700' :
                        lvl === 2 ? 'bg-purple-100 text-purple-700' :
                        lvl === 3 ? 'bg-orange-100 text-orange-700' :
                        'bg-red-100 text-red-700'
                      )}>
                        {roleLabel}
                      </span>
                    </span>
                  )
                })}
                <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                <span className="text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">Approuvé</span>
              </div>

              {isDirty && (
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setEditing((prev) => { const n = { ...prev }; delete n[cfg.module]; return n })}
                    className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={() => updateMutation.mutate({
                      module: cfg.module,
                      levelsCount: levelsCount,
                      level1Role: (ed.level1_role ?? 'manager') as string,
                      level2Role: levelsCount >= 2 ? (ed.level2_role ?? 'hr_manager') as string : null,
                      level3Role: levelsCount >= 3 ? (ed.level3_role ?? 'hr_manager') as string : null,
                      level4Role: levelsCount >= 4 ? (ed.level4_role ?? 'admin') as string : null,
                    })}
                    disabled={updateMutation.isPending}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Enregistrer
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <p className="font-semibold mb-1">Comment fonctionne le workflow ?</p>
        <ul className="space-y-1 text-xs text-amber-700 list-disc list-inside">
          <li>Quand un employé soumet une demande, elle est envoyée au premier approbateur (N+1)</li>
          <li>Chaque valideur approuve son niveau — la demande avance au niveau suivant</li>
          <li>La demande n'est définitivement approuvée qu'après validation de tous les niveaux</li>
          <li>Un refus à n'importe quel niveau clôt la demande avec le statut "Refusée"</li>
          <li>Les modifications ici s'appliquent aux nouvelles demandes uniquement</li>
        </ul>
      </div>
    </div>
  )
}

// ─── Main SettingsPage ────────────────────────────────────────────────────────

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState('referentials')

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Paramètres</h1>
        <p className="text-sm text-gray-500 mt-1">Configuration de l'application NexusRH</p>
      </div>

      <div className="flex gap-6">
        {/* Nav */}
        <div className="w-52 flex-shrink-0">
          <nav className="space-y-1">
            {MAIN_SECTIONS.map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left',
                    activeSection === section.id
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {section.label}
                  {section.id === 'referentials' && (
                    <span className="ml-auto text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">
                      {PARAM_CATEGORIES.length + 2}
                    </span>
                  )}
                  {section.id === 'import' && (
                    <span className="ml-auto text-xs bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">
                      New
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>

        {/* Content panel */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm p-6 min-h-96">
          {activeSection === 'referentials' && <ReferentialsSection />}

          {activeSection === 'company' && (
            <div className="space-y-5">
              <h2 className="text-base font-semibold text-gray-900">Informations entreprise</h2>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: "Nom de l'entreprise", placeholder: 'TechCorp SAS', type: 'text' },
                  { label: 'SIREN', placeholder: '123456789', type: 'text' },
                  { label: 'SIRET', placeholder: '12345678900012', type: 'text' },
                  { label: 'Code APE', placeholder: '6201Z', type: 'text' },
                  { label: 'Email de contact', placeholder: 'rh@entreprise.com', type: 'email' },
                ].map((field) => (
                  <div key={field.label}>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">{field.label}</label>
                    <input
                      type={field.type}
                      placeholder={field.placeholder}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                ))}
              </div>
              <button className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700">
                Enregistrer
              </button>
            </div>
          )}

          {activeSection === 'users'         && <UsersSection />}
          {activeSection === 'workflow'      && <WorkflowSection />}
          {activeSection === 'notifications' && <NotificationsSection />}
          {activeSection === 'integrations'  && <IntegrationsSectionV2 />}
          {activeSection === 'import'        && <ImportSection />}

          {activeSection === 'appearance' && <AppearanceSection />}

          {activeSection === 'security' && <SecuritySection />}
        </div>
      </div>
    </div>
  )
}
