import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { fr } from 'date-fns/locale'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string | Date, fmt = 'dd/MM/yyyy'): string {
  try {
    const d = typeof date === 'string' ? parseISO(date) : date
    return format(d, fmt, { locale: fr })
  } catch {
    return '-'
  }
}

export function formatDateTime(date: string | Date): string {
  return formatDate(date, 'dd/MM/yyyy à HH:mm')
}

export function formatRelativeDate(date: string | Date): string {
  try {
    const d = typeof date === 'string' ? parseISO(date) : date
    return formatDistanceToNow(d, { locale: fr, addSuffix: true })
  } catch {
    return '-'
  }
}

export function formatCurrency(
  amount: number | string,
  currency = 'EUR'
): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount))
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals).replace('.', ',')}%`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('fr-FR').format(value)
}

export function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
}

export function getRiskColor(risk: string): string {
  switch (risk) {
    case 'low':
      return 'text-green-600 bg-green-50'
    case 'medium':
      return 'text-yellow-600 bg-yellow-50'
    case 'high':
      return 'text-red-600 bg-red-50'
    default:
      return 'text-gray-600 bg-gray-50'
  }
}

export function getRetentionColor(score: number): string {
  if (score >= 0.7) return 'text-green-600'
  if (score >= 0.5) return 'text-yellow-600'
  return 'text-red-600'
}

export function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    inactive: 'bg-gray-100 text-gray-800',
    onLeave: 'bg-blue-100 text-blue-800',
    terminated: 'bg-red-100 text-red-800',
    pending: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
    draft: 'bg-gray-100 text-gray-800',
    published: 'bg-blue-100 text-blue-800',
    closed: 'bg-gray-100 text-gray-800',
  }
  return map[status] ?? 'bg-gray-100 text-gray-800'
}

export function truncate(text: string, length = 100): string {
  if (text.length <= length) return text
  return `${text.slice(0, length)}...`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
