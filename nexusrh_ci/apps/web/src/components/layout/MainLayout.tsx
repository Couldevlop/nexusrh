import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import AiChat from '@/components/ai/AiChat'
import { AlertTriangle } from 'lucide-react'

function MaintenanceBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const handler = () => setVisible(true)
    window.addEventListener('nexusrh:maintenance', handler)
    return () => window.removeEventListener('nexusrh:maintenance', handler)
  }, [])

  if (!visible) return null

  return (
    <div className="flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        Service en maintenance — Certaines fonctionnalités sont temporairement indisponibles.
        Contactez votre administrateur.
      </span>
      <button onClick={() => setVisible(false)} className="ml-auto text-white/80 hover:text-white">✕</button>
    </div>
  )
}

export default function MainLayout() {
  return (
    <div className="flex h-screen overflow-hidden flex-col">
      <MaintenanceBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-background">
          <Outlet />
        </main>
        <AiChat />
      </div>
    </div>
  )
}
