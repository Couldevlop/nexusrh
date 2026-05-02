import { TrendingUp, TrendingDown, Minus, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RetentionScoreProps {
  score: number | null
  factors?: string[]
  compact?: boolean
}

export function RetentionScore({ score, factors, compact = false }: RetentionScoreProps) {
  if (score === null) return null

  const pct = Math.round(score * 100)

  const level = pct >= 70 ? 'high' : pct >= 50 ? 'medium' : 'low'

  const colors = {
    high: { bar: 'bg-green-500', text: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200' },
    medium: { bar: 'bg-yellow-500', text: 'text-yellow-700', bg: 'bg-yellow-50', border: 'border-yellow-200' },
    low: { bar: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' },
  }

  const Icon = pct >= 70 ? TrendingUp : pct >= 50 ? Minus : TrendingDown
  const c = colors[level]

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full max-w-[80px]">
          <div
            className={cn('h-full rounded-full', c.bar)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={cn('text-xs font-medium', c.text)}>{pct}%</span>
      </div>
    )
  }

  return (
    <div className={cn('rounded-lg border p-4', c.bg, c.border)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className={cn('w-4 h-4', c.text)} />
          <span className={cn('text-sm font-semibold', c.text)}>
            Score de rétention : {pct}%
          </span>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-gray-400 cursor-help" />
          <div className="absolute right-0 top-6 hidden group-hover:block z-10 bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-64 text-xs text-gray-600">
            Probabilité estimée par l'IA que ce collaborateur reste dans les 6 prochains mois.
          </div>
        </div>
      </div>
      <div className="h-2 bg-white/60 rounded-full">
        <div
          className={cn('h-full rounded-full transition-all duration-700', c.bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {factors && factors.length > 0 && (
        <div className="mt-3 space-y-1">
          <p className="text-xs font-medium text-gray-600">Facteurs clés :</p>
          {factors.slice(0, 3).map((factor, i) => (
            <p key={i} className={cn('text-xs', c.text)}>• {factor}</p>
          ))}
        </div>
      )}
    </div>
  )
}
