/**
 * Parité des clés FR/EN de la page d'accueil publique. Une clé présente d'un
 * seul côté produit un texte manquant sur la page vitrine — le premier écran
 * que voit un prospect.
 */
import { describe, it, expect } from 'vitest'
import fr from './locales/fr/home.json'
import en from './locales/en/home.json'

function flatten(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === 'object'
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('i18n page d\'accueil', () => {
  it('expose exactement les mêmes clés en français et en anglais', () => {
    const keysFr = flatten(fr as Record<string, unknown>).sort()
    const keysEn = flatten(en as Record<string, unknown>).sort()
    expect(keysEn).toEqual(keysFr)
  })

  it('ne laisse aucune valeur vide', () => {
    for (const [lang, dict] of [['fr', fr], ['en', en]] as const) {
      const values = flatten(dict as Record<string, unknown>).map(k =>
        k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], dict))
      for (const v of values) expect(String(v).trim(), `${lang} : valeur vide`).not.toBe('')
    }
  })
})
