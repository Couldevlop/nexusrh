/**
 * Moteur de recherche du corpus juridique — Meilisearch.
 *
 * POURQUOI MEILISEARCH, ET PAS ELASTICSEARCH. Le code interrogeait
 * Elasticsearch, qui n'a jamais été déployé : aucun objet `elasticsearch` dans
 * le namespace `nexusrh-ci`, et aucune variable `ES_*` dans la configuration de
 * production. Chaque requête tombait donc dans le `catch` et repartait sur le
 * repli PostgreSQL — lequel charge TOUS les articles actifs en mémoire pour y
 * faire un `String.includes`. Pendant ce temps Meilisearch tournait dans le
 * cluster, son URL était dans la configmap et sa clé maître injectée dans
 * l'API : l'infrastructure était câblée, le code ne l'appelait pas. C'est aussi
 * le moteur annoncé par la pile du projet (`CLAUDE.md`).
 *
 * PostgreSQL reste la SOURCE DE VÉRITÉ. Meilisearch n'est qu'un index : il peut
 * être vide, en retard ou absent sans qu'aucune donnée ne soit perdue, et le
 * repli PostgreSQL reste en place pour cette raison.
 *
 * OWASP A01 — le filtre `access_level = 'public'` est appliqué côté moteur sur
 * CHAQUE requête, jamais côté client.
 * OWASP A03 — les filtres sont construits à partir d'une liste blanche de
 * champs et de valeurs échappées (voir `filtreEgalite`), jamais par
 * concaténation d'une saisie utilisateur.
 */
import { Meilisearch } from 'meilisearch'

/**
 * Nom de l'index, LU A CHAQUE APPEL et non fige a l'import.
 *
 * Une constante calculee a l'import divergeait de `indexDroit()`, qui relit
 * l'environnement : un test qui renseigne MEILI_INDEX_DROIT_CI apres l'import
 * aurait cree un index sous un nom et interroge l'autre.
 */
export function nomIndex(): string {
  return process.env.MEILI_INDEX_DROIT_CI ?? 'droit_ci'
}

/**
 * Le moteur est configuré depuis `process.env`, PAS depuis `config.ts`, et le
 * client est créé à la première utilisation.
 *
 * Les deux choix viennent du même défaut, constaté en exécutant les tests :
 * importer `config` au chargement du module impose à tout fichier qui touche
 * ce service de fournir l'environnement COMPLET — `config.ts` valide tout et
 * appelle `process.exit(1)` sinon. Trois suites de tests mouraient ainsi avant
 * leur première assertion, et un mock partiel de `config` faisait lire `url`
 * sur `undefined`. L'ancien service Elasticsearch lisait `process.env` : c'est
 * ce contrat qui est repris.
 *
 * Création paresseuse pour la même raison : un test qui renseigne
 * `MEILISEARCH_URL` doit pouvoir le faire avant le premier appel, pas avant
 * l'import.
 */
let client: Meilisearch | undefined

export function meiliClient(): Meilisearch {
  if (!client) {
    client = new Meilisearch({
      host:   process.env.MEILISEARCH_URL ?? 'http://localhost:7701',
      apiKey: process.env.MEILISEARCH_MASTER_KEY ?? '',
    })
  }
  return client
}

export const indexDroit = (): ReturnType<Meilisearch['index']> =>
  meiliClient().index(nomIndex())

/**
 * Champs autorisés dans un filtre, et leur rôle.
 *
 * `searchableAttributes` est ORDONNÉ : Meilisearch ne pondère pas les champs
 * par un coefficient comme le `multi_match` d'Elasticsearch, il les classe.
 * L'ordre ci-dessous reproduit l'intention de l'ancien `^5 / ^3 / ^2` :
 * le numéro d'article d'abord, puis son titre, puis les mots-clés, puis le
 * texte intégral.
 */
const CHAMPS_RECHERCHABLES = ['article_numero', 'titre_article', 'keywords', 'texte']
/** Delai d'attente d'une tache Meilisearch, en millisecondes. */
const DELAI_TACHE = 30_000

/**
 * Delai d'attente d'une tache d'INDEXATION. Plus long que celui des
 * reglages : le corpus compte plusieurs centaines d'articles, et une
 * reindexation complete depasse largement trente secondes sur une machine
 * chargee. Un delai trop court ferait conclure a un echec une indexation
 * qui aboutit.
 */
export const DELAI_INDEXATION = 180_000

/** Mots vides francais : sans eux, « de » pese autant qu'un terme juridique. */
const MOTS_VIDES_FR = ['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou',
  'a', 'au', 'aux', 'en', 'dans', 'par', 'pour', 'sur', 'est', 'sont',
  'ce', 'cet', 'cette', 'qui', 'que', 'quoi', 'dont', 'il', 'elle']

const CHAMPS_FILTRABLES = [
  'access_level', 'source', 'country_code', 'convention_slug',
  'payroll_codes', 'livre', 'article_id',
]

/**
 * Échappe une valeur pour un filtre Meilisearch. La syntaxe de filtre est une
 * expression, donc une valeur non échappée contenant une apostrophe ou un
 * opérateur pourrait en altérer le sens — l'équivalent d'une injection SQL.
 * Meilisearch accepte les chaînes entre guillemets doubles avec `\"` échappé.
 */
export function filtreEgalite(champ: string, valeur: string): string {
  if (!CHAMPS_FILTRABLES.includes(champ)) {
    throw new Error(`champ de filtre non autorisé : ${champ}`)
  }
  const sure = valeur.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `${champ} = "${sure}"`
}

let indexPret: Promise<void> | undefined

/**
 * Crée l'index et applique ses réglages, une seule fois par processus.
 *
 * La promesse est mémorisée : `ensureIndex()` est appelé à l'enregistrement des
 * routes ET par le seed, et Meilisearch sérialise les changements de réglages
 * dans une file de tâches — deux appels concurrents produiraient deux tâches
 * pour rien. En cas d'échec la mémorisation est effacée, pour que l'appel
 * suivant réessaie au lieu de rendre une erreur mise en cache.
 *
 * VÉRIFIÉ CONTRE UN MOTEUR RÉEL (Meilisearch 1.10.3) : `createIndex` sur un
 * index déjà présent NE LÈVE PAS. Il renvoie une tâche enfilée qui ÉCHOUE
 * ensuite avec `index_already_exists`. Un `try/catch` autour de l'appel ne
 * verrait donc jamais rien, et traiter toute tâche en échec comme fatale
 * casserait le deuxième démarrage. D'où la distinction explicite ci-dessous.
 */
export async function ensureIndex(): Promise<void> {
  if (!indexPret) {
    indexPret = (async () => {
      // `article_id` est la clé primaire : réindexer écrase le document au lieu
      // d'en créer un second.
      const creation = await meiliClient().createIndex(nomIndex(), { primaryKey: 'article_id' })
      const finCreation = await meiliClient().tasks.waitForTask(creation.taskUid, { timeout: DELAI_TACHE })
      if (finCreation.status === 'failed' && finCreation.error?.code !== 'index_already_exists') {
        throw new Error(`création de l'index ${nomIndex()} en échec : ${finCreation.error?.code ?? 'cause inconnue'}`)
      }

      const reglages = await indexDroit().updateSettings({
        searchableAttributes: CHAMPS_RECHERCHABLES,
        filterableAttributes: CHAMPS_FILTRABLES,
        displayedAttributes: ['*'],
        // Le corpus est en français : sans cette liste, « de », « la » ou « le »
        // pèsent autant qu'un terme juridique et dégradent le classement.
        stopWords: MOTS_VIDES_FR,
      })
      // Attendre la tâche : sinon la première recherche peut arriver avant que
      // `filterableAttributes` soit en place, et Meilisearch refuse alors le
      // filtre `access_level` — c'est-à-dire la garde d'isolation elle-même.
      const finReglages = await meiliClient().tasks.waitForTask(reglages.taskUid, { timeout: DELAI_TACHE })
      if (finReglages.status === 'failed') {
        throw new Error(`réglages de l'index ${nomIndex()} en échec : ${finReglages.error?.code ?? 'cause inconnue'}`)
      }
    })().catch((err: unknown) => {
      indexPret = undefined
      throw err
    })
  }
  return indexPret
}
