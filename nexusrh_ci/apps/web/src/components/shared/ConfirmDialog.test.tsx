/**
 * Boîte de confirmation in-app (remplace window.confirm/alert) : accessibilité
 * (rôle alertdialog, focus initial sur Annuler, Échap = annulation), bouton
 * danger, i18n.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ConfirmDialogHost, confirmDialog, alertDialog } from './ConfirmDialog'

afterEach(() => cleanup())

describe('ConfirmDialog', () => {
  it('confirmer résout true ; bouton danger en rouge ; rôle alertdialog', async () => {
    render(<ConfirmDialogHost />)
    let p!: Promise<boolean>
    act(() => { p = confirmDialog({ message: 'Supprimer ce dossier ?', danger: true }) })
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Supprimer ce dossier ?')
    expect(screen.getByText('confirmDialog.title')).toBeTruthy()
    const ok = screen.getByText('actions.confirm')
    expect(ok.className).toContain('bg-destructive')
    fireEvent.click(ok)
    await expect(p).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('focus initial sur « Annuler » et Échap annule (résout false)', async () => {
    render(<ConfirmDialogHost />)
    let p!: Promise<boolean>
    act(() => { p = confirmDialog({ message: 'Continuer ?' }) })
    await screen.findByRole('alertdialog')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('actions.cancel'))
    expect(screen.getByText('actions.confirm').className).toContain('bg-primary')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await expect(p).resolves.toBe(false)
  })

  it('libellés personnalisables ; alertDialog n’a qu’un bouton OK', async () => {
    render(<ConfirmDialogHost />)
    let p!: Promise<void>
    act(() => { p = alertDialog({ message: 'Image trop volumineuse' }) })
    await screen.findByRole('alertdialog')
    expect(screen.queryByText('actions.cancel')).toBeNull()
    expect(screen.getByText('confirmDialog.infoTitle')).toBeTruthy()
    fireEvent.click(screen.getByText('confirmDialog.ok'))
    await expect(p).resolves.toBeUndefined()

    let q!: Promise<boolean>
    act(() => { q = confirmDialog({ message: 'Clôturer ?', title: 'Offre', confirmLabel: 'Clôturer', cancelLabel: 'Garder' }) })
    await screen.findByText('Offre')
    fireEvent.click(screen.getByText('Garder'))
    await expect(q).resolves.toBe(false)
  })
})
