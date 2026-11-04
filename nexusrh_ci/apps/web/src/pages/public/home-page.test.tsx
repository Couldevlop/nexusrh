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
import { MODULE_KEYS } from '../../../../api/src/services/tenant-modules.service'
import frHome from '@/i18n/locales/fr/home.json'
import enHome from '@/i18n/locales/en/home.json'
import { CATALOG_MODULE_COUNT, DEPLOY_POINTS, DEPLOY_ROWS, HOME_DOMAINS, HOME_FAQ, PHONES } from './home-content'

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

/** Toutes les clés feuilles d'un objet de traduction (a.b.c). */
function leafKeys(o: unknown, prefix = ''): string[] {
  if (typeof o !== 'object' || o === null) return [prefix]
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
}
type DomainsT = Record<string, { title: string; modules: Record<string, { title: string; text: string }> }>
const sectionOf = (container: HTMLElement, id: string): Element => {
  const s = container.querySelector(`#${id}`)?.closest('section')
  expect(s, `section #${id}`).toBeTruthy()
  return s!
}

describe('HomePage — deux modes de déploiement', () => {
  it('présente SaaS et on-premise, chacun avec ses points', () => {
    const { container } = render(<HomePage />)
    const section = sectionOf(container, 'deploiement')
    for (const mode of ['saas', 'onprem'] as const) {
      const card = section.querySelector(`[data-deploy="${mode}"]`)
      expect(card, mode).toBeTruthy()
      expect(card!.querySelectorAll('li')).toHaveLength(DEPLOY_POINTS[mode].length)
    }
    const text = section.textContent ?? ''
    expect(text).toContain('Hébergé et maintenu par OpenLab Consulting')
    expect(text).toContain('Mises à jour continues')
    expect(text).toContain('Installé sur vos serveurs ou dans le datacenter de votre choix')
    expect(text).toContain('Vos données restent dans votre infrastructure')
    expect(text).toContain('Déploiement conteneurisé')
    expect(text).toContain('Mises à jour livrées par OpenLab Consulting')
  })

  it('tableau comparatif sobre : une ligne par critère, trois colonnes', () => {
    const { container } = render(<HomePage />)
    const table = sectionOf(container, 'deploiement').querySelector('table')
    expect(table).toBeTruthy()
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(DEPLOY_ROWS.length)
    expect(table!.querySelectorAll('thead th')).toHaveLength(3)
  })

  it("appel à l'action vers le formulaire de démo existant, et lien vers la page détaillée", () => {
    const { container } = render(<HomePage />)
    const links = [...sectionOf(container, 'deploiement').querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(links).toContain('#demo')
    expect(links).toContain('/sirh-saas-ou-on-premise')
    expect(container.querySelector('#demo')?.closest('section')?.querySelector('form')).toBeTruthy()
  })

  it("aucune restriction de pays sur l'hébergement", () => {
    const deploy = JSON.stringify(frHome.deploy) + JSON.stringify(enHome.deploy)
    expect(deploy).not.toMatch(/Côte d'Ivoire|ivoirien|Ivorian/)
    expect(frHome.faq.items.hosting.a).not.toMatch(/Côte d'Ivoire/)
    expect(frHome.security.hosting.text).not.toMatch(/Côte d'Ivoire/)
  })
})

describe('HomePage — fonctionnalités par domaine', () => {
  it('six domaines, dans l’ordre demandé', () => {
    const { container } = render(<HomePage />)
    const titles = [...container.querySelectorAll('[data-domain] > h3')].map(h => h.textContent?.replace(/^\d{2}/, ''))
    expect(titles).toEqual([
      'Administration du personnel', 'Paie et conformité', 'Temps et présence',
      'Talents', 'Expérience collaborateur', 'Sécurité et intégrations',
    ])
  })

  it('affiche chaque module annoncé, avec son titre et son texte', () => {
    const { container } = render(<HomePage />)
    const domains = frHome.domains as DomainsT
    for (const d of HOME_DOMAINS) for (const m of d.modules) {
      const el = container.querySelector(`[data-domain="${d.key}"] [data-module="${m.key}"]`)
      expect(el, `${d.key}.${m.key}`).toBeTruthy()
      expect(el!.textContent).toContain(domains[d.key]!.modules[m.key]!.title)
      expect(el!.textContent).toContain(domains[d.key]!.modules[m.key]!.text)
    }
  })

  it('les modules récents demandés sont présents', () => {
    const { container } = render(<HomePage />)
    const text = sectionOf(container, 'modules').textContent ?? ''
    for (const label of [
      'Climat social', 'Marque employeur', 'Badgeuse et pointage', 'Lien pointage → paie', 'Onboarding',
      'Offboarding et solde de tout compte', 'Gestion disciplinaire', 'Plans de succession',
      'Référentiel postes et compétences', 'Calibrage 9-box', 'Mobilités internes', 'Organigramme',
      "Simulations d'entretien", 'Signature électronique', 'Classification des données', 'SSO OIDC, SAML, LDAP',
      'Export SIEM', 'Interface SAGE', 'Virement bancaire', 'Salaires par Mobile Money', 'Cabinets de recrutement',
      'Vue direction générale 360°', 'Assistant IA',
    ]) expect(text, label).toContain(label)
  })

  it('chaque module rattaché au catalogue existe réellement dans le code (MODULE_KEYS)', () => {
    const keys = new Set<string>(MODULE_KEYS)
    for (const d of HOME_DOMAINS) for (const m of d.modules) {
      if (m.module !== null) expect(keys.has(m.module), `${m.key} → ${m.module}`).toBe(true)
    }
    expect(CATALOG_MODULE_COUNT).toBe(MODULE_KEYS.length)
  })

  it("n'annonce pas les travaux en cours sur d'autres branches", () => {
    const all = JSON.stringify(frHome) + JSON.stringify(enHome)
    expect(all).not.toMatch(/simulateur de paie|payroll simulator|habilitations? RH par filiale|correction de la paie/i)
  })
})

describe('HomePage — confiance, contacts et FAQ', () => {
  it("expose l'éditeur, ses coordonnées et les documents légaux", () => {
    const { container } = render(<HomePage />)
    const section = sectionOf(container, 'confiance')
    const text = section.textContent ?? ''
    for (const s of [
      'OpenLab Consulting', 'Cocody, Rivièra Faya Lauriers 8, Abidjan', 'infos@openlabconsulting.com',
      'support@nexusrh-ci.com', '7h30 – 18h00', 'conçu pour accompagner la conformité à la loi n° 2013-450',
    ]) expect(text, s).toContain(s)
    expect(section.querySelector('a[href="/legal/mentions-legales"]')).toBeTruthy()
    expect(section.querySelector('a[href="/legal/confidentialite"]')).toBeTruthy()
  })

  it('téléphones : exactement les trois numéros publiés, dans l’ordre, en liens tel: E.164', () => {
    expect(PHONES.map(p => p.display)).toEqual(['+225 07 09 33 42 38', '+225 07 49 43 92 03', '+33 6 19 24 53 29'])
    const { container } = render(<HomePage />)
    const tels = [...new Set([...container.querySelectorAll('a[href^="tel:"]')].map(a => a.getAttribute('href')))]
    expect(tels).toEqual(['tel:+2250709334238', 'tel:+2250749439203', 'tel:+33619245329'])
    const text = sectionOf(container, 'confiance').textContent ?? ''
    for (const p of PHONES) expect(text).toContain(p.display)
  })

  it('WhatsApp : tous les liens wa.me pointent vers 2250749439203', () => {
    const { container } = render(<HomePage />)
    const wa = [...container.querySelectorAll('a[href*="wa.me"]')].map(a => a.getAttribute('href'))
    expect(wa.length).toBeGreaterThan(0)
    for (const h of wa) expect(h).toBe('https://wa.me/2250749439203')
  })

  it('aucun ancien numéro ne subsiste (page rendue, traductions)', () => {
    const { container } = render(<HomePage />)
    const all = container.innerHTML + JSON.stringify(frHome) + JSON.stringify(enHome)
    expect(all).not.toMatch(/07 ?09 ?32 ?05 ?94|0709320594/)
  })

  it('FAQ visible de 8 à 10 questions, chacune avec sa réponse', () => {
    const { container } = render(<HomePage />)
    const items = container.querySelectorAll('[data-faq]')
    expect(items.length).toBe(HOME_FAQ.length)
    expect(items.length).toBeGreaterThanOrEqual(8)
    expect(items.length).toBeLessThanOrEqual(10)
    for (const it of items) {
      expect(it.querySelector('h3')?.textContent?.length).toBeGreaterThan(10)
      expect(it.querySelector('p')?.textContent?.length).toBeGreaterThan(20)
    }
  })

  it('couverture pays : formulation validée, la Côte d’Ivoire en pays de référence', () => {
    const cover = "Paie : Côte d'Ivoire et UEMOA, extensible aux autres pays de la CEDEAO et de la CEMAC"
    expect(frHome.hero.coverage).toBe(cover)
    expect(frHome.faq.items.coverage.a.startsWith(`${cover}.`)).toBe(true)
    expect(frHome.hero.lead).toBe(
      "NexusRH gère la paie et les ressources humaines de votre entreprise selon le droit social de votre pays : " +
      "Côte d'Ivoire et UEMOA, extensible aux autres pays de la CEDEAO et de la CEMAC.")
    expect(enHome.hero.lead).toBe(
      "NexusRH runs your company's payroll and HR in line with your country's labour law: " +
      "Côte d'Ivoire and WAEMU, extendable to other ECOWAS and CEMAC countries.")
    expect(JSON.stringify(frHome)).not.toMatch(/droit ivoirien|Seize|Sénégal|Cameroun|Ghana|Nigeria/)
  })
})

describe('HomePage — règle d’or : rien d’inventé', () => {
  it('ni témoignage, ni certification, ni note, ni chiffre de disponibilité, ni prix', () => {
    const all = JSON.stringify(frHome) + JSON.stringify(enHome)
    expect(all).not.toMatch(/ISO ?27001|SOC ?2|certifi|témoign|testimonial|avis client|étoiles|99[,.]\d ?%|FCFA ?\/ ?mois|FCFA (per|a) month|\/ ?month/i)
  })

  it('nom du produit : « NexusRH », jamais « NexusRH CI »', () => {
    const { container } = render(<HomePage />)
    expect(container.textContent).not.toMatch(/NexusRH CI/)
    expect(JSON.stringify(frHome) + JSON.stringify(enHome)).not.toMatch(/NexusRH CI/)
  })

  it('FR et EN : mêmes clés (tout texte nouveau ou modifié existe dans les deux langues)', () => {
    expect(leafKeys(enHome).sort()).toEqual(leafKeys(frHome).sort())
  })
})
