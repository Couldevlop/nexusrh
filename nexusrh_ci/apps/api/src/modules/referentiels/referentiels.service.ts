/**
 * Service Référentiels — Architecture double couche
 *   PostgreSQL (schema droit_ci) : source de vérité persistante
 *   Meilisearch                 : moteur de recherche plein texte (index seul)
 *
 * OWASP A01 : filtre access_level = 'public' sur chaque requête moteur + Drizzle
 * OWASP A03 : filtres par liste blanche de champs, valeurs échappées — zéro
 *             concaténation d'une saisie utilisateur
 * OWASP A08 : checksum SHA-256 vérifié à l'indexation
 */
import {
  meiliClient, indexDroit, ensureIndex, filtreEgalite, DELAI_INDEXATION,
} from '../../services/meilisearch.js'
import { ALL_ARTICLES } from '../../data/code-travail-ci.js'
import { CODE_TRAVAIL_BEN, CONVENTIONS_COLLECTIVES_BEN } from '../../data/code-travail-ben.js'
import { CODE_TRAVAIL_TGO, CONVENTIONS_COLLECTIVES_TGO } from '../../data/code-travail-tgo.js'
import { CODE_TRAVAIL_TCD } from '../../data/code-travail-tcd.js'
import { CODE_TRAVAIL_NGA } from '../../data/code-travail-nga.js'
import {
  upsertArticles,
  desactiverArticlesAbsentsDuCorpus,
  getAllActiveArticles,
  getArticleByIdFromDb,
  getArticlesByPayrollCodeFromDb,
  countArticles,
  searchArticlesFromDb,
  getHierarchyTreeFromDb,
} from './legal-articles.repository.js'
import type { ArticleInput } from './legal-articles.repository.js'

/**
 * Corpus juridique multi-pays. CIV par défaut (rétro-compat), enrichi avec
 * les pays UEMOA + Tchad + Nigeria. La source de vérité reste PostgreSQL ;
 * ces fichiers sont uniquement utilisés au seed initial.
 */
const ALL_COUNTRIES_ARTICLES: ArticleInput[] = [
  // CI — articles existants : on injecte country_code='CIV' explicitement
  ...ALL_ARTICLES.map(a => ({ ...a, country_code: a.country_code ?? 'CIV' }) as ArticleInput),
  ...CODE_TRAVAIL_BEN as ArticleInput[],
  ...CONVENTIONS_COLLECTIVES_BEN as ArticleInput[],
  ...CODE_TRAVAIL_TGO as ArticleInput[],
  ...CONVENTIONS_COLLECTIVES_TGO as ArticleInput[],
  ...CODE_TRAVAIL_TCD as ArticleInput[],
  ...CODE_TRAVAIL_NGA as ArticleInput[],
]

export interface SearchParams {
  q: string
  /** Source du texte (élargi multi-pays) : code_travail_ci, code_travail_ben, … */
  source?: string
  /** Filtre par pays ISO-3 (CIV, BEN, TGO, …). NULL = tous. */
  countryCode?: string
  convention?: string
  payrollCode?: string
  livre?: string
  from?: number
  size?: number
}

export interface ArticleHit {
  article_id: string; article_numero: string; source: string
  country_code?: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; titre_article: string; texte: string
  payroll_codes?: string[]; score: number
  highlight?: { texte?: string[]; titre_article?: string[] }
}

/**
 * Convertit les documents rendus par le moteur en `ArticleHit`.
 *
 * `_formatted` porte les champs surlignés ; il est retiré du document pour ne
 * pas fuiter dans la réponse de l'API, et reprojeté sous la forme `highlight`
 * qu'attend la page Référentiels.
 */
function enArticles(documents: Record<string, unknown>[]): ArticleHit[] {
  return documents.map(h => {
    const formate = h._formatted as Record<string, string> | undefined
    // Les champs techniques du moteur ne doivent pas fuiter dans la reponse
    // de l'API : ils sont retires du document avant projection.
    const { _formatted: _ignore, _rankingScore: _score, ...document } = h
    const surligne = formate
      ? {
          ...(formate.texte ? { texte: [formate.texte] } : {}),
          ...(formate.titre_article ? { titre_article: [formate.titre_article] } : {}),
        }
      : undefined
    return {
      ...(document as unknown as ArticleHit),
      // Score de pertinence REEL : `showRankingScore` le fait rendre par le
      // moteur, entre 0 et 1. Sans cette option Meilisearch classe sans
      // chiffrer, et le champ `score` du contrat aurait du etre invente.
      score: typeof h._rankingScore === 'number' ? h._rankingScore : 1,
      ...(surligne && Object.keys(surligne).length > 0 ? { highlight: surligne } : {}),
    }
  })
}

/**
 * Recherche plein texte.
 *
 * Meilisearch ne pondère pas les champs par un coefficient comme le
 * `multi_match` d'Elasticsearch : il les CLASSE, dans l'ordre déclaré par
 * `searchableAttributes` (voir `services/meilisearch.ts`). L'ancien
 * `article_numero^5 / titre_article^3 / keywords^2 / texte` devient donc cet
 * ordre-là. La tolérance aux fautes, que l'ancien code demandait par
 * `fuzziness: 'AUTO'`, est native et active par défaut.
 *
 * OWASP A01 — `access_level = "public"` est toujours le premier filtre.
 * OWASP A03 — aucune concaténation : `filtreEgalite` n'accepte qu'un champ de
 * la liste blanche et échappe la valeur.
 */
export async function searchReferentiel(params: SearchParams): Promise<{ total: number; hits: ArticleHit[] }> {
  const { q, source, countryCode, convention, payrollCode, livre, from = 0, size = 10 } = params
  const isBrowse = !q || q === '*'

  try {
    const filtres = [filtreEgalite('access_level', 'public')]
    if (source)      filtres.push(filtreEgalite('source', source))
    if (countryCode) filtres.push(filtreEgalite('country_code', countryCode))
    if (convention)  filtres.push(filtreEgalite('convention_slug', convention))
    if (payrollCode) filtres.push(filtreEgalite('payroll_codes', payrollCode))
    if (livre)       filtres.push(filtreEgalite('livre', livre))

    // Pagination : `page`/`hitsPerPage` fait rendre à Meilisearch un total
    // EXHAUSTIF (`totalHits`), là où `offset`/`limit` ne donne qu'une
    // estimation. L'interface pagine toujours par multiples de `size`, donc le
    // calcul de page est exact ; le cas non aligné reste traité par offset.
    const pagine = size > 0 && from % size === 0
    // Les options de surlignage sont communes aux deux modes de pagination.
    // Le même balisage <em> que l'ancien surlignage Elasticsearch : la page
    // Référentiels échappe tout le HTML puis ne restaure que <em>/</em>.
    const surlignage = {
      filter: filtres.join(' AND '),
      attributesToHighlight: ['texte', 'titre_article'],
      showRankingScore: true,
      attributesToCrop: ['texte'],
      cropLength: 40,
      highlightPreTag: '<em>',
      highlightPostTag: '</em>',
    }
    const requete = isBrowse ? '' : q

    // Les deux appels sont écrits séparément À DESSEIN. Le SDK type la réponse
    // d'après les options reçues : `page`/`hitsPerPage` donne `totalHits`
    // (exhaustif), `offset`/`limit` donne `estimatedTotalHits`. Passer un objet
    // d'options construit par un ternaire rendait le type incertain et forçait
    // une assertion — ici chaque branche est exacte, sans `as`.
    const { hits, total } = pagine
      ? await (async () => {
          const r = await indexDroit().search(requete, {
            ...surlignage, page: Math.floor(from / size) + 1, hitsPerPage: size,
          })
          return { hits: enArticles(r.hits), total: r.totalHits }
        })()
      : await (async () => {
          const r = await indexDroit().search(requete, {
            ...surlignage, offset: from, limit: size,
          })
          return { hits: enArticles(r.hits), total: r.estimatedTotalHits }
        })()

    // Index vide ou en retard sur PostgreSQL : la source de vérité répond.
    if (hits.length === 0) {
      const pg = await searchArticlesFromDb({ q, source, livre, countryCode, from, size })
      if (pg.total > 0) return { total: pg.total, hits: pg.hits.map(a => ({ ...a, score: 1 }) as ArticleHit) }
    }
    return { total, hits }
  } catch {
    // Moteur indisponible — PostgreSQL reste la source de vérité.
    const result = await searchArticlesFromDb({ q, source, livre, countryCode, from, size })
    return {
      total: result.total,
      hits: result.hits.map(a => ({ ...a, score: 1 }) as ArticleHit),
    }
  }
}

/**
 * Arborescence source → livre.
 *
 * Elle est lue en PostgreSQL, et seulement là. L'ancienne version demandait à
 * Elasticsearch une agrégation imbriquée (`by_source` → `by_livre`) ;
 * Meilisearch ne rend que des distributions de facettes PLATES, qui ne
 * reproduisent pas cette imbrication. Comme la réponse PostgreSQL existait
 * déjà, était exacte et portait la même forme, c'est elle qui sert — un
 * chemin de moins, et aucune divergence possible entre les deux.
 */
export async function getHierarchyTree(): Promise<unknown> {
  return getHierarchyTreeFromDb()
}

/**
 * Article par identifiant. Lu en PostgreSQL : c'est une correspondance exacte
 * sur la clé primaire, qu'aucun moteur de recherche ne fait mieux que la base
 * qui détient la donnée. L'ancienne version interrogeait Elasticsearch puis
 * repliait sur PostgreSQL ; le moteur n'apportait rien et pouvait servir un
 * document périmé.
 */
export async function getArticleById(articleId: string): Promise<ArticleHit | null> {
  const art = await getArticleByIdFromDb(articleId)
  return art ? { ...art, payroll_codes: art.payroll_codes, score: 1 } as ArticleHit : null
}

/** Articles liés à une rubrique de paie. Même raison : correspondance exacte. */
export async function getArticlesByPayrollCode(code: string): Promise<ArticleHit[]> {
  const arts = await getArticlesByPayrollCodeFromDb(code)
  return arts.map(a => ({ ...a, payroll_codes: a.payroll_codes, score: 1 }) as ArticleHit)
}

/**
 * Seed complet : fichier de données → PostgreSQL → index de recherche
 * Étape 1 : upsert tous les articles en PG (source de vérité)
 * Étape 2 : réindexer le moteur depuis PG
 */
export async function seedReferentiel(): Promise<{
  persisted: number; indexed: number; desactives: number
}> {
  // Étape 1 — écrire le corpus. TOUJOURS avant la désactivation : les deux
  // ordres donnent le même état final, mais celui-ci est le seul sûr. Les deux
  // requêtes ne partagent pas de transaction ; désactiver d'abord ouvrirait une
  // fenêtre où, si l'écriture échoue, la production resterait avec un Code à
  // moitié éteint. En écrivant d'abord, un échec ne laisse rien de désactivé.
  const persisted = await upsertArticles(ALL_COUNTRIES_ARTICLES)

  // Étape 2 — retirer du service les articles qui ont quitté le corpus.
  //
  // Sans cette étape, corriger le fichier ne corrigeait rien pour les
  // utilisateurs : l'upsert n'efface jamais, et le seed au démarrage ne se
  // déclenche que sur table vide — ce qu'elle n'est jamais en production.
  // Les articles erronés du corpus rédigé à la main y ont survécu ainsi.
  //
  // L'étape 1 vient de réécrire les textes annexes sous leur propre source :
  // ils ne sont donc plus candidats à la désactivation, qui ne vise que les
  // articles restés sous `code_travail_ci` et absents du fichier.
  const idsCorpus = ALL_COUNTRIES_ARTICLES
    .filter(a => a.source === 'code_travail_ci' && (a.country_code ?? 'CIV') === 'CIV')
    .map(a => a.article_id)
  const desactives = await desactiverArticlesAbsentsDuCorpus('code_travail_ci', 'CIV', idsCorpus)

  // Étape 3 — le moteur de recherche, si disponible (non bloquant)
  let indexed = 0
  try {
    await ensureIndex()
    // Un article désactivé doit disparaître de l'index : la réindexation ne
    // lit que les articles actifs et laisserait sinon le document en place.
    if (desactives.length > 0) {
      const suppression = await indexDroit().deleteDocuments(desactives)
      await meiliClient().tasks.waitForTask(suppression.taskUid, { timeout: DELAI_INDEXATION })
    }
    indexed = await reindexFromDb()
  } catch {
    // Moteur indisponible — les articles sont en PG, le repli PG sera utilisé.
  }

  return { persisted, indexed, desactives: desactives.length }
}

/**
 * Réindexe le moteur depuis PostgreSQL (admin uniquement).
 * Reconstruit l'index sans toucher aux données.
 *
 * `article_id` étant la clé primaire de l'index, `addDocuments` écrase chaque
 * document au lieu d'en créer un doublon. La tâche est ATTENDUE : Meilisearch
 * indexe de façon asynchrone, et rendre le compte avant la fin de la tâche
 * afficherait un nombre d'articles indexés qui n'est pas encore vrai.
 */
export async function reindexFromDb(): Promise<number> {
  await ensureIndex()
  const articles = await getAllActiveArticles()
  if (articles.length === 0) return 0

  const documents = articles.map(a => ({
    article_id:      a.article_id,
    article_numero:  a.article_numero,
    country_code:    a.country_code ?? 'CIV',
    source:          a.source,
    convention_slug: a.convention_slug,
    livre:           a.livre,
    titre:           a.titre,
    chapitre:        a.chapitre,
    titre_article:   a.titre_article,
    texte:           a.texte,
    keywords:        a.keywords ?? [],
    payroll_codes:   a.payroll_codes ?? [],
    access_level:    a.access_level ?? 'public',
    tenant_id:       'public',
  }))

  const tache = await indexDroit().addDocuments(documents, { primaryKey: 'article_id' })
  const fin = await meiliClient().tasks.waitForTask(tache.taskUid, { timeout: DELAI_INDEXATION })
  if (fin.status === 'failed') {
    console.error('[recherche] indexation en échec :', fin.error?.code ?? 'cause inconnue')
    return 0
  }
  return articles.length
}

/**
 * Stats pour le tableau de bord admin.
 *
 * `es_count` garde son nom : c'est le contrat lu par `CorpusJuridiqueCard`,
 * qui affiche « indisponible » quand la valeur est négative. Le champ compte
 * désormais les documents de l'index Meilisearch.
 */
export async function getReferentielStats(): Promise<{ pg_count: number; es_count: number }> {
  const [pgCount, indexCount] = await Promise.all([
    countArticles(),
    indexDroit().getStats()
      .then(s => s.numberOfDocuments)
      .catch(() => -1),
  ])
  return { pg_count: pgCount, es_count: indexCount }
}
