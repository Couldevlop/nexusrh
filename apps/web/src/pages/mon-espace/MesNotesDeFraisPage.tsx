import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, X, Receipt, Trash2, Send, Save } from 'lucide-react'
import api from '@/lib/api'
import { formatCurrency, cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExpenseItem {
  description: string
  amountHt: number
  tva: number
  amountTtc: number
}

interface Expense {
  id: string
  title: string
  date: string
  category: string
  status: 'draft' | 'submitted' | 'approved' | 'reimbursed' | 'rejected'
  totalAmount: number
  submittedAt: string | null
  items: ExpenseItem[]
}

// ─── Schema Zod ─────────────────────────────────────────────────────────────

const expenseItemSchema = z.object({
  description: z.string().min(1, 'Description requise'),
  amountHt: z.coerce.number().min(0, 'Montant invalide'),
  tva: z.coerce.number().min(0).max(100),
  amountTtc: z.coerce.number().min(0, 'Montant TTC invalide'),
})

const expenseSchema = z.object({
  title: z.string().min(1, 'Titre requis'),
  date: z.string().min(1, 'Date requise'),
  category: z.string().min(1, 'Catégorie requise'),
  items: z.array(expenseItemSchema).min(1, 'Au moins une ligne requise'),
})

type ExpenseFormData = z.infer<typeof expenseSchema>

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft: 'Brouillon',
  submitted: 'Soumise',
  approved: 'Approuvée',
  reimbursed: 'Remboursée',
  rejected: 'Refusée',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  reimbursed: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
}

interface ExpenseCategory { id: string; code: string; label: string }

// ─── Component ───────────────────────────────────────────────────────────────

export function MesNotesDeFraisPage() {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: expenseCategories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ['settings-parameters', 'expense_category'],
    queryFn: async () => (await api.get('/settings/parameters?category=expense_category')).data.data ?? [],
    staleTime: 0,
  })

  const { data: expenses, isLoading } = useQuery<Expense[]>({
    queryKey: ['my-expenses'],
    queryFn: async () => {
      const res = await api.get<{ data: Expense[] }>('/expenses/my-expenses')
      return res.data.data
    },
  })

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ExpenseFormData>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      category: 'autre',
      items: [{ description: '', amountHt: 0, tva: 20, amountTtc: 0 }],
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  const createMutation = useMutation({
    mutationFn: async ({ data, submit }: { data: ExpenseFormData; submit: boolean }) => {
      const res = await api.post<{ data: { id: string } }>('/expenses/reports', {
        title: data.title,
        expenseDate: data.date,
        submitNow: submit,
        lines: data.items.map((item) => ({
          description: item.description,
          category: data.category,
          amountHT: item.amountHt,
          vatRate: item.tva,
          amountTTC: item.amountTtc,
        })),
      })
      return res.data.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-expenses'] })
      setShowForm(false)
      reset()
    },
  })

  const submitMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.patch(`/expenses/reports/${id}/submit`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-expenses'] })
    },
  })

  function watchItems() {
    return watch('items') ?? []
  }

  function computeTotal() {
    return watchItems().reduce((sum, item) => sum + (Number(item.amountTtc) || 0), 0)
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mes notes de frais</h1>
          <p className="text-sm text-gray-500 mt-1">Déclarez et suivez vos frais professionnels</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nouvelle note
        </button>
      </div>

      {/* List */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      >
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : (expenses ?? []).length === 0 ? (
          <div className="text-center py-16">
            <Receipt className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">Aucune note de frais</p>
            <p className="text-sm text-gray-400 mt-1">
              Créez votre première note de frais pour commencer.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {(expenses ?? []).map((e, idx) => (
              <motion.div
                key={e.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
              >
                <div
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                >
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                    <Receipt className="w-5 h-5 text-indigo-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{e.title}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(e.date).toLocaleDateString('fr-FR')} ·{' '}
                      {expenseCategories.find((c) => c.code === e.category)?.label ?? e.category}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-gray-900 flex-shrink-0">
                    {formatCurrency(Number(e.totalAmount))}
                  </p>
                  <span
                    className={cn(
                      'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
                      STATUS_COLORS[e.status] ?? 'bg-gray-100 text-gray-600'
                    )}
                  >
                    {STATUS_LABELS[e.status] ?? e.status}
                  </span>
                  {e.status === 'draft' && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        submitMutation.mutate(e.id)
                      }}
                      disabled={submitMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      <Send className="w-3 h-3" />
                      Soumettre
                    </button>
                  )}
                </div>

                <AnimatePresence>
                  {expandedId === e.id && e.items && e.items.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden bg-gray-50 border-t border-gray-100"
                    >
                      <div className="px-5 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500 font-medium">
                              <th className="text-left py-1.5">Description</th>
                              <th className="text-right py-1.5">HT</th>
                              <th className="text-right py-1.5">TVA %</th>
                              <th className="text-right py-1.5">TTC</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {e.items.map((item, i) => (
                              <tr key={i} className="text-gray-700">
                                <td className="py-1.5">{item.description}</td>
                                <td className="text-right py-1.5">{formatCurrency(Number(item.amountHt))}</td>
                                <td className="text-right py-1.5">{item.tva}%</td>
                                <td className="text-right py-1.5 font-medium">
                                  {formatCurrency(Number(item.amountTtc))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      {/* Form modal */}
      <AnimatePresence>
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between p-6 border-b border-gray-100 sticky top-0 bg-white z-10">
                <h3 className="text-lg font-semibold text-gray-900">Nouvelle note de frais</h3>
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

              <form className="p-6 space-y-5">
                {/* Title + date */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Titre <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      {...register('title')}
                      placeholder="Ex : Déplacement client Paris"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errors.title && (
                      <p className="text-xs text-red-500 mt-1">{errors.title.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      {...register('date')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {errors.date && (
                      <p className="text-xs text-red-500 mt-1">{errors.date.message}</p>
                    )}
                  </div>
                </div>

                {/* Category */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Catégorie <span className="text-red-500">*</span>
                  </label>
                  <select
                    {...register('category')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— Choisir —</option>
                    {expenseCategories.map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>

                {/* Items */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-gray-700">
                      Lignes de frais <span className="text-red-500">*</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => append({ description: '', amountHt: 0, tva: 20, amountTtc: 0 })}
                      className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                    >
                      <Plus className="w-3 h-3" /> Ajouter une ligne
                    </button>
                  </div>

                  {/* En-têtes colonnes */}
                  <div className="grid grid-cols-12 gap-2 mb-1 px-0.5">
                    <p className="col-span-5 text-xs font-medium text-gray-500">Description</p>
                    <p className="col-span-2 text-xs font-medium text-gray-500">Montant HT (€)</p>
                    <p className="col-span-2 text-xs font-medium text-gray-500">TVA (%)</p>
                    <p className="col-span-2 text-xs font-medium text-gray-500">Montant TTC (€)</p>
                    <p className="col-span-1" />
                  </div>

                  <div className="space-y-2">
                    {fields.map((field, i) => (
                      <div key={field.id} className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-5">
                          <input
                            type="text"
                            {...register(`items.${i}.description`)}
                            aria-label="Description de la dépense"
                            placeholder="Ex : Repas client"
                            className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                          {errors.items?.[i]?.description && (
                            <p className="text-xs text-red-500 mt-0.5">{errors.items[i]?.description?.message}</p>
                          )}
                        </div>
                        <div className="col-span-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            {...register(`items.${i}.amountHt`, {
                              onChange: (e) => {
                                const ht = parseFloat(e.target.value) || 0
                                const tva = parseFloat(String(watch(`items.${i}.tva`))) || 0
                                setValue(
                                  `items.${i}.amountTtc`,
                                  parseFloat((ht * (1 + tva / 100)).toFixed(2))
                                )
                              },
                            })}
                            aria-label="Montant hors taxe en euros"
                            placeholder="0.00"
                            className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div className="col-span-2">
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            {...register(`items.${i}.tva`, {
                              onChange: (e) => {
                                const tva = parseFloat(e.target.value) || 0
                                const ht = parseFloat(String(watch(`items.${i}.amountHt`))) || 0
                                setValue(
                                  `items.${i}.amountTtc`,
                                  parseFloat((ht * (1 + tva / 100)).toFixed(2))
                                )
                              },
                            })}
                            aria-label="Taux de TVA en pourcentage"
                            placeholder="20"
                            className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div className="col-span-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            {...register(`items.${i}.amountTtc`)}
                            aria-label="Montant toutes taxes comprises en euros"
                            placeholder="0.00"
                            readOnly
                            className="w-full px-2.5 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700"
                          />
                        </div>
                        <div className="col-span-1 flex justify-center">
                          {fields.length > 1 && (
                            <button
                              type="button"
                              onClick={() => remove(i)}
                              className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                              title="Supprimer cette ligne"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {errors.items && (
                    <p className="text-xs text-red-500 mt-1">
                      {typeof errors.items.message === 'string'
                        ? errors.items.message
                        : 'Veuillez compléter toutes les lignes'}
                    </p>
                  )}

                  {/* Total */}
                  <div className="flex justify-end mt-3 pt-3 border-t border-gray-100">
                    <p className="text-sm font-semibold text-gray-900">
                      Total TTC : {formatCurrency(computeTotal())}
                    </p>
                  </div>
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
                    type="button"
                    disabled={createMutation.isPending}
                    onClick={handleSubmit((data) => createMutation.mutate({ data, submit: false }))}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
                  >
                    <Save className="w-4 h-4" />
                    Sauvegarder brouillon
                  </button>
                  <button
                    type="button"
                    disabled={createMutation.isPending}
                    onClick={handleSubmit((data) => createMutation.mutate({ data, submit: true }))}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
                  >
                    <Send className="w-4 h-4" />
                    {createMutation.isPending ? 'Envoi...' : 'Soumettre'}
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
