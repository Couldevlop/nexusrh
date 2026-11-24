/**
 * Rechargement du corpus juridique depuis l'espace plateforme.
 *
 * Le point sensible : l'opération désactive les articles absents du corpus.
 * Elle ne doit donc jamais partir sur un seul clic, et son issue — réussite
 * comme échec — doit être lisible, puisque c'est le seul retour qu'a le
 * super_admin sur une opération qui touche tous les tenants.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown, v?: Record<string, unknown>) => {
      const base = typeof d === 'string' ? d : ''
      return v === undefined ? base
        : base.replace(/{{(\w+)}}/g, (_m, c: string) => String(v[c] ?? ''))
    },
  }),
}))

import CorpusJuridiqueCard from './CorpusJuridiqueCard'

function monter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><CorpusJuridiqueCard /></QueryClientProvider>)
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { pg_count: 420, es_count: 418 } })
  postMock.mockReset()
})
afterEach(() => cleanup())

describe('CorpusJuridiqueCard', () => {
  it('affiche l’état courant du corpus', async () => {
    monter()
    // deux compteurs distincts : la base et l'index, qui peuvent diverger
    await waitFor(() => expect(screen.getByText('420')).toBeTruthy())
    expect(screen.getByText('418')).toBeTruthy()
    expect(getMock).toHaveBeenCalledWith('/referentiels/stats')
  })

  it('ne recharge PAS au premier clic : une confirmation est exigée', async () => {
    monter()
    fireEvent.click(await screen.findByText('Recharger le corpus'))

    expect(postMock).not.toHaveBeenCalled()
    expect(screen.getByText(/seront désactivés/)).toBeTruthy()
  })

  it('recharge après confirmation et rend compte du résultat', async () => {
    postMock.mockResolvedValue({ data: { success: true, persisted: 453, indexed: 420, desactives: 40 } })
    monter()

    fireEvent.click(await screen.findByText('Recharger le corpus'))
    fireEvent.click(screen.getByText('Confirmer le rechargement'))

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/referentiels/seed'))
    expect(await screen.findByText('453 articles écrits, 420 indexés, 40 désactivés.')).toBeTruthy()
  })

  it('annuler referme la confirmation sans rien envoyer', async () => {
    monter()
    fireEvent.click(await screen.findByText('Recharger le corpus'))
    fireEvent.click(screen.getByText('Annuler'))

    expect(postMock).not.toHaveBeenCalled()
    expect(screen.getByText('Recharger le corpus')).toBeTruthy()
  })

  it('dit que rien n’a été modifié quand le rechargement échoue', async () => {
    postMock.mockRejectedValue({ response: { status: 500, data: {} } })
    monter()

    fireEvent.click(await screen.findByText('Recharger le corpus'))
    fireEvent.click(screen.getByText('Confirmer le rechargement'))

    expect(await screen.findByText(/Rien n’a été modifié/)).toBeTruthy()
  })

  it('explique la limite de débit plutôt qu’une erreur générique', async () => {
    postMock.mockRejectedValue({ response: { status: 429, data: {} } })
    monter()

    fireEvent.click(await screen.findByText('Recharger le corpus'))
    fireEvent.click(screen.getByText('Confirmer le rechargement'))

    expect(await screen.findByText(/Trop de rechargements récents/)).toBeTruthy()
  })

  it('la réindexation seule n’exige pas de confirmation', async () => {
    postMock.mockResolvedValue({ data: { success: true, indexed: 420 } })
    monter()

    fireEvent.click(await screen.findByText('Réindexer la recherche seule'))

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/referentiels/reindex'))
  })
})
