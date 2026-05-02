import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import type { Absence, AbsenceBalance } from '@nexusrh/shared'

export function useAbsences(employeeId: string) {
  return useQuery({
    queryKey: ['absences', employeeId],
    queryFn: async () => {
      const response = await api.get<{ data: Absence[] }>(
        `/absences/employee/${employeeId}`
      )
      return response.data.data
    },
    enabled: !!employeeId,
  })
}

export function useAbsenceBalances(employeeId: string) {
  return useQuery({
    queryKey: ['absenceBalances', employeeId],
    queryFn: async () => {
      const response = await api.get<{ data: AbsenceBalance[] }>(
        `/absences/employee/${employeeId}/balances`
      )
      return response.data.data
    },
    enabled: !!employeeId,
  })
}

export function useRequestAbsence() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: {
      employeeId: string
      absenceTypeId: string
      startDate: string
      endDate: string
      reason?: string
    }) => {
      const response = await api.post('/absences', data)
      return response.data.data
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['absences', variables.employeeId] })
      queryClient.invalidateQueries({
        queryKey: ['absenceBalances', variables.employeeId],
      })
    },
  })
}

export function useApproveAbsence() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      id,
      approved,
      rejectionReason,
    }: {
      id: string
      approved: boolean
      rejectionReason?: string
    }) => {
      const response = await api.patch(`/absences/${id}/approve`, {
        approved,
        rejectionReason,
      })
      return response.data.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['absences'] })
    },
  })
}
