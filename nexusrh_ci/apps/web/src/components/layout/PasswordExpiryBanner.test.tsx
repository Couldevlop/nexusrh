/**
 * Bandeau d'avertissement avant expiration du mot de passe.
 *
 * Ce qui est éprouvé ici, c'est le silence autant que l'alerte : un bandeau
 * qui crierait trop tôt serait ignoré, et un bandeau muet a déjà coûté
 * l'accès à 58 comptes sur 60 le 25/11/2026.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { authState, getMock, setExpiryMock } = vi.hoisted(() => ({
  authState: {
    passwordExpiresInDays: null as number | null,
    token: 'un-token' as string | null,
    setPasswordExpiry: (_j: number | null) => { /* remplacé ci-dessous */ },
  },
  getMock: vi.fn(),
  setExpiryMock: vi.fn(),
}))
authState.setPasswordExpiry = setExpiryMock
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) => (o?.count === undefined ? k : `${k}:${o.count}`),
  }),
}))

import PasswordExpiryBanner, { paliersDAlerte } from './PasswordExpiryBanner'

function afficher(jours: number | null) {
  authState.passwordExpiresInDays = jours
  return render(
    <MemoryRouter>
      <PasswordExpiryBanner />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  getMock.mockReset(); setExpiryMock.mockReset()
  authState.token = 'un-token'
  // Par défaut l'appel reste en attente : les cas d'affichage n'ont rien à
  // voir avec le rafraîchissement.
  getMock.mockReturnValue(new Promise(() => { /* jamais résolue */ }))
})
afterEach(() => { cleanup(); authState.passwordExpiresInDays = null })

describe('paliersDAlerte — quand faut-il parler', () => {
  it('se tait quand l expiration est désactivée', () => {
    expect(paliersDAlerte(null)).toBeNull()
  })

  it('se tait au-delà d une semaine : prévenir trop tôt, c est ne pas être lu', () => {
    expect(paliersDAlerte(30)).toBeNull()
    expect(paliersDAlerte(8)).toBeNull()
  })

  it('parle à partir de sept jours', () => {
    expect(paliersDAlerte(7)).toBe(7)
    expect(paliersDAlerte(5)).toBe(7)
    expect(paliersDAlerte(3)).toBe(7)
  })

  it('monte d un ton à deux jours, puis la veille', () => {
    expect(paliersDAlerte(2)).toBe(2)
    expect(paliersDAlerte(1)).toBe(1)
  })

  it('alerte à zéro jour au lieu de se taire au pire moment', () => {
    // Un token d'accès vit 7 jours et n'est pas recontrôlé à chaque requête :
    // l'échéance tombe donc en pleine session. Se taire alors laisserait
    // l'utilisateur découvrir le refus à la prochaine connexion.
    expect(paliersDAlerte(0)).toBe(0)
    expect(paliersDAlerte(-5)).toBe(0)
  })

  it('dit « expiré » et non « dans 0 jour »', () => {
    afficher(0)
    const bandeau = screen.getByTestId('password-expiry-banner')
    expect(bandeau.getAttribute('data-palier')).toBe('0')
    expect(bandeau.textContent).toContain('passwordExpiry.expired')
    expect(bandeau.textContent).not.toContain('inDays')
  })

  it('se tait sur une valeur aberrante plutôt que de deviner', () => {
    expect(paliersDAlerte(Number.NaN)).toBeNull()
    expect(paliersDAlerte(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('PasswordExpiryBanner — rendu', () => {
  it('ne rend rien quand il n y a rien à annoncer', () => {
    afficher(null)
    expect(screen.queryByTestId('password-expiry-banner')).toBeNull()
    cleanup()
    afficher(20)
    expect(screen.queryByTestId('password-expiry-banner')).toBeNull()
  })

  it('annonce les jours restants à une semaine, sans dramatiser', () => {
    afficher(6)
    const b = screen.getByTestId('password-expiry-banner')
    expect(b.getAttribute('data-palier')).toBe('7')
    expect(b.className).toContain('amber')
    expect(b.textContent).toContain('passwordExpiry.inDays:6')
  })

  it('passe au rouge à deux jours', () => {
    afficher(2)
    const b = screen.getByTestId('password-expiry-banner')
    expect(b.getAttribute('data-palier')).toBe('2')
    expect(b.className).toContain('red')
  })

  it('dit « demain » la veille, et non « dans 1 jour »', () => {
    afficher(1)
    const b = screen.getByTestId('password-expiry-banner')
    expect(b.getAttribute('data-palier')).toBe('1')
    expect(b.textContent).toContain('passwordExpiry.tomorrow')
  })

  it('offre toujours le chemin vers le changement', () => {
    afficher(3)
    const lien = screen.getByRole('link')
    expect(lien.getAttribute('href')).toBe('/change-password')
  })
})

describe("fraîcheur du compte à rebours", () => {
  it("relit /auth/me : le chiffre du login vieillit sur une session de 7 jours", async () => {
    getMock.mockResolvedValue({ data: { passwordExpiresInDays: 2 } })
    afficher(null)
    await vi.waitFor(() => expect(getMock).toHaveBeenCalledWith('/auth/me'))
    await vi.waitFor(() => expect(setExpiryMock).toHaveBeenCalledWith(2))
  })

  it("garde la valeur connue si l appel échoue, plutôt que de masquer l alerte", async () => {
    getMock.mockRejectedValue(new Error('réseau'))
    afficher(1)
    await vi.waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(setExpiryMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('password-expiry-banner')).toBeTruthy()
  })

  it("n interroge pas l API sans session", async () => {
    authState.token = null
    afficher(null)
    expect(getMock).not.toHaveBeenCalled()
  })

  it("ignore une réponse sans le champ, au lieu d effacer l alerte", async () => {
    getMock.mockResolvedValue({ data: {} })
    afficher(2)
    await vi.waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(setExpiryMock).not.toHaveBeenCalled()
  })
})
