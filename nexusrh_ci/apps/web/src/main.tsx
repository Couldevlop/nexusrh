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
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
