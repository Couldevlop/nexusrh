/**
 * Bandeau « Complétez votre fiche employé » : affiché à l'admin connecté dont
 * la fiche liée a un salaire de base 0 (fiche auto-créée à la création du
 * tenant), avec un lien vers sa fiche. Rien dans tous les autres cas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const { getMock, authState } = vi.hoisted(() => ({
  getMock: vi.fn(),
  authState: { user: null as null | { role: string; employeeId: string | null } },
}))
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: typeof authState) => unknown) => sel(authState),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import IncompleteProfileBanner from './IncompleteProfileBanner'

function renderBanner(path = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <IncompleteProfileBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getMock.mockReset()
  authState.user = null
})
afterEach(() => cleanup())

describe('IncompleteProfileBanner', () => {
  it('admin avec fiche à salaire 0 : bandeau + lien vers sa fiche', async () => {
    authState.user = { role: 'admin', employeeId: 'emp-1' }
    getMock.mockResolvedValue({ data: { data: { id: 'emp-1', base_salary: '0' } } })
    renderBanner()
    expect(await screen.findByText('incompleteProfile.message')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'incompleteProfile.cta' })
    expect(link.getAttribute('href')).toBe('/employees/emp-1')
    expect(getMock).toHaveBeenCalledWith('/employees/emp-1')
  })

  it('sur sa propre fiche : message sans lien redondant', async () => {
    authState.user = { role: 'admin', employeeId: 'emp-1' }
    getMock.mockResolvedValue({ data: { data: { id: 'emp-1', base_salary: 0 } } })
    renderBanner('/employees/emp-1')
    expect(await screen.findByText('incompleteProfile.message')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('salaire renseigné : aucun bandeau', async () => {
    authState.user = { role: 'admin', employeeId: 'emp-1' }
    getMock.mockResolvedValue({ data: { data: { id: 'emp-1', base_salary: '450000' } } })
    renderBanner()
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(screen.queryByText('incompleteProfile.message')).toBeNull()
  })

  it('autre rôle ou admin sans fiche liée : aucun appel, aucun bandeau', () => {
    authState.user = { role: 'hr_manager', employeeId: 'emp-2' }
    renderBanner()
    authState.user = { role: 'admin', employeeId: null }
    renderBanner()
    expect(getMock).not.toHaveBeenCalled()
    expect(screen.queryByText('incompleteProfile.message')).toBeNull()
  })

  it('erreur de chargement : non bloquant, aucun bandeau', async () => {
    authState.user = { role: 'admin', employeeId: 'emp-1' }
    getMock.mockRejectedValue(new Error('403'))
    renderBanner()
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(screen.queryByText('incompleteProfile.message')).toBeNull()
  })
})
