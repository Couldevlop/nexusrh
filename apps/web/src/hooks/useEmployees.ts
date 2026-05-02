import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import type { Employee, EmployeeListItem, PaginatedResponse } from '@nexusrh/shared'

export function useEmployees(params: {
  page?: number
  limit?: number
  search?: string
  status?: string
  departmentId?: string
} = {}) {
  return useQuery({
    queryKey: ['employees', params],
    queryFn: async () => {
      const response = await api.get<PaginatedResponse<EmployeeListItem>>('/employees', {
        params,
      })
      return response.data
    },
  })
}

export function useEmployee(id: string) {
  return useQuery({
    queryKey: ['employees', id],
    queryFn: async () => {
      const response = await api.get<{ data: Employee }>(`/employees/${id}`)
      return response.data.data
    },
    enabled: !!id,
  })
}

export function useCreateEmployee() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const response = await api.post<{ data: Employee }>('/employees', data)
      return response.data.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

export function useUpdateEmployee(id: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const response = await api.patch<{ data: Employee }>(`/employees/${id}`, data)
      return response.data.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees', id] })
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}
