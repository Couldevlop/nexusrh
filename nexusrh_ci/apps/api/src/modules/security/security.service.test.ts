import { describe, it, expect } from 'vitest'
import {
  TENANT_ROLES,
  isValidTenantRole,
  SSO_PROVIDERS,
  categorizeAction,
  shouldForward,
  formatEvent,
  type GroupRoleMapping,
  type SecurityEvent,
} from './security.service.js'

describe('security.service — validations bornées (A03)', () => {
  it('rôles tenant (super_admin exclu)', () => {
    expect(isValidTenantRole('admin')).toBe(true)
    expect(isValidTenantRole('super_admin')).toBe(false)
    expect(TENANT_ROLES).toContain('dg')
  })
})

describe('security.service — catégorisation SIEM', () => {
  it('classe les actions d\'audit', () => {
    expect(categorizeAction('auth.login_failed')).toBe('auth')
    expect(categorizeAction('account.lockout')).toBe('auth')
    expect(categorizeAction('classification.sensitive_access')).toBe('data_access')
    expect(categorizeAction('payroll.export')).toBe('export')
    expect(categorizeAction('employee.deleted')).toBe('admin')
    expect(categorizeAction('tenant.modules_updated')).toBe('config')
    expect(categorizeAction('rbac.permission_denied')).toBe('rbac')
  })
  it('filtre selon les catégories activées', () => {
    expect(shouldForward(['auth', 'rbac'], 'auth.login_failed')).toBe(true)
    expect(shouldForward(['auth'], 'tenant.modules_updated')).toBe(false)
  })
})

describe('security.service — formatage', () => {
  const ev: SecurityEvent = {
    id: 'e1', action: 'auth.login_failed', entity: 'user', userId: 'u1',
    ip: '10.0.0.1', at: '2024-12-01T10:00:00.000Z', tenant: 'tenant_sotra',
  }
  it('JSON : objet structuré avec catégorie', () => {
    const parsed = JSON.parse(formatEvent(ev, 'json'))
    expect(parsed).toMatchObject({ id: 'e1', category: 'auth', action: 'auth.login_failed', tenant: 'tenant_sotra' })
  })
  it('CEF : en-tête ArcSight + extensions', () => {
    const line = formatEvent(ev, 'cef')
    expect(line.startsWith('CEF:0|OpenLab|NexusRH CI|1.0|auth.login_failed|auth|')).toBe(true)
    expect(line).toContain('cs1Label=tenant cs1=tenant_sotra')
    expect(line).toContain('src=10.0.0.1')
  })
})
