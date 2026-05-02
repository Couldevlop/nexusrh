import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { BookOpen, Clock, CheckCircle, Star } from 'lucide-react'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface TrainingCourse {
  id: string
  title: string
  description: string | null
  durationHours: number
  category: string
  provider: string | null
  isActive: boolean
}

interface Enrollment {
  id: string
  courseId: string
  employeeId: string
  status: 'registered' | 'in_progress' | 'completed' | 'cancelled'
  completedAt: string | null
  createdAt: string
}

const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  registered: 'Inscrit(e)',
  in_progress: 'En cours',
  completed: 'Terminée',
  cancelled: 'Annulée',
}

const ENROLLMENT_STATUS_COLORS: Record<string, string> = {
  registered: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-600',
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MaFormationPage() {
  const queryClient = useQueryClient()

  const { data: courses, isLoading: loadingCatalog } = useQuery<TrainingCourse[]>({
    queryKey: ['training-catalog'],
    queryFn: async () => {
      const res = await api.get<{ data: TrainingCourse[] }>('/training/catalog')
      return res.data.data ?? []
    },
  })

  const { data: enrollments, isLoading: loadingEnrollments } = useQuery<Enrollment[]>({
    queryKey: ['my-enrollments'],
    queryFn: async () => {
      const res = await api.get<{ data: Enrollment[] }>('/training/my-enrollments')
      return res.data.data ?? []
    },
  })

  const enrollMutation = useMutation({
    mutationFn: async (courseId: string) => {
      await api.post('/training/enroll', { courseId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-enrollments'] })
    },
  })

  const enrolledCourseIds = new Set(
    (enrollments ?? [])
      .filter((e) => e.status === 'registered' || e.status === 'in_progress')
      .map((e) => e.courseId)
  )

  const courseMap = new Map((courses ?? []).map((c) => [c.id, c]))

  return (
    <div className="p-6 space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Ma formation</h1>
        <p className="text-sm text-gray-500 mt-1">
          Catalogue de formations et gestion de vos inscriptions
        </p>
      </div>

      {/* My enrollments */}
      <section>
        <h2 className="text-base font-semibold text-gray-800 mb-4">Mes inscriptions</h2>
        {loadingEnrollments ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (enrollments ?? []).length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <BookOpen className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">Aucune inscription</p>
            <p className="text-sm text-gray-400 mt-1">
              Inscrivez-vous à des formations depuis le catalogue ci-dessous.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(enrollments ?? []).map((e, idx) => {
              const course = courseMap.get(e.courseId)
              return (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {course?.title ?? e.courseId}
                      </p>
                      {course && (
                        <p className="text-xs text-gray-500 mt-0.5">
                          {course.category} · {course.durationHours}h
                        </p>
                      )}
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
                        ENROLLMENT_STATUS_COLORS[e.status] ?? 'bg-gray-100 text-gray-600'
                      )}
                    >
                      {ENROLLMENT_STATUS_LABELS[e.status] ?? e.status}
                    </span>
                  </div>
                  {e.status === 'completed' && (
                    <div className="mt-2 flex items-center gap-1 text-xs text-green-600">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Formation terminée
                    </div>
                  )}
                </motion.div>
              )
            })}
          </div>
        )}
      </section>

      {/* Catalog */}
      <section>
        <h2 className="text-base font-semibold text-gray-800 mb-4">Catalogue complet</h2>
        {loadingCatalog ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-40 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (courses ?? []).filter((c) => c.isActive).length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">Aucune formation au catalogue.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(courses ?? [])
              .filter((c) => c.isActive)
              .map((course, idx) => {
                const alreadyEnrolled = enrolledCourseIds.has(course.id)
                return (
                  <motion.div
                    key={course.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm hover:shadow-md transition-shadow flex flex-col"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                        <BookOpen className="w-5 h-5 text-indigo-600" />
                      </div>
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {course.category}
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-gray-900">{course.title}</p>
                    {course.description && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2 flex-1">{course.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {course.durationHours}h
                      </span>
                      {course.provider && (
                        <span className="flex items-center gap-1">
                          <Star className="w-3.5 h-3.5" />
                          {course.provider}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => enrollMutation.mutate(course.id)}
                      disabled={alreadyEnrolled || enrollMutation.isPending}
                      className={cn(
                        'mt-3 w-full py-1.5 text-xs font-medium rounded-lg transition-colors',
                        alreadyEnrolled
                          ? 'bg-green-100 text-green-700 cursor-default'
                          : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:opacity-60'
                      )}
                    >
                      {alreadyEnrolled ? (
                        <span className="flex items-center justify-center gap-1">
                          <CheckCircle className="w-3.5 h-3.5" />
                          Inscrit(e)
                        </span>
                      ) : enrollMutation.isPending ? (
                        'Inscription...'
                      ) : (
                        "S'inscrire"
                      )}
                    </button>
                  </motion.div>
                )
              })}
          </div>
        )}
      </section>
    </div>
  )
}
