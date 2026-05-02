import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'

interface SalaryMassChartProps {
  data: Array<{ department: string; amount: number }>
}

const COLORS = ['#4F46E5', '#7C3AED', '#0EA5E9', '#10B981', '#F59E0B']

export function SalaryMassChart({ data }: SalaryMassChartProps) {
  const total = data.reduce((s, d) => s + d.amount, 0)

  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-500">Masse salariale totale</p>
      <p className="text-2xl font-bold text-gray-900">{formatCurrency(total)}</p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 20, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
          <XAxis
            type="number"
            tick={{ fontSize: 10, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k€`}
          />
          <YAxis
            type="category"
            dataKey="department"
            tick={{ fontSize: 11, fill: '#374151' }}
            axisLine={false}
            tickLine={false}
            width={80}
          />
          <Tooltip
            formatter={(value: number) => [formatCurrency(value), 'Masse salariale']}
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #E5E7EB',
              boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
            }}
          />
          <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
