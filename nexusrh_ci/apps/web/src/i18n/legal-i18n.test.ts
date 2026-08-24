/**
 * Parité FR/EN des pages légales. Un texte juridique amputé d'une section dans
 * une langue est pire qu'absent : il donne l'illusion d'un document complet.
 */
import { describe, it, expect } from 'vitest'
import fr from './locales/fr/legal.json'
import en from './locales/en/legal.json'
import { LEGAL_SLUGS } from '@/pages/public/LegalPage'

function flatten(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === 'object'
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`])
}

describe('i18n pages légales', () => {
  it('expose les mêmes clés en français et en anglais', () => {
    expect(flatten(en as Record<string, unknown>).sort())
      .toEqual(flatten(fr as Record<string, unknown>).sort())
  })

  it('publie les quatre documents attendus', () => {
    expect(LEGAL_SLUGS).toEqual(['mentions-legales', 'confidentialite', 'conditions', 'cookies'])
    const docs = (fr as { docs: Record<string, unknown> }).docs
    expect(Object.keys(docs).sort()).toEqual(['cookies', 'notice', 'privacy', 'terms'])
  })

  it('ne laisse aucune section vide', () => {
    for (const [lang, dict] of [['fr', fr], ['en', en]] as const) {
      for (const key of flatten(dict as Record<string, unknown>)) {
        const v = key.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], dict)
        expect(String(v).trim().length, `${lang} ${key}`).toBeGreaterThan(0)
      }
    }
  })
})
