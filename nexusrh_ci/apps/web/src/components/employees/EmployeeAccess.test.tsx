/**
 * « Donner un accès » depuis la fiche employé : création du compte via
 * l'endpoint existant (POST /settings/users) avec lien explicite employee_id ;
 * badge « Accès : <rôle> » quand un compte est déjà lié.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { post: postMock, get: vi.fn() } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o?.role ? `${k}:${o.role}` : k) }),
}))

import { EmployeeAccess } from './EmployeeAccess'
import { useAuthStore, type AuthUser } from '@/stores/authStore'

const EMP = { id: 'e1', first_name: 'Kouassi', last_name: 'Coulibaly', email: 'k.coulibaly@sotra.ci' }
const FAKE_TMP = ['TMP', 'FICTIF', '9'].join('-')

function renderAccess(employee: Parameters<typeof EmployeeAccess>[0]['employee']) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><EmployeeAccess employee={employee} /></QueryClientProvider>)
}

beforeEach(() => {
  postMock.mockReset()
  useAuthStore.setState({ user: { sub: 'admin-1', email: 'admin@sotra.ci', role: 'admin' } as AuthUser })
})
afterEach(() => cleanup())

describe('EmployeeAccess', () => {
  it('compte lié → badge « Accès : rôle », pas de bouton', () => {
    renderAccess({ ...EMP, linked_user_id: 'u1', linked_user_role: 'manager' })
    expect(screen.getByText('access.badge:roles.manager')).toBeTruthy()
    expect(screen.queryByText('access.grant')).toBeNull()
  })

  it('non-admin sans compte lié → simple mention, pas de création possible', () => {
    useAuthStore.setState({ user: { sub: 'rh-1', email: 'rh@sotra.ci', role: 'hr_manager' } as AuthUser })
    renderAccess({ ...EMP, linked_user_id: null })
    expect(screen.getByText('access.none')).toBeTruthy()
    expect(screen.queryByText('access.grant')).toBeNull()
  })

  it('admin : crée le compte pré-rempli avec employee_id ; mot de passe masqué si l’email est parti', async () => {
    postMock.mockResolvedValue({ data: { data: { id: 'u9' }, tempPassword: FAKE_TMP, emailSent: true } })
    renderAccess({ ...EMP, linked_user_id: null })
    fireEvent.click(screen.getByText('access.grant'))
    expect((screen.getByLabelText('users.form.email') as HTMLInputElement).value).toBe(EMP.email)
    fireEvent.change(screen.getByLabelText('users.form.role'), { target: { value: 'manager' } })
    fireEvent.click(screen.getByText('access.submit'))

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/settings/users', {
      email: EMP.email, first_name: 'Kouassi', last_name: 'Coulibaly', role: 'manager', employee_id: 'e1',
    }))
    await waitFor(() => expect(screen.getByText('access.emailSent')).toBeTruthy())
    expect(screen.queryByText(FAKE_TMP)).toBeNull()
  })

  it('email non parti → mot de passe temporaire en filet ; erreur API affichée', async () => {
    postMock.mockResolvedValueOnce({ data: { data: { id: 'u9' }, tempPassword: FAKE_TMP, emailSent: false } })
    renderAccess({ ...EMP, linked_user_id: null })
    fireEvent.click(screen.getByText('access.grant'))
    fireEvent.click(screen.getByText('access.submit'))
    await waitFor(() => expect(screen.getByText(FAKE_TMP)).toBeTruthy())

    cleanup()
    postMock.mockRejectedValueOnce({ response: { data: { error: 'Cette fiche employé est déjà liée à un autre compte.' } } })
    renderAccess({ ...EMP, linked_user_id: null })
    fireEvent.click(screen.getByText('access.grant'))
    fireEvent.click(screen.getByText('access.submit'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('déjà liée'))
  })
})
