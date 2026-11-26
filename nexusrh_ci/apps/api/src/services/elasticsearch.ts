import { Client } from '@elastic/elasticsearch'

const isK3s = process.env.NODE_ENV === 'production' && process.env.ES_CA_CERT

/**
 * Mot de passe Elasticsearch. Le repli en dur (`nexusrhci-es-dev`) ne vaut
 * qu'en développement : en production, une variable oubliée faisait démarrer le
 * client avec un identifiant écrit dans le dépôt — et le dépôt est public.
 * En production on préfère donc l'absence d'authentification à un identifiant
 * connu de tous : la connexion échoue franchement au lieu de réussir avec un
 * mot de passe publié. OWASP A05/A07.
 */
function motDePasseEs(): string | undefined {
  const fourni = process.env.ES_PASSWORD
  if (fourni) return fourni
  if (process.env.NODE_ENV === 'production') {
    console.warn('[elasticsearch] ES_PASSWORD absente en production — aucun repli, la recherche sera indisponible.')
    return undefined
  }
  return 'nexusrhci-es-dev'
}

const motDePasse = motDePasseEs()

export const esClient = new Client({
  node: process.env.ES_URL ?? 'http://localhost:9201',
  ...(motDePasse === undefined ? {} : {
    auth: {
      username: process.env.ES_USER ?? 'elastic',
      password: motDePasse,
    },
  }),
  ...(isK3s && {
    tls: {
      ca:   process.env.ES_CA_CERT,
      cert: process.env.ES_CLIENT_CERT,
      key:  process.env.ES_CLIENT_KEY,
      rejectUnauthorized: true,
    },
  }),
})

export const ES_INDEX = process.env.ES_INDEX_DROIT_CI ?? 'nexusrhci_droit_ci'

export async function ensureIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: ES_INDEX })
  if (exists) return

  await esClient.indices.create({
    index: ES_INDEX,
    settings: {
      analysis: {
        analyzer: {
          droit_ci: { type: 'french' as const, stopwords: '_french_' },
        },
      },
    } as any,
    mappings: {
      properties: {
        access_level:    { type: 'keyword' },
        tenant_id:       { type: 'keyword' },
        country_code:    { type: 'keyword' },
        source:          { type: 'keyword' },
        convention_slug: { type: 'keyword' },
        livre:           { type: 'keyword' },
        titre:           { type: 'keyword' },
        chapitre:        { type: 'keyword' },
        section:         { type: 'keyword' },
        article_id:      { type: 'keyword' },
        article_numero:  { type: 'keyword' },
        titre_article:   { type: 'text', analyzer: 'droit_ci' } as any,
        texte:           { type: 'text', analyzer: 'droit_ci' } as any,
        payroll_codes:   { type: 'keyword' },
        keywords:        { type: 'keyword' },
      },
    },
  })
}
