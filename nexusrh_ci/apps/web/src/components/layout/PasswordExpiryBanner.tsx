/**
 * Bandeau d'avertissement avant expiration du mot de passe.
 *
 * La politique de sécurité impose une durée de vie (30 jours par défaut), et
 * elle expirait jusqu'ici en SILENCE : le salarié découvrait l'échéance le
 * jour où elle tombait, et la combinaison « historique des 5 derniers +
 * refus des mots de passe compromis » pouvait alors l'enfermer dehors. Le
 * 25/11/2026, 58 comptes sur 60 étaient expirés, certains depuis juillet.
 *
 * Le compte à rebours vient de l'API (`passwordExpiresInDays`, calculé par la
 * MÊME fonction que le contrôle d'expiration du login), jamais d'un calcul
 * local : le navigateur n'a pas à connaître la politique, et une horloge
 * client décalée n'a aucun effet.
 *
 * Quatre états, du plus discret au plus pressant : 7 jours, 2 jours, 1 jour,
 * puis 0 = ÉCHU. Rien n'est rendu au-delà de 7 jours ni quand l'expiration est
 * désactivée (`null`).
 *
 * Le palier 0 n'est pas théorique : un token d'accès vit 7 jours et n'est pas
 * recontrôlé à chaque requête, donc l'échéance peut tomber en pleine session.
 * Se taire à ce moment-là serait le pire : l'utilisateur est encore dedans, il
 * sera refusé à la prochaine connexion, et c'est maintenant qu'il peut agir.
 */
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

/** Palier atteint, du plus proche au plus lointain. 0 = échu. */
export function paliersDAlerte(joursRestants: number | null): 0 | 1 | 2 | 7 | null {
  if (joursRestants === null || !Number.isFinite(joursRestants)) return null
  // Échu : l'échéance est tombée pendant la session. On le dit, au lieu de
  // laisser l'utilisateur découvrir le refus à la prochaine connexion.
  if (joursRestants <= 0) return 0
  if (joursRestants <= 1) return 1
  if (joursRestants <= 2) return 2
  if (joursRestants <= 7) return 7
  return null
}

export default function PasswordExpiryBanner() {
  const { t } = useTranslation('nav')
  const jours = useAuthStore(s => s.passwordExpiresInDays)
  const token = useAuthStore(s => s.token)
  const setPasswordExpiry = useAuthStore(s => s.setPasswordExpiry)

  // Le chiffre posé au login vieillit : un JWT vit 7 jours, donc une session
  // ouverte au jour 20 d'une politique à 30 jours n'aurait jamais vu venir
  // l'échéance. On le relit à chaque chargement de coque. Non bloquant : en
  // cas d'échec on garde la valeur du login plutôt que de masquer l'alerte.
  useEffect(() => {
    if (!token) return
    let annule = false
    api.get<{ passwordExpiresInDays?: number | null }>('/auth/me')
      .then(r => {
        if (annule) return
        if (r.data.passwordExpiresInDays !== undefined) {
          setPasswordExpiry(r.data.passwordExpiresInDays)
        }
      })
      .catch(() => { /* on conserve la valeur connue */ })
    return () => { annule = true }
  }, [token, setPasswordExpiry])

  const palier = paliersDAlerte(jours)
  if (palier === null || jours === null) return null

  // Le ton monte avec l'urgence : ambre à une semaine, rouge dès 2 jours.
  const urgent = palier <= 2
  const classes = urgent
    ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-100'
    : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100'
  const Icone = urgent ? ShieldAlert : KeyRound

  return (
    <div
      role="status"
      data-testid="password-expiry-banner"
      data-palier={palier}
      className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${classes}`}
    >
      <Icone className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        {palier === 0
          ? t('passwordExpiry.expired')
          : jours <= 1
            ? t('passwordExpiry.tomorrow')
            : t('passwordExpiry.inDays', { count: jours })}
      </span>
      <Link
        to="/change-password"
        className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
      >
        {t('passwordExpiry.cta')}
      </Link>
    </div>
  )
}
