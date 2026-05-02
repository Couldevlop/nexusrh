import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Receipt, Check, X, Clock, AlertCircle, Trash2 } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import api from '@/lib/api'
import { formatCurrency, formatDate, getStatusColor, cn } from '@/lib/utils'

interface ExpenseReport {
  id: string
  title: string
  totalAmount: string
  currency: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid'
  submittedAt: string | null
  createdAt: string
  employeeName?: string
}

const STATUS_LABELS = {
  draft: 'Brouillon',
  submitted: 'Soumis',
  approved: 'Approuvé',
  rejected: 'Refusé',
  paid: 'Remboursé',
}

const STATUS_ICONS = {
  draft: Clock,
  submitted: Clock,
  approved: Check,
  rejected: X,
  paid: Check,
}

interface ExpenseCategory { id: string; code: string; label: string; color: string | null }

const expenseLineSchema = z.object({
  description: z.string().min(1, 'Requis'),
  category: z.string().min(1, 'Requis'),
  amountHT: z.number().min(0.01, 'Montant requis'),
  vatRate: z.number().min(0).max(100).default(20),
})

const newExpenseSchema = z.object({
  title: z.string().min(2, 'Titre requis'),
  expenseDate: z.string().min(1, 'Date requise'),
  submitNow: z.boolean().default(false),
  lines: z.array(expenseLineSchema).min(1, 'Au moins une ligne requise'),
})

type NewExpenseForm = z.infer<typeof newExpenseSchema>

export function ExpensesPage() {
  const queryClient = useQueryClient()
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [showModal, setShowModal] = useState(false)

  const { data: expenseCategories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ['settings-parameters', 'expense_category'],
    queryFn: async () => (await api.get('/settings/parameters?category=expense_category')).data.data ?? [],
    staleTime: 0,
  })

  const { data: reports, isLoading } = useQuery<ExpenseReport[]>({
    queryKey: ['expense-reports'],
    queryFn: async () => {
      const res = await api.get('/expenses/reports')
      return res.data.data ?? []
    },
  })

  const approveMutation = useMutation({
    mutationFn: async ({ id, approved }: { id: string; approved: boolean }) => {
      await api.patch(`/expenses/reports/${id}/${approved ? 'approve' : 'reject'}`)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expense-reports'] }),
  })

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<NewExpenseForm>({
    resolver: zodResolver(newExpenseSchema),
    defaultValues: {
      submitNow: false,
      lines: [{ description: '', category: 'Transport', amountHT: 0, vatRate: 20 }],
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'lines' })

  const watchedLines = watch('lines')
  const totalTTC = watchedLines?.reduce((sum, l) => {
    const ht = Number(l.amountHT) || 0
    const vat = Number(l.vatRate) || 0
    return sum + ht * (1 + vat / 100)
  }, 0) ?? 0

  const createMutation = useMutation({
    mutationFn: async (data: NewExpenseForm) => {
      await api.post('/expenses/reports', {
        title: data.title,
        expenseDate: data.expenseDate,
        submitNow: data.submitNow,
        lines: data.lines.map((l) => ({
          description: l.description,
          category: l.category,
          amountHT: l.amountHT,
          vatRate: l.vatRate,
          amountTTC: l.amountHT * (1 + l.vatRate / 100),
        })),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expense-reports'] })
      setShowModal(false)
      reset()
    },
  })

  const filtered = reports?.filter(
    (r) => filterStatus === 'all' || r.status === filterStatus
  ) ?? []

  const totalPending = reports
    ?.filter(r => r.status === 'submitted')
    .reduce((s, r) => s + Number(r.totalAmount), 0) ?? 0

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Notes de frais</h1>
          <p className="text-sm text-gray-500 mt-1">Déclarations et validations</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nouvelle déclaration
        </button>
      </div>

      {/* New expense modal */}
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
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-100 rounded-xl flex items-center justify-center">
                      <Receipt className="w-4 h-4 text-indigo-600" />
                    </div>
                    <h2 className="text-base font-semibold text-gray-900">Nouvelle note de frais</h2>
                  </div>
                  <button
                    onClick={() => { setShowModal(false); reset() }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Titre *</label>
                      <input
                        {...register('title')}
                        placeholder="ex. Déplacement client Lyon"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors.title && <p className="text-xs text-red-500 mt-1">{errors.title.message}</p>}
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1.5">Date *</label>
                      <input
                        type="date"
                        {...register('expenseDate')}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      {errors.expenseDate && <p className="text-xs text-red-500 mt-1">{errors.expenseDate.message}</p>}
                    </div>
                  </div>

                  {/* Lines */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-medium text-gray-700">Lignes de frais *</label>
                      <button
                        type="button"
                        onClick={() => append({ description: '', category: 'Transport', amountHT: 0, vatRate: 20 })}
                        className="flex items-center gap-1 text-xs text-indigo-600 font-medium hover:text-indigo-800"
                      >
                        <Plus className="w-3.5 h-3.5" /> Ajouter une ligne
                      </button>
                    </div>

                    <div className="space-y-2">
                      {fields.map((field, idx) => (
                        <div key={field.id} className="bg-gray-50 rounded-xl p-3 space-y-2">
                          <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2">
                              <input
                                {...register(`lines.${idx}.description`)}
                                placeholder="Description de la dépense"
                                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                              />
                            </div>
                            <select
                              {...register(`lines.${idx}.category`)}
                              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                            >
                              {expenseCategories.map((c) => (
                                <option key={c.code} value={c.code}>{c.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="grid grid-cols-3 gap-2 items-center">
                            <div>
                              <label className="text-[10px] text-gray-400 block mb-0.5">Montant HT (€)</label>
                              <input
                                type="number"
                                step="0.01"
                                {...register(`lines.${idx}.amountHT`, { valueAsNumber: true })}
                                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-gray-400 block mb-0.5">TVA (%)</label>
                              <select
                                {...register(`lines.${idx}.vatRate`, { valueAsNumber: true })}
                                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                              >
                                <option value={0}>0%</option>
                                <option value={5.5}>5,5%</option>
                                <option value={10}>10%</option>
                                <option value={20}>20%</option>
                              </select>
                            </div>
                            <div className="flex items-end gap-2 pb-0.5">
                              <div className="flex-1">
                                <p className="text-[10px] text-gray-400 mb-0.5">TTC</p>
                                <p className="text-sm font-semibold text-gray-900">
                                  {formatCurrency(
                                    (Number(watchedLines?.[idx]?.amountHT) || 0) *
                                    (1 + (Number(watchedLines?.[idx]?.vatRate) || 0) / 100)
                                  )}
                                </p>
                              </div>
                              {fields.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => remove(idx)}
                                  className="text-red-400 hover:text-red-600 transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {errors.lines && !Array.isArray(errors.lines) && (
                      <p className="text-xs text-red-500 mt-1">{errors.lines.message}</p>
                    )}
                  </div>

                  {/* Total */}
                  <div className="bg-indigo-50 rounded-xl px-4 py-3 flex items-center justify-between">
                    <span className="text-sm font-medium text-indigo-800">Total TTC</span>
                    <span className="text-lg font-bold text-indigo-900">{formatCurrency(totalTTC)}</span>
                  </div>

                  {/* Submit option */}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      {...register('submitNow')}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700">Soumettre immédiatement pour validation</span>
                  </label>

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
                      {createMutation.isPending ? 'Enregistrement...' : 'Enregistrer'}
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
          <p className="text-xs text-gray-500">En attente</p>
          <p className="text-2xl font-bold text-yellow-600">
            {reports?.filter(r => r.status === 'submitted').length ?? 0}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Montant en attente</p>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(totalPending)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Approuvées ce mois</p>
          <p className="text-2xl font-bold text-green-600">
            {reports?.filter(r => r.status === 'approved' || r.status === 'paid').length ?? 0}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total remboursé</p>
          <p className="text-2xl font-bold text-indigo-700">
            {formatCurrency(reports?.filter(r => r.status === 'paid').reduce((s, r) => s + Number(r.totalAmount), 0) ?? 0)}
          </p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        {(['all', 'submitted', 'approved', 'rejected', 'paid'] as const).map((s) => (
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
            {s === 'all' ? 'Toutes' : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="p-4 animate-pulse flex items-center gap-4">
              <div className="w-8 h-8 bg-gray-200 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-1/3" />
                <div className="h-2 bg-gray-100 rounded w-1/4" />
              </div>
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <Receipt className="w-10 h-10 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Aucune note de frais</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((report) => {
              const Icon = STATUS_ICONS[report.status] ?? Clock
              return (
                <div key={report.id} className="flex items-center justify-between p-4 hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-indigo-50 rounded-lg flex items-center justify-center">
                      <Receipt className="w-4 h-4 text-indigo-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{report.title}</p>
                      <p className="text-xs text-gray-500">
                        {report.employeeName && `${report.employeeName} · `}
                        {report.submittedAt ? formatDate(report.submittedAt) : formatDate(report.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-gray-900">
                      {formatCurrency(Number(report.totalAmount))}
                    </span>
                    <span className={cn(
                      'flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium',
                      getStatusColor(report.status)
                    )}>
                      <Icon className="w-3 h-3" />
                      {STATUS_LABELS[report.status]}
                    </span>
                    {report.status === 'submitted' && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => approveMutation.mutate({ id: report.id, approved: true })}
                          className="p-1.5 bg-green-50 text-green-600 rounded-lg hover:bg-green-100"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => approveMutation.mutate({ id: report.id, approved: false })}
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
