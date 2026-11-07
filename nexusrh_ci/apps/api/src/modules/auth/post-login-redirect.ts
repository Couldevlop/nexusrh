/**
 * Destination après connexion — décision PURE, isolée de la route.
 *
 * Un point subtil des habilitations RH : le rôle technique ne dit plus seul
 * quel espace ouvrir. Un salarié (`employee`) à qui une fiche a accordé des
 * cases de la grille travaille en RH — l'envoyer sur son self-service
 * (`/mon-espace`) lui cacherait précisément ce qu'il a été habilité à faire.
 * Il garde son espace personnel par l'entrée épinglée « Mon espace ».
 *
 * Une affectation inactive (liste de droits VIDE) ne change rien : le moteur
 * refuse tout, l'espace RH serait une coquille vide.
 */
export interface PostLoginContext {
  role: string
  pwdResetRequired: boolean
  /** Droits effectifs ; `null` = aucune affectation (accès hérité du rôle). */
  habPermissions: string[] | null
}

export function postLoginRedirect(ctx: PostLoginContext): string {
  if (ctx.pwdResetRequired) return '/change-password'
  if (ctx.role === 'employee') {
    const habilitated = (ctx.habPermissions?.length ?? 0) > 0
    return habilitated ? '/dashboard' : '/mon-espace'
  }
  if (ctx.role === 'dg') return '/dg'
  return '/dashboard'
}
