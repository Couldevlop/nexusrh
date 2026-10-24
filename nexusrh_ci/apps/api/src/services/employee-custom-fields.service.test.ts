import { describe, it, expect } from 'vitest'
import {
  fieldDefinitionsSchema, parseFieldDefinitions, redactCustomFields, validateCustomFieldValues,
  MAX_CUSTOM_FIELDS, type CustomFieldDefinition,
} from './employee-custom-fields.service.js'

const DEFS: CustomFieldDefinition[] = [
  { key: 'matricule', label: 'Matricule interne', type: 'text', required: true, sensitive: false },
  { key: 'groupe_sanguin', label: 'Groupe sanguin', type: 'select', required: false, sensitive: true,
    options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
  { key: 'prime_anciennete', label: 'Prime ancienneté', type: 'number', required: false, sensitive: false },
  { key: 'visite_medicale', label: 'Dernière visite médicale', type: 'date', required: false, sensitive: false },
  { key: 'vehicule', label: 'Véhicule de fonction', type: 'boolean', required: false, sensitive: false },
]

describe('fieldDefinitionsSchema — configuration admin', () => {
  it('accepte une configuration valide et applique les défauts', () => {
    const r = fieldDefinitionsSchema.safeParse([{ key: 'badge', label: 'N° de badge', type: 'text' }])
    expect(r.success).toBe(true)
    expect(r.success && r.data[0]).toMatchObject({ required: false, sensitive: false })
  })
  it('refuse une clé mal formée (injection de clé jsonb)', () => {
    for (const key of ['__proto__', 'Badge', '1abc', 'a', 'a-b', 'constructor x']) {
      expect(fieldDefinitionsSchema.safeParse([{ key, label: 'X', type: 'text' }]).success).toBe(false)
    }
  })
  it('refuse les clés en double', () => {
    const f = { key: 'badge', label: 'X', type: 'text' }
    expect(fieldDefinitionsSchema.safeParse([f, f]).success).toBe(false)
  })
  it('liste : options obligatoires, uniques ; options interdites hors liste', () => {
    expect(fieldDefinitionsSchema.safeParse([{ key: 'site', label: 'Site', type: 'select' }]).success).toBe(false)
    expect(fieldDefinitionsSchema.safeParse([{ key: 'site', label: 'Site', type: 'select', options: ['A', 'A'] }]).success).toBe(false)
    expect(fieldDefinitionsSchema.safeParse([{ key: 'site', label: 'Site', type: 'text', options: ['A'] }]).success).toBe(false)
  })
  it(`borne le nombre de champs à ${MAX_CUSTOM_FIELDS}`, () => {
    const many = Array.from({ length: MAX_CUSTOM_FIELDS + 1 }, (_, i) => ({ key: `champ_${i}`, label: 'X', type: 'text' }))
    expect(fieldDefinitionsSchema.safeParse(many).success).toBe(false)
  })
  it('refuse toute propriété inconnue', () => {
    expect(fieldDefinitionsSchema.safeParse([{ key: 'badge', label: 'X', type: 'text', script: 'x' }]).success).toBe(false)
  })
  it('lecture en base tolérante : config corrompue → aucun champ', () => {
    expect(parseFieldDefinitions(null)).toEqual([])
    expect(parseFieldDefinitions('oops')).toEqual([])
    expect(parseFieldDefinitions([{ key: 'X' }])).toEqual([])
  })
})

describe('validateCustomFieldValues — création', () => {
  it('valide et convertit chaque type', () => {
    const r = validateCustomFieldValues(DEFS, {
      matricule: '  M-0042 ', groupe_sanguin: 'O+', prime_anciennete: '15000,5',
      visite_medicale: '2026-03-01', vehicule: true,
    }, 'create')
    expect(r).toEqual({ ok: true, values: {
      matricule: 'M-0042', groupe_sanguin: 'O+', prime_anciennete: 15000.5,
      visite_medicale: '2026-03-01', vehicule: true,
    } })
  })
  it('champ obligatoire manquant → erreur', () => {
    const r = validateCustomFieldValues(DEFS, {}, 'create')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.map((e) => e.key)).toEqual(['matricule'])
  })
  it('clé non définie → refusée (le jsonb n\'est pas un fourre-tout)', () => {
    const r = validateCustomFieldValues(DEFS, { matricule: 'M1', salaire_cache: 1 }, 'create')
    expect(!r.ok && r.errors[0]).toMatchObject({ key: 'salaire_cache' })
  })
  it('types invalides → erreurs explicites', () => {
    const r = validateCustomFieldValues(DEFS, {
      matricule: 'M1', groupe_sanguin: 'Z', prime_anciennete: 'abc',
      visite_medicale: '2026-02-30', vehicule: 'oui',
    }, 'create')
    expect(!r.ok && r.errors.map((e) => e.key).sort()).toEqual(
      ['groupe_sanguin', 'prime_anciennete', 'vehicule', 'visite_medicale'])
  })
  it('texte borné à 500 caractères', () => {
    const r = validateCustomFieldValues(DEFS, { matricule: 'x'.repeat(501) }, 'create')
    expect(r.ok).toBe(false)
  })
  it('corps non objet → refusé', () => {
    expect(validateCustomFieldValues(DEFS, ['x'], 'create').ok).toBe(false)
    expect(validateCustomFieldValues(DEFS, 'x', 'create').ok).toBe(false)
  })
})

describe('validateCustomFieldValues — modification', () => {
  const existing = { matricule: 'M1', prime_anciennete: 1000, ancien_champ: 'conservé' }
  it('fusionne avec l\'existant ; une valeur vide efface la clé', () => {
    const r = validateCustomFieldValues(DEFS, { prime_anciennete: '', vehicule: false }, 'update', existing)
    expect(r).toEqual({ ok: true, values: { matricule: 'M1', vehicule: false, ancien_champ: 'conservé' } })
  })
  it('vider un champ obligatoire → refusé', () => {
    expect(validateCustomFieldValues(DEFS, { matricule: '' }, 'update', existing).ok).toBe(false)
  })
  it('un champ devenu obligatoire ne bloque pas la modification d\'un autre champ', () => {
    const r = validateCustomFieldValues(DEFS, { vehicule: true }, 'update', {})
    expect(r.ok).toBe(true)
  })
})

describe('redactCustomFields — lecteurs sans accès sensible', () => {
  it('masque les champs sensibles et les clés orphelines', () => {
    const values = { matricule: 'M1', groupe_sanguin: 'O+', ancien_champ: 'x' }
    expect(redactCustomFields(DEFS, values)).toEqual({ matricule: 'M1' })
  })
  it('sans définitions (lecture en échec) : tout est masqué', () => {
    expect(redactCustomFields([], { matricule: 'M1' })).toEqual({})
    expect(redactCustomFields(DEFS, null)).toEqual({})
  })
})
