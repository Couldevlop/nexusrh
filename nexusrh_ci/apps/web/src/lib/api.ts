import axios from 'axios'
import { useAuthStore } from '@/stores/authStore'

const API_BASE = import.meta.env.VITE_API_URL ?? '/api'

export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  // OWASP A02 — envoie le cookie httpOnly nexusrh_token sur chaque requête
  // (en plus du header Authorization pour backward-compat période).
  withCredentials: true,
})

// CSRF token (double-submit pattern). Stocké en mémoire JS (pas en cookie pour
// pouvoir l'injecter en header). Rafraîchi au boot et au logout/login.
let csrfToken: string | null = null

export async function refreshCsrfToken(): Promise<void> {
  try {
    const token = useAuthStore.getState().token
    if (!token) { csrfToken = null; return }
    const res = await axios.get<{ csrfToken: string }>(`${API_BASE}/auth/csrf-token`, {
      headers: { Authorization: `Bearer ${token}` },
      withCredentials: true,
    })
    csrfToken = res.data.csrfToken
  } catch {
    csrfToken = null  // non-bloquant : si /csrf-token KO, mutations rejetées avec message clair
  }
}

export function clearCsrfToken(): void { csrfToken = null }

// Intercepteur requête : injecter le token JWT + le CSRF token sur les mutations
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // OWASP A01 — CSRF double-submit : inject X-CSRF-Token sur toute mutation.
  // Le backend ignore si l'auth est via Bearer header (clients API), mais
  // l'exige si l'auth est via cookie httpOnly (mode SPA browser, futur).
  const method = (config.method ?? 'get').toLowerCase()
  if (method !== 'get' && method !== 'head' && method !== 'options' && csrfToken) {
    config.headers['X-CSRF-Token'] = csrfToken
  }
  return config
})

// Intercepteur réponse : gérer 401 → déconnexion, 503 → bannière maintenance
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 503 && error.response?.data?.maintenance) {
      window.dispatchEvent(new CustomEvent('nexusrh:maintenance'))
    }

    if (error.response?.status === 401) {
      // Ne pas intercepter les routes /auth/* — le composant gère l'erreur lui-même
      const url: string = error.config?.url ?? ''
      if (url.includes('/auth/')) {
        return Promise.reject(error)
      }

      // Tenter refresh si refreshToken disponible
      const refreshToken = useAuthStore.getState().refreshToken
      if (refreshToken && error.config && !error.config._retry) {
        error.config._retry = true
        try {
          const res = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken })
          const { token } = res.data as { token: string }
          useAuthStore.getState().setToken(token)
          error.config.headers.Authorization = `Bearer ${token}`
          return axios(error.config)
        } catch {
          useAuthStore.getState().logout()
          window.location.href = '/login'
        }
      } else if (useAuthStore.getState().token) {
        // Token présent mais rejeté (expiré) → déconnecter
        useAuthStore.getState().logout()
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

// Formateur FCFA
export function formatFCFA(amount: number | string): string {
  const num = typeof amount === 'string' ? parseInt(amount) : amount
  if (isNaN(num)) return '0 FCFA'
  return new Intl.NumberFormat('fr-CI', {
    style: 'currency',
    currency: 'XOF',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num)
}

export function formatDate(date: string | Date): string {
  if (!date) return ''
  return new Intl.DateTimeFormat('fr-CI', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(date))
}

export function formatMonth(month: string): string {
  const [year, m] = month.split('-')
  return new Intl.DateTimeFormat('fr-CI', { month: 'long', year: 'numeric' })
    .format(new Date(parseInt(year!), parseInt(m!) - 1))
}
