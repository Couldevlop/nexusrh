/**
 * Modèle des pages publiques de contenu. Le texte est de la donnée : le même
 * objet sert au rendu React (SeoContentPage), au pré-rendu (titre, meta,
 * JSON-LD) et au sitemap — impossible qu'ils divergent.
 */
import type { SeoPath } from './paths'

export type SeoBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'table'; caption: string; head: string[]; rows: string[][]; note?: string }
  | { type: 'links'; items: { to: string; label: string }[] }

export interface SeoSection {
  h2: string
  /** Ancre facultative (liens internes vers une section précise). */
  id?: string
  blocks: SeoBlock[]
}

export interface SeoPageContent {
  path: SeoPath
  lang: 'fr' | 'en'
  /** landing = page produit ; guide = article (schema Article). */
  kind: 'landing' | 'guide'
  /** <title> — ≤ 65 caractères. */
  title: string
  /** meta description — ≤ 160 caractères. */
  description: string
  h1: string
  lead: string
  /** Libellé court dans le fil d'Ariane. */
  crumb: string
  sections: SeoSection[]
  /** FAQ VISIBLE sur la page (seule condition pour publier un FAQPage). */
  faq?: { q: string; a: string }[]
  /** Pages liées (maillage interne), affichées en fin de page. */
  related: SeoPath[]
  /** Équivalent dans l'autre langue (hreflang) — uniquement s'il existe. */
  alternate?: SeoPath
  /** Date de dernière mise à jour du contenu (AAAA-MM-JJ). */
  updated: string
  /** Date de première publication (guides). */
  published?: string
}
