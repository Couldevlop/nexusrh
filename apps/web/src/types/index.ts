// Re-export shared types
export type * from '@nexusrh/shared'

// Frontend-specific types
export interface TableColumn<T> {
  key: keyof T | string
  header: string
  render?: (value: unknown, row: T) => React.ReactNode
  sortable?: boolean
  width?: string
}

export interface Notification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  read: boolean
  createdAt: string
}

export interface NavItem {
  id: string
  label: string
  path: string
  icon: React.ElementType
  badge?: number
  roles?: string[]
  children?: NavItem[]
}

export interface QuickAction {
  id: string
  label: string
  icon: React.ElementType
  onClick: () => void
  color?: string
}
