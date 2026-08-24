/**
 * Formulaire public de demande de démo — comportement côté visiteur.
 *
 * Invariants : aucune requête tant que personne n'a touché le formulaire, le
 * défi anti-robot est transmis avec la demande, le piège à robots part vide,
 * et une erreur serveur s'affiche sans jamais laisser l'écran muet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('react-i18next', async () => {
  const fr = (await import('@/i18n/locales/fr/home.json')).default as Record<string, unknown>
  const resolve = (key: string): string => {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], fr)
    return typeof v === 'string' ? v : key
  }
  return {
    useTranslation: () => ({ t: resolve, i18n: { language: 'fr', changeLanguage: vi.fn() } }),
    Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
    initReactI18next: { type: '3rdParty', init: () => {} },
  }
})

import DemoForm from './DemoForm'

const CHALLENGE = { token: 'nonce.9999999999999.sig', question: '3 + sept ?' }

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: CHALLENGE })
  postMock.mockReset().mockResolvedValue({ data: { ok: true } })
})
afterEach(() => cleanup())

function fill() {
  fireEvent.change(screen.getByLabelText(/Nom et prénom/i), { target: { value: 'Awa Koné' } })
  fireEvent.change(screen.getByLabelText(/^Société$/i), { target: { value: 'SOTRA' } })
  fireEvent.change(screen.getByLabelText(/Email professionnel/i), { target: { value: 'awa@sotra.ci' } })
  fireEvent.change(screen.getByLabelText(/Test anti-robot/i), { target: { value: '10' } })
}

describe('DemoForm', () => {
  it('ne déclenche aucune requête tant que le visiteur ne touche à rien', () => {
    render(<DemoForm />)
    expect(getMock).not.toHaveBeenCalled()
    expect(postMock).not.toHaveBeenCalled()
  })

  it('demande le défi anti-robot au premier contact, et l\'affiche', async () => {
    render(<DemoForm />)
    fireEvent.focus(screen.getByLabelText(/Nom et prénom/i))
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1))
    expect(String(getMock.mock.calls[0]![0])).toContain('/public/demo/captcha')
    expect(await screen.findByText('3 + sept ?')).toBeTruthy()
  })

  it('transmet le jeton du défi et laisse le piège à robots vide', async () => {
    render(<DemoForm />)
    fireEvent.focus(screen.getByLabelText(/Nom et prénom/i))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    fill()
    fireEvent.click(screen.getByText(/Envoyer la demande/i))

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1))
    const [url, body] = postMock.mock.calls[0]! as [string, Record<string, string>]
    expect(url).toBe('/public/demo/request')
    expect(body.captchaToken).toBe(CHALLENGE.token)
    expect(body.captchaAnswer).toBe('10')
    expect(body.website).toBe('')
    expect(body.email).toBe('awa@sotra.ci')
  })

  it('affiche la confirmation après un envoi réussi', async () => {
    render(<DemoForm />)
    fireEvent.focus(screen.getByLabelText(/Nom et prénom/i))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    fill()
    fireEvent.click(screen.getByText(/Envoyer la demande/i))
    expect(await screen.findByText(/Demande envoyée/i)).toBeTruthy()
  })

  it('affiche le message du serveur en cas de refus, et redemande un défi', async () => {
    postMock.mockRejectedValueOnce({ response: { data: { error: 'Réponse au test anti-robot incorrecte ou expirée.' } } })
    render(<DemoForm />)
    fireEvent.focus(screen.getByLabelText(/Nom et prénom/i))
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1))
    fill()
    fireEvent.click(screen.getByText(/Envoyer la demande/i))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Réponse au test anti-robot incorrecte ou expirée.')
    // Un défi consommé ne doit pas être resoumis : on en redemande un.
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
  })

  it('ne reste jamais muet quand le serveur ne dit rien', async () => {
    postMock.mockRejectedValueOnce(new Error('Network Error'))
    render(<DemoForm />)
    fireEvent.focus(screen.getByLabelText(/Nom et prénom/i))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    fill()
    fireEvent.click(screen.getByText(/Envoyer la demande/i))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
