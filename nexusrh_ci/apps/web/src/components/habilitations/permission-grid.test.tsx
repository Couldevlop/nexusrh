/**
 * Grille d'habilitations — ce que l'écran propose, et ce qu'il interdit.
 *
 * Deux garde-fous que seul ce banc peut tenir : la grille ne propose JAMAIS une
 * case qui n'existe pas côté serveur (sinon l'utilisateur coche un droit que
 * l'API refusera sans rien dire), et une case hors plafond du sous-groupe est
 * visible mais désactivée — l'admin comprend pourquoi elle est inatteignable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }),
}))

import { PermissionGrid } from './PermissionGrid'

afterEach(() => cleanup())

describe('PermissionGrid', () => {
  it('ne propose pas « Payer » sur la ligne Paie, mais le propose sur Paiements', () => {
    render(<PermissionGrid value={[]} onChange={() => {}} />)
    expect(screen.queryByLabelText('payroll:pay')).toBeNull()
    expect(screen.getByLabelText('payments:pay')).toBeTruthy()
  })

  it('ne propose pas « Supprimer » sur la ligne Paie', () => {
    render(<PermissionGrid value={[]} onChange={() => {}} />)
    expect(screen.queryByLabelText('payroll:delete')).toBeNull()
    expect(screen.getByLabelText('employees:delete')).toBeTruthy()
  })

  it('désactive une case hors plafond du sous-groupe', () => {
    render(<PermissionGrid value={[]} onChange={() => {}} ceiling={['employees:view']} />)
    expect((screen.getByLabelText('employees:view') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('employees:create') as HTMLInputElement).disabled).toBe(true)
  })

  it('sans plafond, toutes les cases du catalogue sont actives', () => {
    render(<PermissionGrid value={[]} onChange={() => {}} />)
    expect((screen.getByLabelText('employees:create') as HTMLInputElement).disabled).toBe(false)
  })

  it('coche et décoche en remontant la liste complète', () => {
    const onChange = vi.fn()
    render(<PermissionGrid value={['employees:view']} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('employees:create'))
    expect(onChange).toHaveBeenCalledWith(['employees:view', 'employees:create'])
    fireEvent.click(screen.getByLabelText('employees:view'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('en lecture seule, aucune case n\'est modifiable', () => {
    const onChange = vi.fn()
    render(<PermissionGrid value={['employees:view']} onChange={onChange} readOnly />)
    const box = screen.getByLabelText('employees:view') as HTMLInputElement
    expect(box.disabled).toBe(true)
    fireEvent.click(box)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('propose les droits transverses, dont « données sensibles »', () => {
    render(<PermissionGrid value={[]} onChange={() => {}} />)
    expect(screen.getByLabelText('sensitive_data')).toBeTruthy()
    expect(screen.getByLabelText('all_entities')).toBeTruthy()
    expect(screen.getByLabelText('manage_habilitations')).toBeTruthy()
  })

  it('un droit transverse hors plafond est désactivé lui aussi', () => {
    render(<PermissionGrid value={[]} onChange={() => {}} ceiling={['employees:view']} />)
    expect((screen.getByLabelText('sensitive_data') as HTMLInputElement).disabled).toBe(true)
  })
})
