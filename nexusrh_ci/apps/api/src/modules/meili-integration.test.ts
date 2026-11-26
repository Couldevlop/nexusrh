/**
 * Intégration RÉELLE avec Meilisearch — pas de mock.
 *
 * POURQUOI. Le port d'Elasticsearch vers Meilisearch a buté sur un comportement
 * qu'aucun mock n'aurait montré : `createIndex` sur un index déjà présent NE
 * LÈVE PAS, il renvoie une tâche qui échoue ensuite avec `index_already_exists`.
 * Un test à base de mocks aurait validé un code faux. Celui-ci parle à un
 * moteur.
 *
 * Il est IGNORÉ sauf si `MEILI_TEST_URL` est renseignée, pour que la CI, qui n'a
 * pas de moteur, reste verte :
 *   docker run -d --rm -p 7702:7700 -e MEILI_MASTER_KEY=essai getmeili/meilisearch:v1.10
 *   MEILI_TEST_URL=http://localhost:7702 MEILI_TEST_KEY=essai pnpm --filter api test -- meili-integration
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const URL_MOTEUR = process.env.MEILI_TEST_URL
const CLE_MOTEUR = process.env.MEILI_TEST_KEY ?? 'essai-local-master-key'

const ARTICLES = [
  {
    article_id: 'essai-conges', article_numero: '25.1', country_code: 'CIV',
    source: 'code_travail_ci', convention_slug: null, livre: 'Livre II',
    titre: 'Congés', chapitre: null,
    titre_article: 'Durée du congé payé',
    texte: 'Le travailleur acquiert deux jours et deux dixièmes de jours ouvrables de congé par mois de service effectif.',
    keywords: ['congé', 'ouvrable'], payroll_codes: ['1200'],
    access_level: 'public', tenant_id: 'public',
  },
  {
    article_id: 'essai-preavis', article_numero: '18.4', country_code: 'CIV',
    source: 'code_travail_ci', convention_slug: null, livre: 'Livre I',
    titre: 'Rupture', chapitre: null,
    titre_article: 'Durée du préavis',
    texte: 'La rupture du contrat à durée indéterminée est subordonnée à un préavis dont la durée dépend de la catégorie.',
    keywords: ['préavis'], payroll_codes: ['1900'],
    access_level: 'public', tenant_id: 'public',
  },
  {
    article_id: 'essai-reserve', article_numero: '99.9', country_code: 'CIV',
    source: 'code_travail_ci', convention_slug: null, livre: 'Livre I',
    titre: 'Réservé', chapitre: null,
    titre_article: 'Note interne sur le préavis',
    texte: 'Document réservé qui parle aussi de préavis et de congé, et qui ne doit JAMAIS sortir.',
    keywords: ['préavis'], payroll_codes: ['1900'],
    access_level: 'prive', tenant_id: 'public',
  },
]

describe.skipIf(!URL_MOTEUR)('Meilisearch — intégration réelle', () => {
  let ensureIndex: () => Promise<void>
  let indexDroit: () => any
  let meiliClient: any
  let filtreEgalite: (c: string, v: string) => string

  beforeAll(async () => {
    process.env.MEILISEARCH_URL = URL_MOTEUR
    process.env.MEILISEARCH_MASTER_KEY = CLE_MOTEUR
    process.env.MEILI_INDEX_DROIT_CI = 'essai_droit_ci'
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'secret-de-test-au-moins-trente-deux-caracteres'
    // `config.ts` valide tout l'environnement au premier import : sans une
    // DATABASE_URL, il appelle process.exit(1) et le test meurt avant de
    // parler au moteur. Aucune connexion n'est ouverte ici.
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://essai:essai@127.0.0.1:1/essai'
    const mod = await import('../services/meilisearch.js')
    ensureIndex = mod.ensureIndex
    indexDroit = mod.indexDroit
    meiliClient = mod.meiliClient
    filtreEgalite = mod.filtreEgalite

    await ensureIndex()
    const t = await indexDroit().addDocuments(ARTICLES, { primaryKey: 'article_id' })
    const fin = await meiliClient().tasks.waitForTask(t.taskUid, { timeout: 60_000 })
    expect(fin.status).toBe('succeeded')
  }, 120_000)

  it('ensureIndex est idempotent — sur un index qui existe déjà', async () => {
    // LE cas qui a révélé le défaut : l'index existe (le beforeAll vient de le
    // créer), `createIndex` enfile donc une tâche qui ÉCHOUE avec
    // `index_already_exists`, et il faut la distinguer d'un vrai échec.
    //
    // Le module mémorise sa promesse pour ne pas réenfiler de tâche à chaque
    // appel : rappeler `ensureIndex()` ici ne prouverait rien. On réimporte
    // donc le module à neuf, ce qui exerce réellement le chemin de création
    // sur un index déjà présent — sans que la production ait à exporter une
    // fonction de remise à zéro qui ne servirait qu'aux tests, ce que
    // l'invariant des exports morts a d'ailleurs refusé.
    vi.resetModules()
    const neuf = await import('../services/meilisearch.js')
    await expect(neuf.ensureIndex()).resolves.toBeUndefined()
  }, 60_000)

  it('trouve un article par un mot de son texte, et surligne avec <em>', async () => {
    const r = await indexDroit().search('ouvrables', {
      filter: filtreEgalite('access_level', 'public'),
      attributesToHighlight: ['texte'], highlightPreTag: '<em>', highlightPostTag: '</em>',
      page: 1, hitsPerPage: 10,
    })
    expect(r.hits.map((h: any) => h.article_id)).toContain('essai-conges')
    expect(r.hits[0]._formatted.texte).toContain('<em>')
  })

  it('tolère une faute de frappe sans le demander', async () => {
    // L'ancien code réclamait `fuzziness: 'AUTO'` ; ici c'est le défaut.
    const r = await indexDroit().search('preavis', {
      filter: filtreEgalite('access_level', 'public'), page: 1, hitsPerPage: 10,
    })
    expect(r.hits.map((h: any) => h.article_id)).toContain('essai-preavis')
  })

  it('OWASP A01 — le filtre access_level exclut le document réservé', async () => {
    const r = await indexDroit().search('préavis', {
      filter: filtreEgalite('access_level', 'public'), page: 1, hitsPerPage: 20,
    })
    const ids = r.hits.map((h: any) => h.article_id)
    expect(ids).toContain('essai-preavis')
    expect(ids).not.toContain('essai-reserve')
  })

  it('OWASP A03 — une valeur hostile est échappée, pas interprétée', async () => {
    // Si la valeur n'était pas échappée, ce filtre deviendrait
    //   access_level = "public" OR access_level = "prive"
    // et ferait sortir le document réservé.
    const hostile = 'public" OR access_level = "prive'
    const r = await indexDroit().search('préavis', {
      filter: filtreEgalite('access_level', hostile), page: 1, hitsPerPage: 20,
    })
    expect(r.hits).toHaveLength(0)
  })

  it('OWASP A03 — un champ hors liste blanche est refusé', () => {
    expect(() => filtreEgalite('tenant_id_bidon', 'x')).toThrow(/non autoris/)
  })

  it('rend un total exhaustif en pagination par page', async () => {
    const r = await indexDroit().search('', {
      filter: filtreEgalite('access_level', 'public'), page: 1, hitsPerPage: 1,
    })
    expect(r.hits).toHaveLength(1)
    expect(r.totalHits).toBe(2)   // les deux publics, jamais le réservé
  })
})
