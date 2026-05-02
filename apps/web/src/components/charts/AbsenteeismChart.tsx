import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts'

interface AbsenteeismData {
  month: string
  sick: number
  vacation: number
  other: number
}

interface AbsenteeismChartProps {
  data: AbsenteeismData[]
}

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean
  payload?: { value: number; name: string; color: string }[]
  label?: string
}) => {
  if (!active || !payload) return null
  const total = payload.reduce((s, p) => s + p.value, 0)
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-600">{p.name} :</span>
          <span className="font-medium">{p.value.toFixed(1)} j</span>
        </div>
      ))}
      <div className="border-t border-gray-100 mt-1.5 pt-1.5">
        <span className="text-gray-500">Total : </span>
        <span className="font-semibold">{total.toFixed(1)} j</span>
      </div>
    </div>
  )
}

export function AbsenteeismChart({ data }: AbsenteeismChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
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
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: '12px', color: '#6B7280' }}
          formatter={(value) => value}
        />
        <Bar dataKey="sick" name="Maladie" stackId="a" fill="#F87171" radius={[0, 0, 0, 0]} />
        <Bar dataKey="vacation" name="Congés" stackId="a" fill="#60A5FA" radius={[0, 0, 0, 0]} />
        <Bar dataKey="other" name="Autre" stackId="a" fill="#A78BFA" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
