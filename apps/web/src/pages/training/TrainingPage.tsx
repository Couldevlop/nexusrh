import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BookOpen, Plus, Clock, Users, Star, Search, X, AlertCircle } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import api from '@/lib/api'
import { formatDate, cn } from '@/lib/utils'

interface TrainingCourse {
  id: string
  title: string
  description: string | null
  category: string
  durationHours: number
  provider: string | null
  isActive: boolean
}

interface TrainingEnrollment {
  id: string
  courseId: string
  employeeId: string
  status: 'registered' | 'in_progress' | 'completed' | 'cancelled'
  completedAt: string | null
}

interface TrainingCategory { id: string; code: string; label: string }

const newCourseSchema = z.object({
  title: z.string().min(2, 'Titre requis'),
  category: z.string().min(1, 'Catégorie requise'),
  duration: z.number().min(1, 'Durée requise').max(999),
  maxParticipants: z.number().min(1).max(999).default(20),
  provider: z.string().optional(),
  description: z.string().optional(),
})

type NewCourseForm = z.infer<typeof newCourseSchema>

export function TrainingPage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'catalog' | 'enrollments'>('catalog')
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)

  const { data: trainingCategories = [] } = useQuery<TrainingCategory[]>({
    queryKey: ['settings-parameters', 'training_category'],
    queryFn: async () => (await api.get('/settings/parameters?category=training_category')).data.data ?? [],
    staleTime: 0,
  })

  const { data: courses, isLoading } = useQuery<TrainingCourse[]>({
    queryKey: ['training-courses'],
    queryFn: async () => {
      const res = await api.get('/training/courses')
      return res.data.data ?? []
    },
  })

  const { data: enrollments } = useQuery<TrainingEnrollment[]>({
    queryKey: ['training-enrollments'],
    queryFn: async () => {
      const res = await api.get('/training/enrollments')
      return res.data.data ?? []
    },
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<NewCourseForm>({
    resolver: zodResolver(newCourseSchema),
    defaultValues: { maxParticipants: 20, duration: 8 },
  })

  const createMutation = useMutation({
    mutationFn: async (data: NewCourseForm) => {
      await api.post('/training/courses', data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-courses'] })
      setShowModal(false)
      reset()
    },
  })

  const enrollMutation = useMutation({
    mutationFn: async (courseId: string) => {
      await api.post('/training/enroll', { courseId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-enrollments'] })
    },
  })

  const filteredCourses = courses?.filter(
    (c) => search === '' || c.title.toLowerCase().includes(search.toLowerCase())
  ) ?? []

  const statusColors = {
    registered: 'bg-blue-100 text-blue-700',
    in_progress: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
  }

  const statusLabels = {
    registered: 'Inscrit',
    in_progress: 'En cours',
    completed: 'Terminé',
    cancelled: 'Annulé',
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Formation</h1>
          <p className="text-sm text-gray-500 mt-1">Catalogue de formations et plan de développement</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Ajouter une formation
        </button>
      </div>

      {/* New course modal */}
      <AnimatePresence>
        {showModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
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
                      <BookOpen className="w-4 h-4 text-indigo-600" />
                    </div>
                    <h2 className="text-base font-semibold text-gray-900">Ajouter une formation</h2>
                  </div>
                  <button
                    onClick={() => { setShowModal(false); reset() }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Titre de la formation *</label>
                    <input
                      {...register('title')}
                      placeholder="ex. React Avancé — Hooks & Architecture"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errors.title && <p className="text-xs text-red-500 mt-1">{errors.title.message}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Catégorie *</label>
                      <select
                        {...register('category')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="">Sélectionner</option>
                        {trainingCategories.map((c) => (
                          <option key={c.code} value={c.label}>{c.label}</option>
                        ))}
                      </select>
                      {errors.category && <p className="text-xs text-red-500 mt-1">{errors.category.message}</p>}
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Prestataire</label>
                      <input
                        {...register('provider')}
                        placeholder="ex. OpenClassrooms"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Durée (heures) *</label>
                      <input
                        type="number"
                        {...register('duration', { valueAsNumber: true })}
                        min={1}
                        max={999}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors.duration && <p className="text-xs text-red-500 mt-1">{errors.duration.message}</p>}
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Participants max</label>
                      <input
                        type="number"
                        {...register('maxParticipants', { valueAsNumber: true })}
                        min={1}
                        max={999}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Description</label>
                    <textarea
                      {...register('description')}
                      rows={2}
                      placeholder="Objectifs, contenu, prérequis..."
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                    />
                  </div>

                  {createMutation.isError && (
                    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {(createMutation.error as { message?: string }).message ?? 'Erreur lors de la création'}
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => { setShowModal(false); reset() }}
                      className="flex-1 py-2.5 border border-gray-300 text-sm font-medium text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={createMutation.isPending}
                      className="flex-1 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                    >
                      {createMutation.isPending ? 'Ajout...' : 'Ajouter'}
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
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Formations disponibles</p>
          <p className="text-2xl font-bold text-gray-900">{courses?.filter(c => c.isActive).length ?? 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Inscriptions actives</p>
          <p className="text-2xl font-bold text-indigo-700">
            {enrollments?.filter(e => ['registered', 'in_progress'].includes(e.status)).length ?? 0}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Formations terminées</p>
          <p className="text-2xl font-bold text-green-600">
            {enrollments?.filter(e => e.status === 'completed').length ?? 0}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Heures de formation</p>
          <p className="text-2xl font-bold text-gray-900">
            {(enrollments?.filter(e => e.status === 'completed').length ?? 0) * 8}h
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'catalog', label: 'Catalogue' },
          { id: 'enrollments', label: 'Inscriptions' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as 'catalog' | 'enrollments')}
            className={cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'catalog' && (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher une formation..."
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-40 bg-gray-100 rounded-xl animate-pulse" />
                ))
              : filteredCourses.length === 0
              ? (
                  <div className="col-span-3 py-16 text-center">
                    <BookOpen className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-sm text-gray-400">Aucune formation — ajoutez votre première formation</p>
                  </div>
                )
              : filteredCourses.map((course) => (
                  <motion.div
                    key={course.id}
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow cursor-pointer"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
                        <BookOpen className="w-5 h-5 text-indigo-600" />
                      </div>
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {course.category}
                      </span>
                    </div>
                    <h3 className="font-semibold text-gray-900 mt-2">{course.title}</h3>
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2">{course.description}</p>
                    <div className="flex items-center gap-3 mt-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {course.durationHours}h
                      </span>
                      {course.provider && (
                        <span className="flex items-center gap-1">
                          <Star className="w-3 h-3" /> {course.provider}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => enrollMutation.mutate(course.id)}
                      disabled={enrollMutation.isPending}
                      className="mt-3 w-full py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {enrollMutation.isPending ? 'Inscription...' : "S'inscrire"}
                    </button>
                  </motion.div>
                ))}
          </div>
        </div>
      )}

      {activeTab === 'enrollments' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {(!enrollments || enrollments.length === 0) ? (
            <div className="py-16 text-center">
              <Users className="w-10 h-10 text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-400">Aucune inscription enregistrée</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {enrollments.map((enrollment) => {
                const course = courses?.find((c) => c.id === enrollment.courseId)
                return (
                <div key={enrollment.id} className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{course?.title ?? enrollment.courseId}</p>
                    <p className="text-xs text-gray-500">{course?.category ?? ''} · {enrollment.employeeId}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {enrollment.completedAt && (
                      <span className="text-xs text-gray-400">{formatDate(enrollment.completedAt)}</span>
                    )}
                    <span className={cn(
                      'text-xs px-2 py-1 rounded-full font-medium',
                      statusColors[enrollment.status]
                    )}>
                      {statusLabels[enrollment.status]}
                    </span>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
