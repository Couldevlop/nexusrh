import { describe, it, expect } from 'vitest'
import {
  MODULE_KEYS,
  MODULE_DEFAULTS,
  moduleKeyForUrl,
  resolveEnabledModules,
} from './tenant-modules.service.js'

describe('module interview_sim — déclaration', () => {
  it('clé canonique présente, opt-in par défaut', () => {
    expect((MODULE_KEYS as readonly string[]).includes('interview_sim')).toBe(true)
    expect(MODULE_DEFAULTS.interview_sim).toBe(false)
  })

  it('mappe les URL internes /interview-sim → interview_sim', () => {
    expect(moduleKeyForUrl('/interview-sim')).toBe('interview_sim')
    expect(moduleKeyForUrl('/interview-sim/internal-jobs/22222222-2222-2222-2222-222222222222/start')).toBe('interview_sim')
    expect(moduleKeyForUrl('/interview-sim/config')).toBe('interview_sim')
  })

  it('les surcharges tenant peuvent activer le module', () => {
    const resolved = resolveEnabledModules({ interview_sim: true })
    expect(resolved.interview_sim).toBe(true)
  })
})
