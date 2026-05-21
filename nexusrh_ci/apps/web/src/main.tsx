import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

// OWASP A01 — Au logout depuis n'importe quel store/composant, purger TOUT
// le cache React Query (bulletins, employés, paie en attente, etc.) pour
// éviter qu'un autre user qui rouvre l'onglet voit des données mises en cache.
if (typeof window !== 'undefined') {
  window.addEventListener('nexusrh:logout', () => {
    queryClient.clear()
  })

  // Détection des "stale chunks" après déploiement : Vite génère des fichiers
  // JS avec hash (RecruitmentPage-CJwDcTbR.js). Quand on déploie une nouvelle
  // version, l'index.html mis en cache par le navigateur de l'utilisateur
  // pointe vers d'anciens chunks qui n'existent plus sur le serveur (404/503).
  // React.lazy() lève alors un "Failed to fetch dynamically imported module".
  // Solution : on détecte l'erreur, marque un flag dans sessionStorage pour
  // éviter une boucle infinie, et reload la page (qui ramène le nouvel
  // index.html avec les bons hashes de chunks).
  const STALE_CHUNK_RELOAD_FLAG = 'nexusrh:stale-chunk-reloaded'
  const isDynamicImportError = (msg: string): boolean =>
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)

  const handleStaleChunk = (msg: string): void => {
    if (!isDynamicImportError(msg)) return
    if (sessionStorage.getItem(STALE_CHUNK_RELOAD_FLAG)) {
      // Déjà rechargé une fois et l'erreur persiste : ne pas boucler.
      // L'utilisateur verra l'erreur réelle (problème serveur ou réseau).
      return
    }
    sessionStorage.setItem(STALE_CHUNK_RELOAD_FLAG, String(Date.now()))
    // Force un reload complet sans cache (ramène le nouvel index.html)
    window.location.reload()
  }

  // Nettoyage du flag après navigation réussie (5s suffisent pour qu'une
  // route lazy charge si tout va bien)
  setTimeout(() => sessionStorage.removeItem(STALE_CHUNK_RELOAD_FLAG), 5000)

  window.addEventListener('error', (e) => handleStaleChunk(e.message ?? ''))
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '')
    handleStaleChunk(msg)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
