/**
 * Mise en place commune des tests de composants (jsdom + Testing Library).
 *
 * POURQUOI : `waitFor` et les `findBy*` de Testing Library abandonnent au bout
 * d'UNE seconde par défaut. C'est assez quand un fichier de test tourne seul,
 * mais pas quand la suite complète s'exécute en parallèle : le rendu et la
 * résolution des requêtes mockées passent alors largement la seconde, et des
 * tests justes échouaient au hasard — `absences.test.tsx` ne trouvait pas une
 * option de liste qui finissait bien par arriver.
 *
 * Un test instable est un test qui ne prouve rien : il fait échouer la CI sur
 * un aléa de charge, et il apprend à relancer au lieu de lire. Le délai est
 * donc relevé ici, une fois, pour tous les fichiers. Cela n'affaiblit aucune
 * assertion : un test qui réussit n'attend pas, et un test qui échoue vraiment
 * échoue toujours — seulement un peu plus tard.
 */
import { configure } from '@testing-library/react'

// Le delai doit rester SOUS le `testTimeout` de vitest (voir vitest.config.ts) :
// au-dessus, une attente qui echoue fait expirer le test entier, et le rapport
// montre « Test timed out » au lieu de l'assertion qui a vraiment lache.
configure({ asyncUtilTimeout: 5_000 })
