import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'

const CECRL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
type CecrlLevel = (typeof CECRL_LEVELS)[number]
const COMMON_METHODOLOGIES = ['Scrum', 'Agile', 'SAFe', 'Kanban', 'Waterfall']

interface Technology { name: string; yearsRequired: number }
interface Language { language: string; level: CecrlLevel }
interface InterviewFocus {
  technologies: Technology[]
  tools: string[]
  methodologies: string[]
  languages: Language[]
}
const EMPTY_FOCUS: InterviewFocus = { technologies: [], tools: [], methodologies: [], languages: [] }

interface InterviewFocusPanelProps {
  /** Endpoint complet, ex: `/recruitment/jobs/${id}/interview-focus` ou `/employees/${id}/interview-focus`. */
  endpoint: string
  /** Identifiant utilisé pour la clé de cache React Query (job id ou employee id). */
  queryKeyId: string
}

export function InterviewFocusPanel({ endpoint, queryKeyId }: InterviewFocusPanelProps) {
  const { t } = useTranslation('interviewFocus')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<InterviewFocus | null>(null)
  const [toolsText, setToolsText] = useState('')
  const [otherMethodologies, setOtherMethodologies] = useState('')
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery<{ data: { focus: InterviewFocus } }>({
    queryKey: ['interview-focus', queryKeyId],
    queryFn: () => api.get(endpoint).then((r) => r.data),
    enabled: open,
  })

  if (open && data && focus === null) {
    const f = data.data.focus
    setFocus(f)
    setToolsText(f.tools.join(', '))
    setOtherMethodologies(f.methodologies.filter((m) => !COMMON_METHODOLOGIES.includes(m)).join(', '))
  }

  const save = useMutation({
    mutationFn: (payload: InterviewFocus) => api.put(endpoint, { focus: payload }),
    onSuccess: () => {
      setSaved(true)
      queryClient.invalidateQueries({ queryKey: ['interview-focus', queryKeyId] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const set = (patch: Partial<InterviewFocus>) => setFocus((prev) => (prev ? { ...prev, ...patch } : prev))

  const addTechnology = () => focus && set({ technologies: [...focus.technologies, { name: '', yearsRequired: 0 }] })
  const removeTechnology = (i: number) => focus && set({ technologies: focus.technologies.filter((_, idx) => idx !== i) })
  const moveTechnology = (i: number, dir: -1 | 1) => {
    if (!focus || i < 0 || i >= focus.technologies.length) return
    const arr = [...focus.technologies]
    const j = i + dir
    if (j < 0 || j >= arr.length) return
    const temp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = temp
    set({ technologies: arr })
  }
  const updateTechnology = (i: number, patch: Partial<Technology>) => {
    if (!focus) return
    const arr = focus.technologies.map((t, idx) => (idx === i ? { ...t, ...patch } : t))
    set({ technologies: arr })
  }

  const addLanguage = () => focus && set({ languages: [...focus.languages, { language: '', level: 'B1' as CecrlLevel }] })
  const removeLanguage = (i: number) => focus && set({ languages: focus.languages.filter((_, idx) => idx !== i) })
  const updateLanguage = (i: number, patch: Partial<Language>) => {
    if (!focus) return
    const arr = focus.languages.map((l, idx) => (idx === i ? { ...l, ...patch } : l))
    set({ languages: arr })
  }

  const toggleMethodology = (m: string) => {
    if (!focus) return
    const has = focus.methodologies.includes(m)
    set({ methodologies: has ? focus.methodologies.filter((x) => x !== m) : [...focus.methodologies, m] })
  }

  const handleSave = () => {
    if (!focus) return
    const tools = toolsText.split(',').map((x) => x.trim()).filter(Boolean)
    const extraMethodologies = otherMethodologies.split(',').map((x) => x.trim()).filter(Boolean)
    const commonSelected = focus.methodologies.filter((m) => COMMON_METHODOLOGIES.includes(m))
    save.mutate({
      technologies: focus.technologies.filter((t) => t.name.trim().length > 0),
      tools,
      methodologies: [...commonSelected, ...extraMethodologies],
      languages: focus.languages.filter((l) => l.language.trim().length > 0),
    })
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        <Sparkles className="h-3.5 w-3.5" />
        {open ? t('panel.hide') : t('panel.configure')}
      </button>

      {open && (
        <div className="mt-3">
          {isLoading || !focus ? (
            <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="space-y-4">
              <p className="text-[11px] text-muted-foreground">{t('panel.intro')}</p>

              <div>
                <span className="mb-1 block text-xs font-medium">{t('technologies.title')}</span>
                <div className="space-y-2">
                  {focus.technologies.map((tech, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={tech.name}
                        onChange={(e) => updateTechnology(i, { name: e.target.value })}
                        placeholder={t('technologies.namePlaceholder')}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <input
                        type="number" min={0} max={40} value={tech.yearsRequired}
                        onChange={(e) => updateTechnology(i, { yearsRequired: parseInt(e.target.value, 10) || 0 })}
                        title={t('technologies.yearsLabel')}
                        className="w-20 rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:border-primary"
                      />
                      <button type="button" onClick={() => moveTechnology(i, -1)} className="text-xs text-muted-foreground">↑</button>
                      <button type="button" onClick={() => moveTechnology(i, 1)} className="text-xs text-muted-foreground">↓</button>
                      <button type="button" onClick={() => removeTechnology(i)} className="text-xs text-red-600">{t('technologies.remove')}</button>
                    </div>
                  ))}
                  <button type="button" onClick={addTechnology} className="text-xs font-medium text-primary hover:underline">
                    {t('technologies.add')}
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium">{t('tools.title')}</span>
                <input
                  value={toolsText}
                  onChange={(e) => setToolsText(e.target.value)}
                  placeholder={t('tools.placeholder')}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>

              <div>
                <span className="mb-1 block text-xs font-medium">{t('methodologies.title')}</span>
                <div className="flex flex-wrap gap-3 mb-2">
                  {COMMON_METHODOLOGIES.map((m) => (
                    <label key={m} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={focus.methodologies.includes(m)}
                        onChange={() => toggleMethodology(m)}
                        className="h-4 w-4 rounded border-border"
                      />
                      {m}
                    </label>
                  ))}
                </div>
                <input
                  value={otherMethodologies}
                  onChange={(e) => setOtherMethodologies(e.target.value)}
                  placeholder={t('methodologies.otherPlaceholder')}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </div>

              <div>
                <span className="mb-1 block text-xs font-medium">{t('languages.title')}</span>
                <div className="space-y-2">
                  {focus.languages.map((lang, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={lang.language}
                        onChange={(e) => updateLanguage(i, { language: e.target.value })}
                        placeholder={t('languages.languagePlaceholder')}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <select
                        value={lang.level}
                        onChange={(e) => updateLanguage(i, { level: e.target.value as CecrlLevel })}
                        className="rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:border-primary"
                      >
                        {CECRL_LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>{t(`languages.level.${lvl}`)}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => removeLanguage(i)} className="text-xs text-red-600">{t('languages.remove')}</button>
                    </div>
                  ))}
                  <button type="button" onClick={addLanguage} className="text-xs font-medium text-primary hover:underline">
                    {t('languages.add')}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                {saved && <span className="text-xs text-emerald-600">{t('panel.saved')}</span>}
                {save.isError && <span className="text-xs text-red-600">{t('panel.saveError')}</span>}
                <button
                  onClick={handleSave}
                  disabled={save.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {t('panel.saveButton')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
