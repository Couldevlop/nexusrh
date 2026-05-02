import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, X, Calendar, Trash2 } from 'lucide-react'
import api from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface AbsenceBalance {
  id: string
  absenceTypeName: string
  absenceTypeId: string
  acquired: number
  taken: number
  pending: number
}

interface AbsenceType {
  id: string
  label: string
  name?: string
}

interface Absence {
  id: string
  absenceType: string
  startDate: string
  endDate: string
  isHalfDay: boolean
  reason: string | null
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

// ─── Schema Zod ─────────────────────────────────────────────────────────────

const absenceSchema = z
  .object({
    absenceTypeId: z.string().min(1, 'Veuillez sélectionner un type'),
    startDate: z.string().min(1, 'Date de début requise'),
    endDate: z.string().min(1, 'Date de fin requise'),
    isHalfDay: z.boolean(),
    reason: z.string().optional(),
  })
  .refine((d) => new Date(d.endDate) >= new Date(d.startDate), {
    message: 'La date de fin doit être après la date de début',
    path: ['endDate'],
  })

type AbsenceFormData = z.infer<typeof absenceSchema>

// ─── Status helpers ──────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  rejected: 'Refusée',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-orange-100 text-orange-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const BALANCE_COLORS = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500']

// ─── Component ───────────────────────────────────────────────────────────────

export function MesAbsencesPage() {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)

  const { data: balances, isLoading: loadingBalances } = useQuery<AbsenceBalance[]>({
    queryKey: ['my-absence-balances'],
    queryFn: async () => {
      const res = await api.get<{ data: AbsenceBalance[] }>('/absences/my-balances')
      return res.data.data
    },
  })

  const { data: absenceTypes = [] } = useQuery<AbsenceType[]>({
    queryKey: ['absence-types'],
    queryFn: async () => (await api.get('/settings/absence-types')).data.data ?? [],
    staleTime: 0,
  })

  const { data: absences, isLoading: loadingAbsences } = useQuery<Absence[]>({
    queryKey: ['my-absences'],
    queryFn: async () => {
      const res = await api.get<{ data: Absence[] }>('/absences/my-absences')
      return res.data.data
    },
  })

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<AbsenceFormData>({
    resolver: zodResolver(absenceSchema),
    defaultValues: { isHalfDay: false },
  })

  const createMutation = useMutation({
    mutationFn: async (data: AbsenceFormData) => {
      await api.post('/absences', {
        absenceTypeId: data.absenceTypeId,
        startDate: data.startDate,
        endDate: data.endDate,
        halfDay: data.isHalfDay,
        reason: data.reason,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-absences'] })
      queryClient.invalidateQueries({ queryKey: ['my-absence-balances'] })
      setShowForm(false)
      reset()
    },
  })

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/absences/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-absences'] })
      queryClient.invalidateQueries({ queryKey: ['my-absence-balances'] })
    },
  })

  function onSubmit(data: AbsenceFormData) {
    createMutation.mutate(data)
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mes absences</h1>
          <p className="text-sm text-gray-500 mt-1">Consultez vos soldes et gérez vos demandes</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Demander une absence
        </button>
      </div>

      {/* Balances */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Mes soldes</h2>
        {loadingBalances ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (balances ?? []).length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">Aucun solde disponible</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(balances ?? []).map((b, i) => {
              const remaining = Number(b.acquired) - Number(b.taken) - Number(b.pending)
              const pct = Math.min(
                100,
                (Number(b.taken) / Math.max(1, Number(b.acquired))) * 100
              )
              return (
                <div key={b.id} className="bg-gray-50 rounded-lg p-4">
                  <p className="text-xs text-gray-500 truncate font-medium">{b.absenceTypeName}</p>
                  <div className="flex items-baseline gap-1 mt-2">
                    <span className="text-3xl font-bold text-gray-900">{remaining}</span>
                    <span className="text-sm text-gray-400">jours</span>
                  </div>
                  <div className="h-1.5 bg-gray-200 rounded-full mt-2">
                    <div
                      className={cn('h-full rounded-full transition-all', BALANCE_COLORS[i % BALANCE_COLORS.length])}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5">
                    {Number(b.taken)} pris · {Number(b.pending)} en attente
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* History */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Historique des demandes</h2>
        </div>
        {loadingAbsences ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-14 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : (absences ?? []).length === 0 ? (
          <div className="text-center py-12">
            <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Aucune demande d'absence</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {(absences ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{a.absenceType}</p>
                    {a.isHalfDay && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                        Demi-journée
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Du {new Date(a.startDate).toLocaleDateString('fr-FR')} au{' '}
                    {new Date(a.endDate).toLocaleDateString('fr-FR')}
                    {a.reason && ` · ${a.reason}`}
                  </p>
                </div>
                <span
                  className={cn(
                    'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
                    STATUS_COLORS[a.status] ?? 'bg-gray-100 text-gray-600'
                  )}
                >
                  {STATUS_LABELS[a.status] ?? a.status}
                </span>
                {a.status === 'pending' && (
                  <button
                    onClick={() => cancelMutation.mutate(a.id)}
                    disabled={cancelMutation.isPending}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                    title="Annuler cette demande"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Form modal */}
      <AnimatePresence>
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg"
            >
              <div className="flex items-center justify-between p-6 border-b border-gray-100">
                <h3 className="text-lg font-semibold text-gray-900">Nouvelle demande d'absence</h3>
                <button
                  onClick={() => {
                    setShowForm(false)
                    reset()
                  }}
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
                {/* Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Type d'absence <span className="text-red-500">*</span>
                  </label>
                  <select
                    {...register('absenceTypeId')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Sélectionner un type</option>
                    {(absenceTypes ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label ?? t.name}
                      </option>
                    ))}
                  </select>
                  {errors.absenceTypeId && (
                    <p className="text-xs text-red-500 mt-1">{errors.absenceTypeId.message}</p>
                  )}
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Date de début <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      {...register('startDate')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errors.startDate && (
                      <p className="text-xs text-red-500 mt-1">{errors.startDate.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Date de fin <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      {...register('endDate')}
                      min={watch('startDate')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errors.endDate && (
                      <p className="text-xs text-red-500 mt-1">{errors.endDate.message}</p>
                    )}
                  </div>
                </div>

                {/* Half day */}
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="isHalfDay"
                    {...register('isHalfDay')}
                    className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                  />
                  <label htmlFor="isHalfDay" className="text-sm text-gray-700">
                    Demi-journée uniquement
                  </label>
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Motif (optionnel)
                  </label>
                  <textarea
                    {...register('reason')}
                    rows={3}
                    placeholder="Précisez le motif si nécessaire..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                  />
                </div>

                {createMutation.isError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    Une erreur est survenue. Veuillez réessayer.
                  </p>
                )}

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false)
                      reset()
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    disabled={createMutation.isPending}
                    className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
                  >
                    {createMutation.isPending ? 'Envoi...' : 'Soumettre la demande'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
