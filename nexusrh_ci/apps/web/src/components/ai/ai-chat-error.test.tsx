/**
 * L'assistante après une erreur — elle doit pouvoir repartir.
 *
 * Constaté en production le 10/11/2026 sur SOTRA. Deux défauts enchaînés :
 *
 *  1. à la réception d'un `{ error }` dans le flux SSE, le code sortait de la
 *     boucle SANS écrire : le motif renvoyé par le serveur n'arrivait jamais à
 *     l'écran, et la bulle de l'assistante restait VIDE ;
 *  2. cette bulle vide restait dans l'historique. Au message suivant, elle
 *     repartait au serveur, dont le schéma exige `content.min(1)` : la requête
 *     entière était rejetée en 400, et l'écran affichait « Erreur IA » — sans
 *     que l'IA soit en cause. La conversation était morte jusqu'à rechargement.
 *
 * Côté serveur, les journaux montraient un 400 en 6,8 ms sur /ai/chat : trop
 * rapide pour être un échec de modèle. C'était la validation d'entrée.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // `aiChat.suggestions.<role>` est lu avec returnObjects : il doit rendre
    // un tableau, sinon le composant plante avant le premier rendu.
    t: (k: string, o?: { returnObjects?: boolean }) => (o?.returnObjects ? [] : k),
    i18n: { language: 'fr' },
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: Object.assign(
    () => ({ user: { role: 'admin', firstName: 'Test' } }),
    { getState: () => ({ token: 'jeton-test' }) },
  ),
}))
vi.mock('@/stores/tenantStore', () => ({
  useTenantStore: () => ({ config: { name: 'SOTRA' } }),
}))
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { available: true, provider: 'local' } }) },
}))

import AiChat from './AiChat'

/** AiChat interroge /ai/status via TanStack Query : il lui faut son contexte. */
const afficher = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AiChat />
  </QueryClientProvider>,
)

/** Flux SSE servi par un faux `fetch`. */
function fluxSSE(lignes: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => i < lignes.length
          ? { done: false, value: encoder.encode(lignes[i++]! + '\n') }
          : { done: true, value: undefined },
      }),
    },
  }
}

// jsdom n'implémente pas scrollIntoView, que le composant appelle à chaque
// nouveau message pour suivre le fil.
Element.prototype.scrollIntoView = vi.fn()

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Ouvre le panneau : il est replié par défaut. */
async function ouvrir() {
  const boutons = await screen.findAllByRole('button')
  fireEvent.click(boutons[0]!)
}

/** Saisit un message et l'envoie. */
async function envoyer(texte: string) {
  const champ = await screen.findByPlaceholderText('aiChat.inputPlaceholder')
  fireEvent.change(champ, { target: { value: texte } })
  fireEvent.keyDown(champ, { key: 'Enter', code: 'Enter' })
}

/** Corps JSON du n-ième appel à /ai/chat. */
const corps = (n: number) =>
  JSON.parse(String((fetchMock.mock.calls[n]![1] as { body: string }).body)) as {
    messages: Array<{ role: string; content: string }>
  }

describe('Une erreur renvoyée par le serveur', () => {
  it('s’AFFICHE dans la bulle, au lieu de la laisser vide', async () => {
    fetchMock.mockResolvedValueOnce(fluxSSE([
      `data: ${JSON.stringify({ error: 'Erreur IA — réessayez dans quelques instants.' })}`,
    ]))
    afficher()
    await ouvrir()
    await envoyer('Quel est le SMIG en Côte d’Ivoire ?')
    await waitFor(() => expect(screen.getByText(/Erreur IA/)).toBeTruthy())
  })

  it('n’empêche pas le message SUIVANT d’aboutir', async () => {
    // Le cœur du défaut : la bulle vide laissée par le tour en échec faisait
    // rejeter la requête suivante en 400, et l'écran répétait « Erreur IA »
    // indéfiniment, sans rapport avec l'IA.
    fetchMock
      .mockResolvedValueOnce(fluxSSE([`data: ${JSON.stringify({ error: 'quota dépassé' })}`]))
      .mockResolvedValueOnce(fluxSSE([
        `data: ${JSON.stringify({ text: 'Le SMIG ivoirien est de 75 000 FCFA.' })}`,
        `data: ${JSON.stringify({ done: true })}`,
      ]))
    afficher()
    await ouvrir()
    await envoyer('première question')
    await waitFor(() => expect(screen.getByText(/quota dépassé/)).toBeTruthy())

    await envoyer('deuxième question')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText(/75 000 FCFA/)).toBeTruthy())
  })
})

describe('Ce qui part au serveur', () => {
  it('ne contient JAMAIS de message vide', async () => {
    // `content: z.string().min(1)` côté API : un seul message vide fait
    // rejeter toute la requête, y compris les messages valides qui l'entourent.
    fetchMock
      .mockResolvedValueOnce(fluxSSE([`data: ${JSON.stringify({ error: 'panne' })}`]))
      .mockResolvedValueOnce(fluxSSE([`data: ${JSON.stringify({ text: 'ok' })}`]))
    afficher()
    await ouvrir()
    await envoyer('première question')
    await waitFor(() => expect(screen.getByText(/panne/)).toBeTruthy())
    await envoyer('deuxième question')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    for (const m of corps(1).messages) {
      expect(m.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('conserve l’historique utile : la question d’avant est toujours transmise', async () => {
    // Filtrer les bulles vides ne doit pas amputer le contexte : l'assistante
    // perdrait le fil de la conversation.
    fetchMock
      .mockResolvedValueOnce(fluxSSE([`data: ${JSON.stringify({ text: 'Première réponse.' })}`]))
      .mockResolvedValueOnce(fluxSSE([`data: ${JSON.stringify({ text: 'Deuxième réponse.' })}`]))
    afficher()
    await ouvrir()
    await envoyer('première question')
    await waitFor(() => expect(screen.getByText(/Première réponse/)).toBeTruthy())
    await envoyer('deuxième question')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const envoyes = corps(1).messages
    expect(envoyes.map(m => m.content)).toContain('première question')
    expect(envoyes.map(m => m.content)).toContain('Première réponse.')
  })
})
