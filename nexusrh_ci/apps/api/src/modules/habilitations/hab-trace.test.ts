/**
 * Classement du résultat d'une requête d'habilité (tâche 13, amendement du
 * 04/11/2026 : « toutes ses actions doivent être tracées et consultables »).
 *
 * Ce que ce banc protège : la trace doit dire POURQUOI un accès a été refusé
 * alors que la réponse HTTP, elle, ne doit rien en dire (un 404 de périmètre
 * reste un 404 indistinguable, sinon il révèle l'existence de la ligne). Les
 * deux exigences vivent ici : la cause est classée côté serveur, et seules des
 * clés de permission, des noms de champs et des noms de filtres entrent dans
 * `changes` — jamais une valeur saisie, jamais un body.
 */
import { describe, it, expect } from 'vitest'
import { classifyHabResult, habTraceEntry } from './hab-trace.js'

describe('classifyHabResult', () => {
  it('une réponse servie : allowed', () => {
    expect(classifyHabResult({ statusCode: 200 })).toBe('allowed')
    expect(classifyHabResult({ statusCode: 201 })).toBe('allowed')
  })

  it('un 403 de la grille : denied_permission', () => {
    expect(classifyHabResult({ statusCode: 403, denial: 'permission' })).toBe('denied_permission')
    expect(classifyHabResult({ statusCode: 403 })).toBe('denied_permission')
  })

  it('le refus « son propre dossier » prime sur le code HTTP', () => {
    expect(classifyHabResult({ statusCode: 403, denial: 'self' })).toBe('denied_self')
  })

  it('un 404 d\'un utilisateur à périmètre restreint : denied_scope', () => {
    expect(classifyHabResult({ statusCode: 404, scopeRestricted: true })).toBe('denied_scope')
  })

  it('un vrai 404, hors restriction de périmètre, n\'est pas un refus de périmètre', () => {
    expect(classifyHabResult({ statusCode: 404 })).toBe('allowed')
    expect(classifyHabResult({ statusCode: 404, scopeRestricted: false })).toBe('allowed')
  })

  it('une réponse servie avec des champs masqués : masked', () => {
    expect(classifyHabResult({ statusCode: 200, maskedFields: ['base_salary'] })).toBe('masked')
  })

  it('un refus prime sur le masquage', () => {
    expect(classifyHabResult({ statusCode: 403, denial: 'permission', maskedFields: ['iban'] }))
      .toBe('denied_permission')
  })

  it('une panne technique (5xx) n\'est pas une décision d\'habilitation', () => {
    expect(classifyHabResult({ statusCode: 500 })).toBeNull()
    expect(classifyHabResult({ statusCode: 503 })).toBeNull()
  })

  it('une requête invalide (400/409) reste un accès accordé', () => {
    expect(classifyHabResult({ statusCode: 400 })).toBe('allowed')
    expect(classifyHabResult({ statusCode: 409 })).toBe('allowed')
  })
})

const ID = '55555555-5555-4555-8555-555555555555'

describe('habTraceEntry', () => {
  it('une lecture de liste est tracée comme hr.<fn>.view', () => {
    const e = habTraceEntry({ method: 'GET', routeUrl: '/employees', statusCode: 200 }, { subgroupId: 'sg-1' })
    expect(e).toMatchObject({ action: 'hr.employees.view', entity: 'employees', entityId: null })
    expect(e?.changes).toMatchObject({ route: '/employees', result: 'allowed', subgroupId: 'sg-1' })
  })

  it('une écriture par id porte l\'identifiant de la ligne', () => {
    const e = habTraceEntry(
      { method: 'PATCH', routeUrl: '/employees/:id', statusCode: 200, paramId: ID },
      { subgroupId: null },
    )
    expect(e).toMatchObject({ action: 'hr.employees.update', entityId: ID })
  })

  it('un identifiant non-UUID n\'entre pas dans la trace', () => {
    const e = habTraceEntry(
      { method: 'GET', routeUrl: '/employees/:id', statusCode: 200, paramId: 'MAT00084' },
      { subgroupId: null },
    )
    expect(e?.entityId).toBeNull()
  })

  it('les filtres sont tracés par leurs NOMS, jamais par leurs valeurs', () => {
    const e = habTraceEntry(
      { method: 'GET', routeUrl: '/employees', statusCode: 200, filterKeys: ['search', 'legalEntityId'] },
      { subgroupId: null },
    )
    expect(e?.changes).toMatchObject({ filters: ['search', 'legalEntityId'] })
    expect(JSON.stringify(e?.changes)).not.toContain('MAT')
  })

  it('les champs masqués sont nommés dans la trace', () => {
    const e = habTraceEntry(
      { method: 'GET', routeUrl: '/employees/:id', statusCode: 200, paramId: ID, maskedFields: ['base_salary', 'iban'] },
      { subgroupId: null },
    )
    expect(e?.changes).toMatchObject({ result: 'masked', maskedFields: ['base_salary', 'iban'] })
  })

  it('une route hors grille RH n\'est pas tracée', () => {
    expect(habTraceEntry({ method: 'GET', routeUrl: '/auth/me', statusCode: 200 }, { subgroupId: null })).toBeNull()
  })

  it('une panne technique n\'est pas tracée', () => {
    expect(habTraceEntry({ method: 'GET', routeUrl: '/employees', statusCode: 500 }, { subgroupId: null })).toBeNull()
  })
})
