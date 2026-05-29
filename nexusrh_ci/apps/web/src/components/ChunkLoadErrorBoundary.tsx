import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State { hasReloaded: boolean }
interface Props { children: ReactNode }

/**
 * Error Boundary spécialisé qui détecte les "Failed to fetch dynamically
 * imported module" et déclenche un reload automatique de la page.
 *
 * Contexte : après un déploiement, l'index.html en cache navigateur de
 * l'utilisateur pointe vers d'anciens chunks JS (hashes Vite obsolètes).
 * Au moment où React.lazy() tente de charger un chunk pour une route, le
 * fetch échoue (404/503), et React Suspense "swallow" l'erreur sans
 * remonter à window.error → écran blanc bloquant.
 *
 * Ce boundary catch l'erreur AU NIVEAU REACT (pas window), log et déclenche
 * sessionStorage flag anti-boucle + window.location.reload() pour ramener
 * le nouvel index.html.
 *
 * Si après 1 reload l'erreur revient, on affiche un fallback explicite
 * (vrai problème serveur ou réseau).
 */
const STALE_RELOAD_FLAG = 'nexusrh:stale-chunk-reloaded'

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message ?? ''
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    error.name === 'ChunkLoadError'
  )
}

export class ChunkLoadErrorBoundary extends Component<Props, State> {
  state: State = { hasReloaded: false }

  static getDerivedStateFromError(error: unknown): Partial<State> | null {
    if (isChunkLoadError(error)) {
      if (typeof window !== 'undefined' && !sessionStorage.getItem(STALE_RELOAD_FLAG)) {
        sessionStorage.setItem(STALE_RELOAD_FLAG, String(Date.now()))
        window.location.reload()
        return null
      }
      // Déjà rechargé une fois et erreur persiste : afficher fallback explicite
      return { hasReloaded: true }
    }
    return null
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error)) {
      // eslint-disable-next-line no-console
      console.warn('[NexusRH] Stale chunk détecté, reload en cours :', error)
    } else {
      // Erreur React autre que stale chunk : on log mais on ne fait rien
      // (l'Error Boundary parent éventuel pourra la gérer)
      // eslint-disable-next-line no-console
      console.error('[NexusRH] Erreur React non-chunk :', error, info)
    }
  }

  render(): ReactNode {
    if (this.state.hasReloaded) {
      return (
        <div className="flex h-screen items-center justify-center px-4 text-center">
          <div className="max-w-md space-y-4">
            <h1 className="text-2xl font-bold text-gray-900">Mise à jour de l'application</h1>
            <p className="text-sm text-gray-600">
              Une nouvelle version est en cours de déploiement. Veuillez patienter quelques
              secondes puis recharger la page (Ctrl+Shift+R / Cmd+Shift+R) si l'écran
              reste vide.
            </p>
            <button
              onClick={() => {
                sessionStorage.removeItem(STALE_RELOAD_FLAG)
                window.location.reload()
              }}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Recharger
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
