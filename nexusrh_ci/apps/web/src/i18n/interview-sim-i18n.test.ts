import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const I18N = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]) => readFileSync(join(I18N, ...p), 'utf8')

const REQUIRED = [
  'voiceUnsupported', 'questionProgress', 'answerPlaceholder',
  'speakButton', 'listening', 'nextButton', 'finishButton', 'feedbackTitle', 'strengths',
  'improvements', 'restart', 'publicTitle',
  'consentAccept', 'linkInvalid', 'submitError', 'loading', 'ephemeralNotice',
]

describe('i18n interviewSim', () => {
  for (const lang of ['fr', 'en']) {
    it(`${lang}: interviewSim.json valide, sans BOM, toutes les clés`, () => {
      const raw = read('locales', lang, 'interviewSim.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const json = JSON.parse(raw) as Record<string, unknown>
      for (const k of REQUIRED) expect(json[k]).toBeDefined()
    })
    it(`${lang}: bouton carrières dans publicPages.json`, () => {
      const pp = JSON.parse(read('locales', lang, 'publicPages.json')) as { interviewSim?: Record<string, unknown> }
      expect(pp.interviewSim?.trainButton).toBeDefined()
      expect(pp.interviewSim?.trainUnavailable).toBeDefined()
    })
  }
  it('index enregistre le namespace interviewSim', () => {
    expect(read('index.ts')).toContain('interviewSim')
  })
})
