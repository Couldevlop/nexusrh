import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import type { PaySlip } from '@nexusrh/shared'

export function usePaySlips(employeeId: string) {
  return useQuery({
    queryKey: ['payslips', employeeId],
    queryFn: async () => {
      const response = await api.get<{ data: PaySlip[] }>(
        `/payroll/payslips/employee/${employeeId}`
      )
      return response.data.data
    },
    enabled: !!employeeId,
  })
}

export function useCalculatePaySlip() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      employeeId,
      periodId,
    }: {
      employeeId: string
      periodId: string
    }) => {
      const response = await api.post('/payroll/calculate', {
        employeeId,
        periodId,
      })
      return response.data
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['payslips', variables.employeeId] })
    },
  })
}

export function usePayrollRules(entityId: string) {
  return useQuery({
    queryKey: ['payrollRules', entityId],
    queryFn: async () => {
      const response = await api.get('/payroll/rules', { params: { entityId } })
      return response.data.data
    },
    enabled: !!entityId,
  })
}
