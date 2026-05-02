import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { formatNumber } from '@/lib/utils'

interface HeadcountChartProps {
  data: Array<{ month: string; count: number }>
}

const CustomTooltip = ({
  active, payload, label,
}: {
  active?: boolean
  payload?: Array<{ value: number }>
  label?: string
}) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3">
      <p className="text-sm font-medium text-gray-700">{label}</p>
      <p className="text-lg font-bold text-indigo-600">
        {formatNumber(payload[0]?.value ?? 0)} salariés
      </p>
    </div>
  )
}

export function HeadcountChart({ data }: HeadcountChartProps) {
  const lastValue = data[data.length - 1]?.count ?? 0
  const prevValue = data[data.length - 2]?.count ?? 0
  const delta = lastValue - prevValue

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-gray-900">
          {formatNumber(lastValue)}
        </span>
        <span
          className={`text-sm font-medium ${delta >= 0 ? 'text-green-600' : 'text-red-600'}`}
        >
          {delta >= 0 ? '+' : ''}{delta} ce mois
        </span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="count"
            stroke="#4F46E5"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 5, fill: '#4F46E5' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
