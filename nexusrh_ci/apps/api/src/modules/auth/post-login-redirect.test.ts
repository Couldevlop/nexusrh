/**
 * Destination après connexion — un salarié habilité travaille en RH.
 */
import { describe, it, expect } from 'vitest'
import { postLoginRedirect } from './post-login-redirect.js'

const ctx = (over: Partial<Parameters<typeof postLoginRedirect>[0]> = {}) =>
  ({ role: 'employee', pwdResetRequired: false, habPermissions: null, ...over })

describe('postLoginRedirect', () => {
  it('un mot de passe à renouveler passe avant tout', () => {
    expect(postLoginRedirect(ctx({ role: 'admin', pwdResetRequired: true }))).toBe('/change-password')
    expect(postLoginRedirect(ctx({ pwdResetRequired: true, habPermissions: ['employees:view'] }))).toBe('/change-password')
  })

  it('un salarié sans habilitation garde son self-service', () => {
    expect(postLoginRedirect(ctx())).toBe('/mon-espace')
  })

  it('un salarié habilité ouvre l\'espace RH', () => {
    expect(postLoginRedirect(ctx({ habPermissions: ['recruitment:view'] }))).toBe('/dashboard')
  })

  it('une affectation inactive (aucun droit) laisse le self-service', () => {
    expect(postLoginRedirect(ctx({ habPermissions: [] }))).toBe('/mon-espace')
  })

  it('les autres rôles sont inchangés', () => {
    expect(postLoginRedirect(ctx({ role: 'dg' }))).toBe('/dg')
    expect(postLoginRedirect(ctx({ role: 'hr_manager' }))).toBe('/dashboard')
    expect(postLoginRedirect(ctx({ role: 'admin' }))).toBe('/dashboard')
  })
})
