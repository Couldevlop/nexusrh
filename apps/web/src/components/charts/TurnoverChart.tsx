import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from 'recharts'

interface TurnoverData {
  month: string
  rate: number
  benchmark?: number
}

interface TurnoverChartProps {
  data: TurnoverData[]
  benchmarkLabel?: string
}

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean
  payload?: { value: number; name: string; color: string }[]
  label?: string
}) => {
  if (!active || !payload) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold text-gray-800 mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-600">{p.name} :</span>
          <span className="font-medium">{p.value.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

export function TurnoverChart({ data, benchmarkLabel = 'Benchmark secteur' }: TurnoverChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 12, fill: '#9CA3AF' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 12, fill: '#9CA3AF' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={15} stroke="#FCD34D" strokeDasharray="4 4" label={{ value: 'Alerte 15%', fontSize: 10, fill: '#D97706' }} />
        <Line
          type="monotone"
          dataKey="rate"
          name="Turnover"
          stroke="#6366F1"
          strokeWidth={2}
          dot={{ r: 4, fill: '#6366F1' }}
          activeDot={{ r: 6 }}
        />
        {data[0]?.benchmark !== undefined && (
          <Line
            type="monotone"
            dataKey="benchmark"
            name={benchmarkLabel}
            stroke="#D1D5DB"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  )
}
