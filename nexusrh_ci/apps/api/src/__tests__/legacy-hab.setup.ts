/**
 * Setup global Vitest — habilitations RH.
 *
 * `authorize()` consulte désormais le moteur d'habilitation (une requête SQL)
 * pour les rôles RH. Les tests existants simulent la base par des mocks de
 * `pg` qui ne modélisent pas `hab_assignments` (résultat `undefined` ou file de
 * réponses séquentielles) : sans ce setup, la requête d'habilitation
 * consommerait leurs réponses ou échouerait, et la route répondrait 403
 * (fermé par défaut).
 *
 * On reproduit donc ici le cas réel de ces tests : AUCUNE affectation
 * (`loadHabContext` → null, accès hérité par rôle). Le reste du module reste le
 * vrai. Les tests qui portent sur les habilitations remplacent ce mock par le
 * leur (auth.habilitations.test.ts) ou le retirent (habilitation.service.test.ts).
 */
import { vi } from 'vitest'

vi.mock('../services/habilitation.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/habilitation.service.js')>()
  return { ...actual, loadHabContext: vi.fn(async () => null) }
})
