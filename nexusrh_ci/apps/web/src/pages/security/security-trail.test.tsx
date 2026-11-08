/**
 * Onglet « Piste d'audit » — ce que l'écran DIT de l'intégrité.
 *
 * Un écran d'opposabilité se juge sur sa franchise : il doit annoncer une
 * rupture sans détour, ne jamais crier à l'altération quand il n'y a rien à
 * contrôler, et remettre à l'utilisateur l'empreinte de tête — la seule chose
 * qu'il puisse conserver hors de l'application pour s'opposer plus tard à une
 * piste reconstruite.
 *
 * Le contrôle n'est pas lancé à l'ouverture : il relit tout le journal. Ce
 * banc vérifie aussi ce silence initial.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SecurityPage from './SecurityPage'

const get = vi.fn()
const post = vi.fn()
const put = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Les libellés sont vérifiés par le contrôle d'exhaustivité des locales :
    // ici on teste le comportement, donc on rend la clé et ses variables.
    t: (k: string, o?: Record<string, unknown>) => {
      if (o && 'defaultValue' in o) return String(o.defaultValue)
      const vars = o ? Object.entries(o).map(([n, v]) => `${n}=${String(v)}`).join(',') : ''
      return vars ? `${k}[${vars}]` : k
    },
    i18n: { language: 'fr' },
  }),
}))

const INTACT = {
  checked: 1649, intact: true, purgeMarkers: 0, brokenAt: null,
  lastHash: 'a'.repeat(64), chained: true,
}

function monter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><SecurityPage /></QueryClientProvider>)
}

/**
 * Ouvre l'onglet « Piste d'audit ».
 *
 * `fireEvent` et non `userEvent` : `TabBtn` est un composant redéfini à chaque
 * rendu de la page, donc React remplace le nœud du bouton entre le `mousedown`
 * et le `click` que userEvent enchaîne — le clic tombe alors sur un nœud
 * détaché et l'onglet ne change jamais.
 */
function ouvrirOnglet() {
  fireEvent.click(screen.getByRole('button', { name: 'tabs.trail' }))
}

/** Clique un bouton du panneau, désigné par sa clé de libellé. */
function cliquer(cle: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: cle }))
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); put.mockReset()
  // Les onglets SSO/SIEM interrogent l'API dès le montage.
  get.mockResolvedValue({ data: { data: null } })
})
afterEach(() => cleanup())

describe('Contrôle d’intégrité', () => {
  it('ne contrôle RIEN à l’ouverture de l’onglet', async () => {
    monter(); ouvrirOnglet()
    // Relire toute la piste pour afficher un écran serait un coût imposé à
    // chaque visite : le contrôle est un geste explicite.
    await waitFor(() => expect(screen.getByRole('button', { name: /trail\.verify$/ })).toBeTruthy())
    expect(get.mock.calls.some(c => String(c[0]).includes('/audit/verify'))).toBe(false)
  })

  it('annonce une piste intacte et REND l’empreinte de tête', async () => {
    monter(); ouvrirOnglet()
    get.mockResolvedValueOnce({ data: { data: INTACT } })
    cliquer(/trail\.verify$/)
    await waitFor(() => expect(screen.getByText(/trail\.intact/)).toBeTruthy())
    expect(screen.getByText(/count=1649/)).toBeTruthy()
    // L'empreinte doit être LISIBLE à l'écran : c'est elle que l'utilisateur
    // recopie dans un procès-verbal.
    expect(screen.getByText(/^a{32}…$/)).toBeTruthy()
    expect(screen.getByText('trail.lastHashHint')).toBeTruthy()
  })

  it('annonce une rupture sans détour, avec sa cause et son rang', async () => {
    monter(); ouvrirOnglet()
    get.mockResolvedValueOnce({ data: { data: {
      checked: 500, intact: false, purgeMarkers: 0,
      brokenAt: { seq: '317', id: 'e-317', reason: 'hash_mismatch' }, lastHash: null, chained: true,
    } } })
    cliquer(/trail\.verify$/)
    await waitFor(() => expect(screen.getByText('trail.broken')).toBeTruthy())
    // La cause est traduite, avec repli sur le code brut si la clé manque —
    // ce que rend le `t` simulé ici : mieux vaut un code affiché qu'une
    // rupture signalée sans explication.
    expect(screen.getByText('hash_mismatch')).toBeTruthy()
    expect(screen.getByText(/seq=317/)).toBeTruthy()
    // Et surtout : pas de message rassurant en même temps.
    expect(screen.queryByText(/trail\.intact/)).toBeNull()
  })

  it('tenant d’avant le chaînage : le dit, au lieu d’alarmer', async () => {
    monter(); ouvrirOnglet()
    get.mockResolvedValueOnce({ data: { data: {
      checked: 0, intact: true, purgeMarkers: 0, brokenAt: null, lastHash: null, chained: false,
    } } })
    cliquer(/trail\.verify$/)
    await waitFor(() => expect(screen.getByText('trail.notChained')).toBeTruthy())
    expect(screen.queryByText(/trail\.intact/)).toBeNull()
    expect(screen.queryByText('trail.broken')).toBeNull()
  })

  it('signale les purges consignées, qui expliquent les trous', async () => {
    monter(); ouvrirOnglet()
    get.mockResolvedValueOnce({ data: { data: { ...INTACT, purgeMarkers: 2 } } })
    cliquer(/trail\.verify$/)
    await waitFor(() => expect(screen.getByText(/trail\.purgeMarkers/)).toBeTruthy())
  })
})

describe('Export probant', () => {
  it('télécharge le CSV et affiche le condensé reçu en en-tête', async () => {
    const createUrl = vi.fn(() => 'blob:piste')
    const revokeUrl = vi.fn()
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    monter(); ouvrirOnglet()
    get.mockResolvedValueOnce({
      data: new Blob(['seq;id\r\n']),
      headers: { 'x-audit-sha256': 'f'.repeat(64), 'x-audit-seal': '9'.repeat(64) },
    })
    cliquer(/trail\.export$/)

    await waitFor(() => expect(click).toHaveBeenCalled())
    const appel = get.mock.calls.find(c => String(c[0]).includes('/audit/export'))
    // En blob : sans cela, axios renvoie une chaîne et le BOM est abîmé.
    expect(appel?.[1]).toMatchObject({ responseType: 'blob', params: { format: 'csv' } })
    // Le condensé est montré : le destinataire du fichier doit pouvoir le
    // comparer à celui qu'il recalcule de son côté.
    await waitFor(() => expect(screen.getByText(/trail\.exported/)).toBeTruthy())
    expect(screen.getByText(/sha=ffffffffffffffff/)).toBeTruthy()
    expect(revokeUrl).toHaveBeenCalled()
    click.mockRestore()
  })

  it('échec d’export : le dit, et ne laisse pas croire au téléchargement', async () => {
    monter(); ouvrirOnglet()
    get.mockRejectedValueOnce(new Error('503'))
    cliquer(/trail\.export$/)
    await waitFor(() => expect(screen.getByText('trail.exportError')).toBeTruthy())
  })
})

describe('Rétention', () => {
  it('rend compte de ce qui a été supprimé ET de la durée appliquée', async () => {
    monter(); ouvrirOnglet()
    post.mockResolvedValueOnce({ data: { data: { purged: 1200, boundary: '2025-11-08T00:00:00Z', keepDays: 365 } } })
    cliquer(/trail\.purge$/)
    await waitFor(() => expect(screen.getByText(/trail\.purged/)).toBeTruthy())
    // La durée vient de la plateforme : l'afficher évite de croire qu'on l'a
    // choisie ici.
    expect(screen.getByText(/days=365/)).toBeTruthy()
    expect(post).toHaveBeenCalledWith('/security/audit/purge')
  })

  it('aucune durée définie : explique, au lieu d’un échec muet', async () => {
    monter(); ouvrirOnglet()
    post.mockRejectedValueOnce(new Error('400'))
    cliquer(/trail\.purge$/)
    await waitFor(() => expect(screen.getByText('trail.purgeUnset')).toBeTruthy())
  })
})
