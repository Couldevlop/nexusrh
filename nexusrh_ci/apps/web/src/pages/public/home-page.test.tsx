/**
 * Page d'accueil publique (racine du domaine).
 *
 * Invariants tenus ici :
 *   1. Les deux appels à l'action demandés sont présents et mènent au bon endroit.
 *   2. La vidéo est servie depuis NOTRE domaine (chemin relatif) — la CSP
 *      n'autorise que `default-src 'self'`, un lecteur tiers serait bloqué.
 *   3. La page n'appelle JAMAIS l'API : elle est publique, aucune donnée de
 *      tenant ne doit pouvoir transiter par elle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) =>
    <a href={to} {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

vi.mock('react-i18next', async () => {
  // t() résout réellement les clés dans le fichier FR : les assertions portent
  // donc sur le texte publié, et une clé manquante fait échouer le test.
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

import HomePage from './HomePage'

beforeEach(() => { getMock.mockReset(); postMock.mockReset() })
afterEach(() => cleanup())

describe('HomePage — appels à l\'action', () => {
  it('propose « Accéder à NexusRH » vers /login', () => {
    render(<HomePage />)
    const links = screen.getAllByRole('link', { name: /Acc[ée]der/i })
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(l.getAttribute('href')).toBe('/login')
  })

  it('propose « Demander une démo » vers le formulaire', () => {
    render(<HomePage />)
    const links = screen.getAllByRole('link', { name: /Demander une d[ée]mo|^D[ée]mo$/i })
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(l.getAttribute('href')).toBe('#demo')
  })

  it('affiche le formulaire de demande de démo', () => {
    render(<HomePage />)
    expect(screen.getByLabelText(/Nom et prénom/i)).toBeTruthy()
    expect(screen.getByLabelText(/Test anti-robot/i)).toBeTruthy()
    expect(screen.getByText(/Envoyer la demande/i)).toBeTruthy()
  })

  it("affiche l'adresse de contact", () => {
    render(<HomePage />)
    // Elle apparaît dans le bloc contact ET dans le pied de page.
    const mails = screen.getAllByRole('link', { name: /waopron@openlabconsulting/i })
    expect(mails.length).toBeGreaterThan(0)
    for (const m of mails) expect(m.getAttribute('href')).toBe('mailto:waopron@openlabconsulting.com')
  })

  it('expose les quatre pages légales dans le pied de page', () => {
    render(<HomePage />)
    for (const slug of ['mentions-legales', 'confidentialite', 'conditions', 'cookies']) {
      expect(document.querySelector('a[href="/legal/' + slug + '"]'), slug).toBeTruthy()
    }
  })
})

describe('HomePage — vidéo servie depuis notre domaine', () => {
  it('utilise un chemin relatif, jamais un lecteur tiers', () => {
    const { container } = render(<HomePage />)
    const video = container.querySelector('video')
    expect(video, 'aucun élément <video> dans la page').toBeTruthy()
    const src = video?.querySelector('source')?.getAttribute('src') ?? video?.getAttribute('src') ?? ''
    // Chemin relatif = même origine. L'URL porte une empreinte de contenu
    // (émise par le build), ce qui interdit à un cache de servir une version
    // précédente après remplacement du fichier.
    expect(src).toMatch(/^\/[^/].*\.mp4$/)
    expect(src).not.toMatch(/^https?:/)
    // Aucune iframe : un lecteur YouTube/Vimeo exigerait d'ouvrir la CSP.
    expect(container.querySelector('iframe')).toBeNull()
  })
})

describe('HomePage — page publique sans accès aux données', () => {
  it('ne déclenche aucun appel à l\'API', () => {
    render(<HomePage />)
    expect(getMock).not.toHaveBeenCalled()
    expect(postMock).not.toHaveBeenCalled()
  })
})
