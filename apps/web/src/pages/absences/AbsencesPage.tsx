import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Check, X, Clock, Calendar, Filter, AlertCircle } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import api from '@/lib/api'
import { formatDate, getStatusColor, cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import type { Absence, AbsenceBalance } from '@nexusrh/shared'

type AbsenceStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

const STATUS_ICONS = {
  pending: Clock,
  approved: Check,
  rejected: X,
  cancelled: X,
}

interface AbsenceType { id: string; code: string; label: string; color: string }

const newAbsenceSchema = z.object({
  absenceTypeCode: z.string().min(1, 'Type requis'),
  startDate: z.string().min(1, 'Date de début requise'),
  endDate: z.string().min(1, 'Date de fin requise'),
  halfDay: z.boolean().default(false),
  reason: z.string().optional(),
  employeeId: z.string().optional(),
})

type NewAbsenceForm = z.infer<typeof newAbsenceSchema>

interface EmployeeOption {
  id: string
  firstName: string
  lastName: string
}

export function AbsencesPage() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [filterStatus, setFilterStatus] = useState<AbsenceStatus | 'all'>('all')
  const [showNewForm, setShowNewForm] = useState(false)

  const isAdminOrHr = user?.role === 'admin' || user?.role === 'hr_manager' || user?.role === 'hr_officer'

  const { data: absenceTypes = [] } = useQuery<AbsenceType[]>({
    queryKey: ['absence-types'],
    queryFn: async () => (await api.get('/settings/absence-types')).data.data ?? [],
    staleTime: 0,
  })

  const { data: absences, isLoading } = useQuery<Absence[]>({
    queryKey: ['absences-all'],
    queryFn: async () => {
      const res = await api.get('/absences')
      return res.data.data ?? []
    },
  })

  const { data: balances } = useQuery<AbsenceBalance[]>({
    queryKey: ['absence-balances-me'],
    queryFn: async () => {
      if (!user) return []
      const res = await api.get(`/absences/employees/${user.id}/balances`)
      return res.data.data ?? []
    },
    enabled: !!user,
  })

  const { data: employees } = useQuery<EmployeeOption[]>({
    queryKey: ['employees-simple'],
    queryFn: async () => {
      const res = await api.get('/employees?limit=200')
      return (res.data.data ?? []).map((e: { id: string; firstName: string; lastName: string }) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
      }))
    },
    enabled: isAdminOrHr,
  })

  const approveMutation = useMutation({
    mutationFn: async ({ id, approved }: { id: string; approved: boolean }) => {
      await api.patch(`/absences/${id}/${approved ? 'approve' : 'reject'}`)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['absences-all'] }),
  })

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<NewAbsenceForm>({
    resolver: zodResolver(newAbsenceSchema),
    defaultValues: { halfDay: false },
  })

  const createMutation = useMutation({
    mutationFn: async (data: NewAbsenceForm) => {
      const payload: Record<string, unknown> = {
        absenceTypeCode: data.absenceTypeCode,
        startDate: data.startDate,
        endDate: data.endDate,
        halfDay: data.halfDay,
        reason: data.reason,
      }
      if (isAdminOrHr && data.employeeId) {
        payload.employeeId = data.employeeId
      }
      await api.post('/absences', payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['absences-all'] })
      queryClient.invalidateQueries({ queryKey: ['absence-balances-me'] })
      setShowNewForm(false)
      reset()
    },
  })

  const filtered = absences?.filter(
    (a) => filterStatus === 'all' || a.status === filterStatus
  ) ?? []

  const halfDayVal = watch('halfDay')

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Absences & Congés</h1>
          <p className="text-sm text-gray-500 mt-1">Gestion des demandes et des soldes</p>
        </div>
        <button
          onClick={() => setShowNewForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nouvelle demande
        </button>
      </div>

      {/* Balances */}
      {balances && balances.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {balances.slice(0, 4).map((balance) => {
            const remaining = Number(balance.acquired) - Number(balance.taken)
            const pct = Number(balance.acquired) > 0
              ? Math.min(100, (Number(balance.taken) / Number(balance.acquired)) * 100)
              : 0
            return (
              <motion.div
                key={balance.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-xl border border-gray-200 p-4"
              >
                <p className="text-xs text-gray-500 font-medium truncate">{balance.absenceTypeId}</p>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-2xl font-bold text-gray-900">{remaining}</span>
                  <span className="text-xs text-gray-400">jours</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full mt-2">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {Number(balance.taken)}/{Number(balance.acquired)} pris
                </p>
              </motion.div>
            )
          })}
        </div>
      )}

      {/* New absence modal */}
      <AnimatePresence>
        {showNewForm && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowNewForm(false)}
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
                      <Calendar className="w-4 h-4 text-indigo-600" />
                    </div>
                    <h2 className="text-base font-semibold text-gray-900">Nouvelle demande d'absence</h2>
                  </div>
                  <button
                    onClick={() => { setShowNewForm(false); reset() }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                  {isAdminOrHr && employees && employees.length > 0 && (
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Collaborateur</label>
                      <select
                        {...register('employeeId')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="">— Moi-même —</option>
                        {employees.map((e) => (
                          <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Type d'absence *</label>
                    <select
                      {...register('absenceTypeCode')}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                    >
                      <option value="">Sélectionner un type</option>
                      {absenceTypes.map((t) => (
                        <option key={t.code} value={t.code}>{t.label}</option>
                      ))}
                    </select>
                    {errors.absenceTypeCode && (
                      <p className="text-xs text-red-500 mt-1">{errors.absenceTypeCode.message}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Date de début *</label>
                      <input
                        type="date"
                        {...register('startDate')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors.startDate && (
                        <p className="text-xs text-red-500 mt-1">{errors.startDate.message}</p>
                      )}
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Date de fin *</label>
                      <input
                        type="date"
                        {...register('endDate')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors.endDate && (
                        <p className="text-xs text-red-500 mt-1">{errors.endDate.message}</p>
                      )}
                    </div>
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      {...register('halfDay')}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700">Demi-journée</span>
                    {halfDayVal && <span className="text-xs text-indigo-600 font-medium">0,5 jour</span>}
                  </label>

                  <div>
                    <label className="text-xs font-medium text-gray-700 block mb-1.5">Motif (optionnel)</label>
                    <textarea
                      {...register('reason')}
                      rows={2}
                      placeholder="Précisez si nécessaire..."
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
                      onClick={() => { setShowNewForm(false); reset() }}
                      className="flex-1 py-2.5 border border-gray-300 text-sm font-medium text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={createMutation.isPending}
                      className="flex-1 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                    >
                      {createMutation.isPending ? 'Envoi...' : 'Soumettre'}
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-gray-400" />
        {(['all', 'pending', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
              filterStatus === s
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            )}
          >
            {s === 'all' ? 'Toutes' : s === 'pending' ? 'En attente' : s === 'approved' ? 'Approuvées' : 'Refusées'}
          </button>
        ))}
      </div>

      {/* Absence list */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="p-4 animate-pulse flex items-center gap-4">
                <div className="w-8 h-8 bg-gray-200 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-gray-200 rounded w-1/3" />
                  <div className="h-2 bg-gray-100 rounded w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <Calendar className="w-10 h-10 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Aucune absence trouvée</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((absence) => {
              const StatusIcon = STATUS_ICONS[absence.status as AbsenceStatus] ?? Clock
              return (
                <div key={absence.id} className="flex items-center justify-between p-4 hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-indigo-50 rounded-full flex items-center justify-center">
                      <Calendar className="w-4 h-4 text-indigo-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {formatDate(absence.startDate)} — {formatDate(absence.endDate)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {absence.daysCount} jour(s) · {absence.absenceTypeId}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      'flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium',
                      getStatusColor(absence.status)
                    )}>
                      <StatusIcon className="w-3 h-3" />
                      {absence.status === 'pending' ? 'En attente' :
                       absence.status === 'approved' ? 'Approuvée' :
                       absence.status === 'rejected' ? 'Refusée' : 'Annulée'}
                    </span>
                    {absence.status === 'pending' && isAdminOrHr && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => approveMutation.mutate({ id: absence.id, approved: true })}
                          className="p-1.5 bg-green-50 text-green-600 rounded-lg hover:bg-green-100"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => approveMutation.mutate({ id: absence.id, approved: false })}
                          className="p-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
