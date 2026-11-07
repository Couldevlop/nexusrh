/**
 * Nombre de fiches d'habilitation dont l'utilisateur est le validateur attendu.
 *
 * Sert à ouvrir l'entrée « Habilitations » de la navigation à un validateur que
 * son rôle ne désigne pas : un manager N+1 n'a aucune case de la grille, mais
 * il doit atteindre la fiche qui l'attend. Sans ce compteur, la fiche resterait
 * invisible et le circuit bloqué.
 *
 * La requête est celle de l'écran (`GET /habilitations/fiches`, déjà bornée
 * côté serveur aux fiches dont l'appelant est acteur) : aucune route
 * supplémentaire, et le cache est partagé avec la page.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

interface FicheLite {
  id: string
  status: string
  n1_user_id: string | null
  n2_user_id: string | null
}

export function usePendingFiches(enabled: boolean): number {
  const me = useAuthStore((s) => s.user?.sub ?? '')
  const q = useQuery({
    queryKey: ['habilitations', 'fiches'],
    queryFn: async () => (await api.get('/habilitations/fiches')).data.data as FicheLite[],
    enabled,
    // Tables absentes (tenant pas encore migré) ou 403 : l'entrée reste cachée.
    retry: false,
    staleTime: 60_000,
  })
  const rows = q.data ?? []
  return rows.filter((f) =>
    (f.status === 'n1' && f.n1_user_id === me) || (f.status === 'n2' && f.n2_user_id === me),
  ).length
}
