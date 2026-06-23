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

// Refresh token rotatif : une SEULE requête de refresh en vol partagée par tous
// les 401 concurrents (évite N appels /auth/refresh-token simultanés).
let refreshPromise: Promise<string | null> | null = null

async function trySilentRefresh(): Promise<string | null> {
  const rt = useAuthStore.getState().refreshToken
  if (!rt) return null
  if (!refreshPromise) {
    // axios brut (pas `api`) → n'enclenche pas l'intercepteur (anti-récursion).
    refreshPromise = axios
      .post<{ token?: string; refreshToken?: string | null }>(`${API_BASE}/auth/refresh-token`,
        { refreshToken: rt }, { withCredentials: true })
      .then((r) => {
        const newToken = r.data?.token
        if (!newToken) return null
        // Met à jour token + refreshToken (rotation) dans le store persisté.
        useAuthStore.setState({ token: newToken, refreshToken: r.data?.refreshToken ?? null })
        return newToken
      })
      .catch(() => null)
      .finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

// Intercepteur réponse : 401 → refresh silencieux + rejeu (sinon déconnexion),
// 503 → bannière maintenance.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 503 && error.response?.data?.maintenance) {
      window.dispatchEvent(new CustomEvent('nexusrh:maintenance'))
    }

    // Tenant/cabinet mis hors ligne par le super_admin : déconnexion + message
    // (configuré côté plateforme) affiché sur la page de connexion. Les routes
    // /auth/* sont exclues : le composant LoginPage affiche lui-même l'erreur.
    if (error.response?.status === 503 && error.response?.data?.offline) {
      const url: string = error.config?.url ?? ''
      if (!url.includes('/auth/')) {
        const message: string = typeof error.response.data.error === 'string'
          ? error.response.data.error : ''
        try { sessionStorage.setItem('nexusrh:offline-message', message) } catch { /* quota */ }
        if (useAuthStore.getState().token) {
          useAuthStore.getState().logout()
          window.location.href = '/login'
        }
      }
    }

    if (error.response?.status === 401) {
      // Ne pas intercepter les routes /auth/* — le composant gère l'erreur lui-même
      const url: string = error.config?.url ?? ''
      if (url.includes('/auth/')) {
        return Promise.reject(error)
      }

      // 401 sur une route protégée : le JWT a probablement expiré. On tente UN
      // refresh silencieux via le refresh token rotatif, puis on REJOUE la
      // requête d'origine (l'utilisateur n'est pas déconnecté — AUTH-008).
      const original = error.config as (typeof error.config & { _retry?: boolean }) | undefined
      if (original && !original._retry && useAuthStore.getState().refreshToken) {
        original._retry = true
        const newToken = await trySilentRefresh()
        if (newToken) {
          original.headers = original.headers ?? {}
          original.headers['Authorization'] = `Bearer ${newToken}`
          return api(original)
        }
      }

      // Échec du refresh (pas de refresh token, ou refresh rejeté = révoqué) →
      // déconnexion propre et retour au login.
      if (useAuthStore.getState().token) {
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
