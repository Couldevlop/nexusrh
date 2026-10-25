/**
 * Boîte de confirmation / d'information in-app — remplace window.confirm,
 * window.alert et window.prompt (boîtes natives hors charte, bloquantes pour
 * l'automatisation des tests de recette).
 *
 * Usage impératif, depuis n'importe quel composant ou callback :
 *   if (await confirmDialog({ message: t('x.deleteConfirm'), danger: true })) remove()
 *   void alertDialog({ message: t('error') })
 *
 * Un seul hôte <ConfirmDialogHost /> est monté à la racine de l'application.
 * Accessibilité (Radix AlertDialog) : focus piégé dans la boîte, focus initial
 * sur « Annuler », Échap = annulation, rôle alertdialog + titre/description liés.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'

export interface ConfirmOptions {
  message: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Action destructrice : bouton de confirmation en rouge. */
  danger?: boolean
}

interface PendingDialog extends ConfirmOptions {
  kind: 'confirm' | 'alert'
  resolve: (ok: boolean) => void
}

interface ConfirmStore {
  current: PendingDialog | null
  open: (d: PendingDialog) => void
  close: (ok: boolean) => void
}

const useConfirmStore = create<ConfirmStore>((set, get) => ({
  current: null,
  open: (d) => {
    // Une seule boîte à la fois : une demande précédente non tranchée est annulée.
    get().current?.resolve(false)
    set({ current: d })
  },
  close: (ok) => {
    const cur = get().current
    set({ current: null })
    cur?.resolve(ok)
  },
}))

/** Demande une confirmation — résout `true` si l'utilisateur confirme. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().open({ ...options, kind: 'confirm', resolve })
  })
}

/** Affiche un message d'information (un seul bouton « OK »). */
export function alertDialog(options: Omit<ConfirmOptions, 'danger' | 'cancelLabel'>): Promise<void> {
  return new Promise<void>((resolve) => {
    useConfirmStore.getState().open({ ...options, kind: 'alert', resolve: () => resolve() })
  })
}

export function ConfirmDialogHost() {
  const { t } = useTranslation('common')
  const current = useConfirmStore((s) => s.current)
  const close = useConfirmStore((s) => s.close)
  const isAlert = current?.kind === 'alert'
  const title = current?.title ?? (isAlert ? t('confirmDialog.infoTitle') : t('confirmDialog.title'))

  return (
    <AlertDialog.Root open={current !== null} onOpenChange={(o) => { if (!o) close(false) }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none"
        >
          <AlertDialog.Title className="text-base font-semibold text-foreground">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
            {current?.message ?? ''}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            {!isAlert && (
              <AlertDialog.Cancel
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {current?.cancelLabel ?? t('actions.cancel')}
              </AlertDialog.Cancel>
            )}
            <AlertDialog.Action
              onClick={() => close(true)}
              className={`rounded-md px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                current?.danger
                  ? 'bg-destructive hover:bg-destructive/90 focus-visible:ring-destructive'
                  : 'bg-primary hover:bg-primary/90 focus-visible:ring-primary'
              }`}
            >
              {current?.confirmLabel ?? (isAlert ? t('confirmDialog.ok') : t('actions.confirm'))}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
