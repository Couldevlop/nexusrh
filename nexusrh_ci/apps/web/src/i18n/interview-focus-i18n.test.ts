import { describe, it, expect } from 'vitest'
import fr from './locales/fr/interviewFocus.json'
import en from './locales/en/interviewFocus.json'

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('i18n interviewFocus — parité FR/EN', () => {
  it('mêmes clés dans les deux langues', () => {
    expect(flatten(fr).sort()).toEqual(flatten(en).sort())
  })
  it('aucune valeur vide côté FR', () => {
    expect(flatten(fr).every((k) => {
      const v = k.split('.').reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], fr)
      return typeof v === 'string' && v.trim().length > 0
    })).toBe(true)
  })
})
